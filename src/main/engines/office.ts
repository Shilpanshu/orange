// Office engine: drives Microsoft Office (Word / PowerPoint / Excel over COM, from a hidden
// PowerShell host) when it is installed, otherwise LibreOffice headless. Office gives the best
// fidelity for its own formats and Word's PDF reflow is the best PDF→DOCX on Windows; LibreOffice
// covers everything else, including Apple Pages / Numbers / Keynote.
import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './run';
import { log } from '../log';
import { UserError } from '../ops/types';

const SYS = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = join(SYS, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const REG = join(SYS, 'System32', 'reg.exe');

export type OfficeApp = 'word' | 'powerpoint' | 'excel';

export interface OfficeStatus {
  word: boolean;
  powerpoint: boolean;
  excel: boolean;
  /** Full path to soffice.exe, or null when LibreOffice is not installed. */
  libreoffice: string | null;
}

// ------------------------------------------------------------------- detection

const PROGID: Record<OfficeApp, string> = {
  word: 'Word.Application',
  powerpoint: 'PowerPoint.Application',
  excel: 'Excel.Application',
};

/** A registry string value, or null. Missing keys are normal here, so failures stay quiet. */
function regDefault(key: string, value?: string): Promise<string | null> {
  const args = ['query', key, ...(value ? ['/v', value] : ['/ve'])];
  return new Promise((resolve) => {
    execFile(REG, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(String(stdout));
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** Registered and the server executable actually exists (uninstalls can leave stale keys). */
async function hasComServer(progId: string): Promise<boolean> {
  const clsid = await regDefault(`HKCR\\${progId}\\CLSID`);
  if (!clsid) return false;
  const server = await regDefault(`HKCR\\CLSID\\${clsid}\\LocalServer32`);
  if (!server) return false;
  const m = /^"([^"]+)"|^(\S+\.exe)/i.exec(server.trim());
  const exe = m ? m[1] ?? m[2] : server;
  return existsSync(exe);
}

async function findSoffice(): Promise<string | null> {
  const candidates: string[] = [];
  for (const key of [
    'HKLM\\SOFTWARE\\LibreOffice\\UNO\\InstallPath',
    'HKLM\\SOFTWARE\\WOW6432Node\\LibreOffice\\UNO\\InstallPath',
    'HKCU\\SOFTWARE\\LibreOffice\\UNO\\InstallPath',
  ]) {
    const dir = await regDefault(key);
    if (dir) candidates.push(join(dir, 'soffice.exe'));
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(join(base, 'LibreOffice', 'program', 'soffice.exe'));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

let statusCache: { at: number; value: Promise<OfficeStatus> } | null = null;

/** What office suites are available. Cached for a minute; cheap enough for the settings page. */
export function officeStatus(): Promise<OfficeStatus> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const value = (async () => {
    const [word, powerpoint, excel, libreoffice] = await Promise.all([
      hasComServer(PROGID.word),
      hasComServer(PROGID.powerpoint),
      hasComServer(PROGID.excel),
      findSoffice(),
    ]);
    const blocked = readBlocked();
    return { word: word && !blocked.word, powerpoint: powerpoint && !blocked.powerpoint, excel: excel && !blocked.excel, libreoffice };
  })();
  statusCache = { at: Date.now(), value };
  value.catch(() => (statusCache = null));
  return value;
}

export function resetOfficeStatus() {
  statusCache = null;
}

/** No usable office suite for this job. Callers with a built-in fallback catch this one. */
export class OfficeUnavailableError extends UserError {}

/** Thrown when a conversion needs an office suite and none is installed. */
export function needOfficeError(what: string): OfficeUnavailableError {
  return new OfficeUnavailableError(
    `${what} needs Microsoft Office or LibreOffice. Install the free LibreOffice from Orange's Settings (or libreoffice.org) and try again.`,
  );
}

// An Office app that pops a modal dialog under automation (typically the activation wizard of an
// unlicensed copy) can't be used. Remember that for a few days so it never flashes up again.
const BLOCK_DAYS = 3;

function blockedFile(): string | null {
  try {
    return join(app.getPath('userData'), 'office-blocked.json');
  } catch {
    return null;
  }
}

type BlockKey = OfficeApp | 'wordPdf';

function readBlocked(): Partial<Record<BlockKey, boolean>> {
  const f = blockedFile();
  if (!f || !existsSync(f)) return {};
  try {
    const data = JSON.parse(readFileSync(f, 'utf8')) as Record<string, number>;
    const out: Partial<Record<BlockKey, boolean>> = {};
    for (const k of ['word', 'powerpoint', 'excel', 'wordPdf'] as BlockKey[]) {
      const days = k === 'wordPdf' ? 1 : BLOCK_DAYS;
      out[k] = !!data[k] && Date.now() - data[k] < days * 86_400_000;
    }
    return out;
  } catch {
    return {};
  }
}

function markBlocked(which: BlockKey) {
  const f = blockedFile();
  if (!f) return;
  try {
    let data: Record<string, number> = {};
    if (existsSync(f)) data = JSON.parse(readFileSync(f, 'utf8'));
    data[which] = Date.now();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(data));
  } catch (e) {
    log('could not record blocked office app', e);
  }
  resetOfficeStatus();
}

/** Forget remembered Office problems (e.g. after the user activates Office). */
export function clearOfficeBlocks() {
  const f = blockedFile();
  if (f && existsSync(f)) rmSync(f, { force: true });
  resetOfficeStatus();
}

// ---------------------------------------------------------------- serialising

// Office automation and a LibreOffice profile can only do one thing at a time.
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// ------------------------------------------------------- Microsoft Office (COM)

const PS_PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Say([string]$s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
$M = [Type]::Missing
$global:OfficePid = 0
$global:HelpersBefore = @(Get-Process -Name 'PDFREF*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
function Stop-NewHelpers {
  Get-Process -Name 'PDFREF*' -ErrorAction SilentlyContinue | Where-Object { $global:HelpersBefore -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
}
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class OrangeWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w, EnumProc p, IntPtr l);
  public static string VisibleTitle(uint pid) {
    string found = null;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.Length == 0) return true;
      var text = new StringBuilder();
      EnumChildWindows(h, (c, l2) => {
        var cls = new StringBuilder(64); GetClassName(c, cls, 64);
        if (cls.ToString() == "Static" || cls.ToString() == "MSOUNISTAT") {
          var t = new StringBuilder(512); GetWindowText(c, t, 512);
          if (t.Length > 0) text.Append(' ').Append(t.ToString());
        }
        return text.Length < 300;
      }, IntPtr.Zero);
      found = sb.ToString() + " ::" + text.ToString(); return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
# A hidden automation instance never shows a window of its own. A visible one is a modal dialog
# (activation wizard, sign-in, repair prompt) that blocks every call: a watchdog thread kills Office
# the moment one appears, so it never sits on the user's screen.
# It also reports helper processes Office launches through COM (Word's PDFREFLOW), which are not its
# children, so they can be cleaned up too.
function Start-Watchdog([int]$procId) {
  $ps = [powershell]::Create()
  [void]$ps.AddScript({
    param($procId, $helpersBefore)
    $seen = 0
    $known = @{}
    $windowCpu = -1.0
    $windowStart = Get-Date
    while ($true) {
      Start-Sleep -Milliseconds 250
      $op = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if (-not $op) { break }
      $cpu = [double]$op.TotalProcessorTime.TotalSeconds
      foreach ($hp in @(Get-Process -Name 'PDFREF*' -ErrorAction SilentlyContinue)) {
        if ($helpersBefore -notcontains $hp.Id) {
          if (-not $known[$hp.Id]) { $known[$hp.Id] = 1; [Console]::Out.WriteLine('PID ' + $hp.Id); [Console]::Out.Flush() }
          $cpu += [double]$hp.TotalProcessorTime.TotalSeconds
        }
      }
      # Working Office burns CPU. Next to none over 30 s means it waits for something that won't come.
      if ($windowCpu -lt 0) { $windowCpu = $cpu }
      if (((Get-Date) - $windowStart).TotalSeconds -ge 30) {
        if ($cpu - $windowCpu -lt 0.3) {
          Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
          [Console]::Out.WriteLine('STALLED'); [Console]::Out.Flush()
          break
        }
        $windowCpu = $cpu
        $windowStart = Get-Date
      }
      $t = [OrangeWin]::VisibleTitle([uint32]$procId)
      # Office's own progress windows ("Publishing...", "Saving...") are fine.
      if ($t -and ($t -split ' ::')[0] -match 'publish|saving|export|printing|progress|converting|opening|loading') { $t = $null }
      if ($t) { $seen++ } else { $seen = 0 }
      if ($seen -ge 2) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        [Console]::Out.WriteLine('BLOCKED ' + $t); [Console]::Out.Flush()
        break
      }
    }
  }).AddArgument($procId).AddArgument($global:HelpersBefore)
  [void]$ps.BeginInvoke()
}
function Start-Office([string]$progId, [string]$procName) {
  # If an earlier run crashed or was killed while opening this very file, Office asks "the last time
  # you opened X it caused a serious error, open it anyway?" on its next start. Office turns the
  # in-flight markers in Resiliency\StartupItems into Resiliency\DisabledItems entries when it starts,
  # so: drop the markers (only while this app isn't running) and forget disabled entries naming
  # this file. The user's other disabled items (add-ins, other documents) are left alone.
  $appKey = @{ WINWORD = 'Word'; EXCEL = 'Excel'; POWERPNT = 'PowerPoint' }[$procName]
  $running = @(Get-Process -Name $procName -ErrorAction SilentlyContinue).Count -gt 0
  $needle = $src.ToLowerInvariant()
  try { $needle = (Get-Item -LiteralPath $src).FullName.ToLowerInvariant() } catch {}
  Get-ChildItem 'HKCU:\Software\Microsoft\Office' -ErrorAction SilentlyContinue | ForEach-Object {
    $startup = Join-Path $_.PSPath "$appKey\Resiliency\StartupItems"
    if (-not $running -and (Test-Path $startup)) { Remove-Item $startup -Recurse -Force -ErrorAction SilentlyContinue }
    foreach ($sub in @('DisabledItems')) {
      $k = Join-Path $_.PSPath "$appKey\Resiliency\$sub"
      if (-not (Test-Path $k)) { continue }
      $item = Get-Item $k
      foreach ($name in $item.GetValueNames()) {
        $v = $item.GetValue($name)
        if ($v -is [byte[]]) {
          $text = [Text.Encoding]::Unicode.GetString($v).ToLowerInvariant()
          if ($text.Contains($needle) -or $text.Contains($src.ToLowerInvariant())) { Remove-ItemProperty -Path $k -Name $name -ErrorAction SilentlyContinue }
        }
      }
    }
  }
  $before = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $o = New-Object -ComObject $progId
  $mine = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  foreach ($id in $mine) { Say "PID $id" }
  if ($mine.Count -gt 0) { $global:OfficePid = $mine[0]; Start-Watchdog $mine[0] }
  return @{ App = $o; Shared = ($before.Count -gt 0 -and $mine.Count -eq 0) }
}
# Office rejects calls while it is busy (RPC_E_CALL_REJECTED / RETRYLATER / Excel's VBA_E_IGNORE); retry for up to 30 s.
function Try-Com([scriptblock]$__block) {
  # Names are prefixed: the block runs in a child scope and must still see the caller's $i, $e, ...
  for ($__try = 0; ; $__try++) {
    try { return (& $__block) } catch {
      $__e = $_.Exception; while ($__e.InnerException) { $__e = $__e.InnerException }
      $__busy = $__e.HResult -eq -2147418111 -or $__e.HResult -eq -2147417846 -or $__e.HResult -eq -2146777998
      $__alive = (-not $global:OfficePid) -or (Get-Process -Id $global:OfficePid -ErrorAction SilentlyContinue)
      if ($__busy -and $__alive -and $__try -lt 120) { Start-Sleep -Milliseconds 250; continue }
      throw
    }
  }
}
function Release($o) { if ($o) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($o) } catch {} } }
$src = $env:ORANGE_IN
$dst = $env:ORANGE_OUT
$fmt = $env:ORANGE_FMT
`;

const PS_WORD = String.raw`
$h = Start-Office 'Word.Application' 'WINWORD'
$app = $h.App
$doc = $null
try {
  $app.Visible = $false
  $app.DisplayAlerts = 0
  try { $app.ScreenUpdating = $false } catch {}
  try { $app.AutomationSecurity = 3 } catch {}
  try { $app.Options.ConfirmConversions = $false } catch {}
  try { $app.Options.DoNotPromptForConvert = $true } catch {}
  Say 'STAGE open'
  # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate,
  # Revert, WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible, OpenAndRepair,
  # DocumentDirection, NoEncodingDialog. A dummy password (Word allows at most 15 chars) makes protected files fail instead of prompting.
  $doc = Try-Com { $app.Documents.Open($src, $false, $true, $false, '0range-nopw', '0range-nopw', $false, '0range-nopw', '0range-nopw', 0, $M, $false, $false, $M, $true) }
  Say 'STAGE save'
  if ($fmt -eq 'pdf') {
    # OutputFileName, ExportFormat=PDF, OpenAfterExport, OptimizeFor=Print, Range=All, From, To,
    # Item=DocumentContent, IncludeDocProps, KeepIRM, CreateBookmarks=HeadingBookmarks, DocStructureTags
    Try-Com { $doc.ExportAsFixedFormat($dst, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true) }
  } else {
    $code = @{ docx = 16; doc = 0; odt = 23; rtf = 6; txt = 7; html = 10 }[$fmt]
    if ($null -eq $code) { throw "Word cannot save $fmt" }
    Try-Com { $doc.SaveAs2($dst, $code) }
  }
  Say 'STAGE done'
} finally {
  if ($doc) { try { Try-Com { $doc.Close(0) } } catch {} ; Release $doc }
  # Quit takes [ref] arguments from PowerShell; no-arg Quit is fine once every document is closed.
  if (-not $h.Shared) { try { Try-Com { $app.Quit() } } catch {} }
  Release $app
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($global:OfficePid -and -not $h.Shared) { Wait-Process -Id $global:OfficePid -Timeout 20 -ErrorAction SilentlyContinue }
  Stop-NewHelpers
}
`;

const PS_POWERPOINT = String.raw`
$h = Start-Office 'PowerPoint.Application' 'POWERPNT'
$app = $h.App
$pres = $null
try {
  try { $app.DisplayAlerts = 1 } catch {}
  try { $app.AutomationSecurity = 3 } catch {}
  Say 'STAGE open'
  # FileName, ReadOnly, Untitled, WithWindow (no window = never visible)
  $pres = Try-Com { $app.Presentations.Open($src, -1, 0, 0) }
  if ($fmt -eq 'pdf') {
    Try-Com { $pres.SaveAs($dst, 32) }
  } elseif ($fmt -eq 'pptx') {
    Try-Com { $pres.SaveAs($dst, 24) }
  } elseif ($fmt -eq 'png' -or $fmt -eq 'jpg') {
    $n = $pres.Slides.Count
    $w = [int][Math]::Round($pres.PageSetup.SlideWidth * 3)
    $hh = [int][Math]::Round($pres.PageSetup.SlideHeight * 3)
    $filter = if ($fmt -eq 'png') { 'PNG' } else { 'JPG' }
    $pad = ([string]$n).Length
    for ($i = 1; $i -le $n; $i++) {
      $name = 'Slide ' + ([string]$i).PadLeft($pad, '0') + '.' + $fmt
      Try-Com { $pres.Slides.Item($i).Export((Join-Path $dst $name), $filter, $w, $hh) }
      Say "SLIDE $i $n"
    }
  } else { throw "PowerPoint cannot save $fmt" }
  Say 'STAGE done'
} finally {
  if ($pres) { try { $pres.Close() } catch {} ; Release $pres }
  if (-not $h.Shared) { try { if ($app.Presentations.Count -eq 0) { $app.Quit() } } catch {} }
  Release $app
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($global:OfficePid -and -not $h.Shared) { Wait-Process -Id $global:OfficePid -Timeout 20 -ErrorAction SilentlyContinue }
}
`;

const PS_EXCEL = String.raw`
$h = Start-Office 'Excel.Application' 'EXCEL'
$app = $h.App
$wb = $null
try {
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $app.ScreenUpdating = $false
  try { $app.AskToUpdateLinks = $false } catch {}
  try { $app.EnableEvents = $false } catch {}
  try { $app.AutomationSecurity = 3 } catch {}
  Say 'STAGE open'
  # FileName, UpdateLinks, ReadOnly, Format, Password, WriteResPassword, IgnoreReadOnlyRecommended
  $wb = Try-Com { $app.Workbooks.Open($src, 0, $true, $M, '0range-nopw', '0range-nopw', $true) }
  Say 'STAGE save'
  if ($fmt -eq 'pdf') {
    foreach ($ws in $wb.Worksheets) {
      try {
        $cols = $ws.UsedRange.Columns.Count
        $app.PrintCommunication = $false
        $ws.PageSetup.Zoom = $false
        $ws.PageSetup.FitToPagesWide = 1
        $ws.PageSetup.FitToPagesTall = $false
        if ($cols -gt 8) { $ws.PageSetup.Orientation = 2 }
        $app.PrintCommunication = $true
      } catch { try { $app.PrintCommunication = $true } catch {} }
    }
    # Type=PDF, Filename, Quality=Standard, IncludeDocProperties, IgnorePrintAreas=False
    Try-Com { $wb.ExportAsFixedFormat(0, $dst, 0, $true, $false) }
  } else {
    $code = @{ xlsx = 51; ods = 60; xls = 56; csv = 62 }[$fmt]
    if ($null -eq $code) { throw "Excel cannot save $fmt" }
    Try-Com { $wb.SaveAs($dst, $code) }
  }
  Say 'STAGE done'
} finally {
  if ($wb) { try { Try-Com { $wb.Close($false) } } catch {} ; Release $wb }
  if (-not $h.Shared) { try { Try-Com { $app.Quit() } } catch {} }
  Release $app
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($global:OfficePid -and -not $h.Shared) { Wait-Process -Id $global:OfficePid -Timeout 20 -ErrorAction SilentlyContinue }
}
`;

const SCRIPTS: Record<OfficeApp, string> = { word: PS_WORD, powerpoint: PS_POWERPOINT, excel: PS_EXCEL };

// Word's PDF import runs in a separate helper (PDFREFLOW) that can wedge for good on some systems.
// After it stalls once, skip it for a day and use the other PDF routes.
export function wordPdfReflowUsable(): boolean {
  return !readBlocked().wordPdf;
}

export interface OfficeRunOptions {
  signal?: AbortSignal;
  /** Called with 0..1 as Office reports stages / slides. */
  onProgress?: (f: number) => void;
  /** Give up (and kill Office) after this long. */
  timeoutMs?: number;
}

// Office processes this module started and hasn't seen exit yet; killed if Orange itself exits.
const livePids = new Set<number>();
process.on('exit', () => livePids.forEach((pid) => killPid(pid)));

function killPid(pid: number) {
  livePids.delete(pid);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Convert with Microsoft Office. `output` is a file path, or a folder for slide images.
 * Runs PowerShell hidden; Office never shows a window and is always quit (or killed) afterwards.
 */
export function officeConvert(which: OfficeApp, input: string, output: string, format: string, opts: OfficeRunOptions = {}): Promise<void> {
  return exclusive(
    () =>
      new Promise<void>((resolve, reject) => {
        if (opts.signal?.aborted) return reject(new Error('Cancelled'));
        // Errors go to stdout as one "ERROR …" line (PowerShell 5 would otherwise emit CLIXML on stderr).
        const script = `${PS_PRELUDE}
try {
${SCRIPTS[which]}
} catch { Say ('ERROR ' + ($_.Exception.Message -replace '\\s+', ' ') + ' @@ ' + ($_.InvocationInfo.Line -replace '\\s+', ' ').Trim()); exit 1 }
`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
          windowsHide: true,
          env: { ...process.env, ORANGE_IN: input, ORANGE_OUT: output, ORANGE_FMT: format },
        });
        const officePids: number[] = [];
        let timedOut = false;
        let errorLine = '';
        let blockedBy = '';
        let stalled = false;
        let stderr = '';
        let buf = '';
        let finished = false;
        const progress = (f: number) => opts.onProgress?.(Math.max(0, Math.min(1, f)));
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? '';
          for (const line of lines) {
            let m: RegExpExecArray | null;
            if ((m = /^PID (\d+)/.exec(line))) {
              officePids.push(Number(m[1]));
              livePids.add(Number(m[1]));
            }
            else if ((m = /^ERROR (.*)/.exec(line))) errorLine = m[1].trim();
            else if ((m = /^BLOCKED (.*)/.exec(line))) blockedBy = m[1].trim();
            else if (/^STALLED/.test(line)) stalled = true;
            else if ((m = /^SLIDE (\d+) (\d+)/.exec(line))) progress(0.1 + (0.85 * Number(m[1])) / Number(m[2]));
            else if (/^STAGE open/.test(line)) progress(0.1);
            else if (/^STAGE save/.test(line)) progress(0.4);
            else if (/^STAGE done/.test(line)) progress(0.95);
          }
        });
        child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-16_000)));

        const killAll = () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          officePids.forEach(killPid);
        };
        const onAbort = () => killAll();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => {
          if (finished) return;
          log(`office ${which} timed out`, input);
          timedOut = true;
          killAll();
        }, opts.timeoutMs ?? 5 * 60_000);

        const done = (err?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          // Belt and braces: Office we started must not outlive the job. Give a clean Quit a moment first.
          // Killing Office while it is still shutting down makes it flag the document as crashing, so give a
          // clean Quit plenty of time; a killed or failed run is cleaned up at once.
          if (err && officePids.length) {
            officePids.forEach(killPid);
            forgetCrashMarkers(which);
          }
          else if (officePids.length) setTimeout(() => officePids.forEach(killPid), 30_000).unref?.();
          if (err) reject(err);
          else resolve();
        };
        child.on('error', (e) => done(e));
        child.on('close', (code) => {
          if (opts.signal?.aborted) return done(new Error('Cancelled'));
          if (timedOut) {
            if (which === 'word' && /\.pdf$/i.test(input)) markBlocked('wordPdf');
            return done(new UserError(`${appName(which)} took too long and was stopped.`));
          }
          if (code === 0) return done();
          log(`office ${which} failed (${code})`, input, `pids=${officePids.join(',')}`, blockedBy ? `blocked by "${blockedBy}"` : '', errorLine || stderr);
          if (stalled) {
            if (/\.pdf$/i.test(input)) markBlocked('wordPdf');
            return done(new UserError(`${appName(which)} stopped responding and was closed.`));
          }
          if (blockedBy) {
            const [title, text = ''] = blockedBy.split(' ::');
            // Activation / licensing / sign-in prompts come back every time: stop using this app for a while.
            if (/activat|licen|product key|sign in|subscription|unlicensed/i.test(blockedBy)) {
              markBlocked(which);
              return done(
                new OfficeUnavailableError(
                  `Microsoft ${appName(which)} isn't activated, so Orange can't use it. Activate Office, or install the free LibreOffice from Orange's Settings.`,
                ),
              );
            }
            return done(new UserError(`${appName(which)} stopped with a message: ${(text.trim() || title).slice(0, 160)}`));
          }
          done(new Error(officeMessage(which, errorLine || stderr)));
        });
      }),
  );
}

/**
 * A killed Office leaves "document was being opened" markers that make its next start (including
 * the user's own) complain about that document. Clear them once the process is gone.
 */
function forgetCrashMarkers(which: OfficeApp) {
  const proc = { word: 'WINWORD', powerpoint: 'POWERPNT', excel: 'EXCEL' }[which];
  const key = appName(which);
  const ps = `Start-Sleep -Seconds 2; if (-not (Get-Process -Name ${proc} -ErrorAction SilentlyContinue)) { Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office' -ErrorAction SilentlyContinue | ForEach-Object { $k = Join-Path $_.PSPath '${key}\\Resiliency\\StartupItems'; if (Test-Path $k) { Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue } } }`;
  try {
    spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch {
    /* best effort */
  }
}

function appName(which: OfficeApp) {
  return { word: 'Word', powerpoint: 'PowerPoint', excel: 'Excel' }[which];
}

function officeMessage(which: OfficeApp, detail: string): string {
  const s = detail.replace(/ @@ .*$/, '').replace(/_x000D__x000A_/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/password/i.test(s)) return 'The file is password-protected.';
  if (/corrupt|damaged|cannot open|could not open|unreadable|file format|not a valid/i.test(s)) return `${appName(which)} couldn't open the file. It may be damaged.`;
  if (s && s.length < 200 && !/CLIXML|Exception from HRESULT/.test(s)) return `${appName(which)}: ${s.replace(/\.$/, '')}.`;
  return `${appName(which)} couldn't convert the file.`;
}

// ------------------------------------------------------------- LibreOffice

function profileDir(): string {
  let base: string;
  try {
    base = app.getPath('userData');
  } catch {
    base = join(tmpdir(), 'orange');
  }
  const dir = join(base, 'libreoffice-profile');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface LibreOfficeOptions {
  signal?: AbortSignal;
  /** Import filter, e.g. "writer_pdf_import" to open a PDF in Writer. */
  infilter?: string;
  timeoutMs?: number;
}

/**
 * Convert with LibreOffice headless. `filter` is a --convert-to spec such as
 * 'docx:"MS Word 2007 XML"' or 'pdf'. Writes to `output` exactly.
 */
export async function libreConvert(input: string, output: string, filter: string, opts: LibreOfficeOptions = {}): Promise<void> {
  const soffice = (await officeStatus()).libreoffice;
  if (!soffice) throw needOfficeError('This conversion');
  return exclusive(async () => {
    const work = mkdtempSync(join(tmpdir(), 'orange-lo-'));
    try {
      // Give LibreOffice a plain ASCII name to work on; it chokes on some exotic paths.
      const ext = extname(input);
      const staged = join(work, `input${ext}`);
      copyFileSync(input, staged);
      const outDir = join(work, 'out');
      mkdirSync(outDir);
      const args = [
        `-env:UserInstallation=${pathToFileURL(profileDir()).href}`,
        '--headless',
        '--invisible',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--nolockcheck',
        '--nofirststartwizard',
      ];
      if (opts.infilter) args.push(`--infilter=${opts.infilter}`);
      args.push('--convert-to', filter, '--outdir', outDir, staged);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10 * 60_000);
      try {
        await run(soffice, args, { signal: ac.signal, cwd: work });
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (ac.signal.aborted) throw new UserError('LibreOffice took too long and was stopped.');
        throw e;
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
      const produced = readdirSync(outDir).map((f) => join(outDir, f)).filter((f) => statSync(f).isFile());
      if (!produced.length) throw new UserError("LibreOffice couldn't convert this file.");
      moveFile(produced[0], output);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

/** rename(), falling back to copy+delete across drives. */
export function moveFile(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    try {
      unlinkSync(from);
    } catch {
      /* temp files are cleaned up anyway */
    }
  }
}

// ------------------------------------------------------------ installation

const WINGET_ID = 'TheDocumentFoundation.LibreOffice';

/** winget's App Execution Alias is a reparse point that fs.existsSync can't see, so just try it. */
function wingetPath(): string {
  return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'winget.exe');
}

/**
 * Installs LibreOffice: winget first (silent, no admin prompt for most setups), else the official
 * MSI from download.documentfoundation.org (Windows asks for administrator permission).
 * Resolves once soffice.exe is found. `onProgress` receives short status lines for the UI.
 */
export async function installLibreOffice(onProgress?: (note: string) => void): Promise<void> {
  if ((await officeStatus()).libreoffice) return;
  let wingetError: unknown = null;
  onProgress?.('Installing LibreOffice with winget…');
  try {
    await run(
      wingetPath(),
      ['install', '--id', WINGET_ID, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
      // "Already installed" and "no applicable upgrade" are fine too (winget exit codes, either sign).
      { okCodes: [0x8a15002b, 0x8a150061, 0x8a15002b - 0x100000000, 0x8a150061 - 0x100000000] },
    );
  } catch (e) {
    wingetError = e;
    log('winget install failed', e);
  }
  resetOfficeStatus();
  if ((await officeStatus()).libreoffice) return;

  const msi = await downloadLibreOfficeMsi((f) => onProgress?.(`Downloading LibreOffice… ${Math.round(f * 100)}%`));
  try {
    onProgress?.('Installing LibreOffice…');
    // Start-Process -Verb RunAs shows the UAC prompt; -Wait blocks until msiexec finishes.
    const ps = `$p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', '"${msi.replace(/["']/g, '')}"', '/passive', '/norestart') -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
    await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { okCodes: [3010] });
  } catch (e: any) {
    log('msi install failed', e);
    if (/cancel/i.test(String(e?.message))) throw new UserError('LibreOffice installation was cancelled.');
    throw new UserError(`Couldn't install LibreOffice${wingetError ? ' (winget failed too)' : ''}. Download it from libreoffice.org instead.`);
  } finally {
    rmSync(dirname(msi), { recursive: true, force: true });
  }
  resetOfficeStatus();
  if (!(await officeStatus()).libreoffice) throw new UserError('LibreOffice installation did not finish. Try again, or install it from libreoffice.org.');
}

async function downloadLibreOfficeMsi(onProgress: (f: number) => void): Promise<string> {
  const base = 'https://download.documentfoundation.org/libreoffice/stable/';
  let index: string;
  try {
    index = await (await fetch(base, { signal: AbortSignal.timeout(30_000) })).text();
  } catch {
    throw new UserError("Couldn't reach libreoffice.org. Check the internet connection and try again.");
  }
  const versions = [...index.matchAll(/href="(\d+\.\d+\.\d+)\/"/g)].map((m) => m[1]);
  if (!versions.length) throw new UserError("Couldn't find a LibreOffice download. Get it from libreoffice.org.");
  versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
  const v = versions[0];
  const url = `${base}${v}/win/x86_64/LibreOffice_${v}_Win_x86-64.msi`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok || !res.body) throw new UserError(`Couldn't download LibreOffice (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const dir = mkdtempSync(join(tmpdir(), 'orange-lo-msi-'));
  const file = join(dir, basename(new URL(url).pathname));
  // Stream to disk (the MSI is ~350 MB).
  const out = createWriteStream(file);
  let got = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total && Date.now() - lastReport > 250) {
        lastReport = Date.now();
        onProgress(got / total);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(dir, { recursive: true, force: true });
    throw new UserError("LibreOffice's download was interrupted. Try again.");
  }
  if (total && got < total) {
    rmSync(dir, { recursive: true, force: true });
    throw new UserError("LibreOffice's download was incomplete. Try again.");
  }
  return file;
}
