// Generated from src/main/engines/office.ts (1.x): the PowerShell that drives Office over COM.

pub const PS_PRELUDE: &str = r#"
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
"#;

pub const PS_WORD: &str = r#"
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
"#;

pub const PS_POWERPOINT: &str = r#"
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
"#;

pub const PS_EXCEL: &str = r#"
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
"#;
