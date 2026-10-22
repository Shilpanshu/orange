// Electron main-process entry for the regression suite (bundled and launched by tests/run-tests.mjs).
// Calls Orange's converters and tools directly with a real Ctx from makeCtx(); no UI, no visible windows.
import { RUN_DIR, USER_DATA, OFFICE_ALLOWED } from './setup'; // must stay the first import
import { app } from 'electron';
import { existsSync, mkdirSync, symlinkSync, writeFileSync, copyFileSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import { execFileSync } from 'node:child_process';
import { settings } from '../src/main/settings';
import { hud } from '../src/main/hud';
import { officeStatus, OfficeUnavailableError, type OfficeStatus } from '../src/main/engines/office';
import { generateFixtures } from './fixtures';
import { conversionCases, toolCases, makeT, Skip, type Case } from './cases';
import { toolCases as toolRegressionCases } from './cases-tools';
import { convCases } from './cases-conv';

const AI = process.env.ORANGE_TEST_AI === '1';
const FILTER = (process.env.ORANGE_TEST_FILTER ?? '').toLowerCase();
const JOBS = Math.max(1, Number(process.env.ORANGE_TEST_JOBS) || Math.min(4, Math.max(1, Math.floor(cpus().length / 2))));
const DEFAULT_TIMEOUT = 180_000;

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result {
  group: string;
  name: string;
  status: Status;
  ms: number;
  message?: string;
}

// src/main/log.ts echoes every log line (multi-line stacks included) to stdout when unpackaged. They are
// already in <userData>/logs/orange.log, so keep them out of the results table.
const ISO_LOG = /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /;
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: any, ...rest: any[]) => (typeof chunk === 'string' && ISO_LOG.test(chunk) ? true : stdoutWrite(chunk, ...rest))) as typeof process.stdout.write;

// Nothing in the suite may show UI: HUD notices (e.g. from rename undo) become no-ops.
hud.notice = () => {};
// Hidden print-to-PDF windows open and close during the run; that must not quit the app.
app.on('window-all-closed', () => {});

function pad(s: string, n: number) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const xml = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!);

async function runCase(c: Case, index: number): Promise<Result> {
  const dir = join(RUN_DIR, 'out', `${String(index).padStart(3, '0')}-${c.name.replace(/[^\w.+-]+/g, '_').slice(0, 60)}`);
  mkdirSync(dir, { recursive: true });
  const ac = new AbortController();
  const limit = c.timeoutMs ?? DEFAULT_TIMEOUT;
  let timer: NodeJS.Timeout | undefined;
  const t0 = Date.now();
  try {
    await Promise.race([
      c.run(makeT(dir, ac.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error(`timed out after ${limit / 1000} s`));
        }, limit);
      }),
    ]);
    return { group: c.group, name: c.name, status: 'PASS', ms: Date.now() - t0 };
  } catch (e: any) {
    const ms = Date.now() - t0;
    if (e instanceof Skip) return { group: c.group, name: c.name, status: 'SKIP', ms, message: e.message };
    if (e instanceof OfficeUnavailableError) return { group: c.group, name: c.name, status: 'SKIP', ms, message: `office suite unavailable: ${e.message}` };
    const msg = String(e?.message ?? e).replace(/\s+/g, ' ').trim();
    const where = e?.name === 'Error' || e?.name === 'CheckError' || e?.name === 'UserError' ? '' : `${e?.name}: `;
    return { group: c.group, name: c.name, status: 'FAIL', ms, message: where + msg.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

/** Which Office apps are registered at all (officeStatus() already hides the ones the suite keeps off). */
function officeInstalled(): string[] {
  const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return (['Word', 'PowerPoint', 'Excel'] as const).filter((app) => {
    try {
      execFileSync(reg, ['query', `HKCR\\${app}.Application\\CLSID`], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  });
}

/** With ORANGE_TEST_AI=1, share the installed Orange's model cache instead of downloading again. */
function linkModelCache() {
  const real = process.env.ORANGE_TEST_MODELS || join(app.getPath('appData'), 'orange', 'models');
  const mine = join(USER_DATA, 'models');
  if (!existsSync(real) || existsSync(mine)) return null;
  try {
    symlinkSync(real, mine, 'junction');
    return real;
  } catch {
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  settings.load(); // defaults (fresh private profile): results beside the input, then redirected per case
  const office: OfficeStatus = await officeStatus().catch(() => ({ word: false, powerpoint: false, excel: false, libreoffice: null }));
  const models = AI ? linkModelCache() : null;
  const installed = officeInstalled();
  const usable = (['word', 'powerpoint', 'excel'] as const).filter((k) => office[k]);

  console.log(
    `Office installed: ${installed.join(', ') || 'none'}; used by the suite: ${usable.join(', ') || 'none'}` +
      `${OFFICE_ALLOWED ? ' (Excel always kept off)' : ' (kept off; ORANGE_TEST_OFFICE=1 allows Word/PowerPoint)'}; LibreOffice ${office.libreoffice ? 'yes' : 'no'}` +
      ` | AI tools ${AI ? `on${models ? ` (models: ${models})` : ''}` : 'off (ORANGE_TEST_AI=1)'} | ${JOBS} parallel`,
  );

  const fixtures = await generateFixtures(join(RUN_DIR, 'fixtures'));
  console.log(`Fixtures: ${fixtures.made} generated in ${fixtures.ms} ms${fixtures.failed.length ? `, ${fixtures.failed.length} failed:` : ''}`);
  for (const f of fixtures.failed) console.log(`  ! ${f}`);

  let cases = [...conversionCases(office), ...toolCases({ ai: AI }), ...toolRegressionCases({ ai: AI }), ...convCases];
  if (FILTER) cases = cases.filter((c) => `${c.group} ${c.name}`.toLowerCase().includes(FILTER));
  console.log(`Running ${cases.length} cases\n`);

  const results: Result[] = new Array(cases.length);
  let next = 0;
  const width = Math.min(58, Math.max(...cases.map((c) => c.name.length)) + 2);
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const r = await runCase(cases[i], i);
      results[i] = r;
      const ms = `${r.ms} ms`.padStart(9);
      console.log(`${pad(r.status, 5)} ${pad(r.group, 8)} ${pad(r.name, width)}${ms}${r.status === 'PASS' ? '' : `  ${r.message}`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, cases.length) }, worker));

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const total = Date.now() - t0;
  const summary = { pass: count('PASS'), fail: count('FAIL'), skip: count('SKIP'), total: results.length, ms: total };

  // ---------------------------------------------------------------- reports
  const report = {
    startedAt: new Date(t0).toISOString(),
    durationMs: total,
    summary,
    environment: { office, officeInstalled: installed, officeAllowed: OFFICE_ALLOWED, ai: AI, jobs: JOBS, electron: process.versions.electron, node: process.versions.node, runDir: RUN_DIR },
    fixtures: { generated: fixtures.made, failed: fixtures.failed, ms: fixtures.ms },
    cases: results,
  };
  const jsonPath = join(RUN_DIR, 'report.json');
  const junitPath = join(RUN_DIR, 'junit.xml');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const suites = [...new Set(results.map((r) => r.group))].map((g) => {
    const rs = results.filter((r) => r.group === g);
    const body = rs
      .map((r) => {
        const inner = r.status === 'FAIL' ? `<failure message="${xml(r.message ?? '')}"/>` : r.status === 'SKIP' ? `<skipped message="${xml(r.message ?? '')}"/>` : '';
        return `    <testcase classname="orange.${g}" name="${xml(r.name)}" time="${(r.ms / 1000).toFixed(3)}">${inner}</testcase>`;
      })
      .join('\n');
    const t = rs.reduce((a, r) => a + r.ms, 0) / 1000;
    return `  <testsuite name="orange.${g}" tests="${rs.length}" failures="${rs.filter((r) => r.status === 'FAIL').length}" skipped="${rs.filter((r) => r.status === 'SKIP').length}" time="${t.toFixed(3)}">\n${body}\n  </testsuite>`;
  });
  writeFileSync(junitPath, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="orange" tests="${summary.total}" failures="${summary.fail}" skipped="${summary.skip}" time="${(total / 1000).toFixed(3)}">\n${suites.join('\n')}\n</testsuites>\n`);
  const copyTo = process.env.ORANGE_TEST_REPORT_DIR;
  if (copyTo) {
    mkdirSync(copyTo, { recursive: true });
    copyFileSync(jsonPath, join(copyTo, 'report.json'));
    copyFileSync(junitPath, join(copyTo, 'junit.xml'));
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped of ${summary.total} in ${(total / 1000).toFixed(1)} s`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const r of failed) console.log(`  ${r.group} ${r.name}: ${r.message}`);
  }
  console.log(`\nReport: ${jsonPath}\nJUnit:  ${junitPath}\nApp log: ${join(USER_DATA, 'logs', 'orange.log')}\nOutputs: ${join(RUN_DIR, 'out')}`);

  // The model junction points into the real Orange profile; never leave it for a later recursive delete.
  if (models) {
    try {
      if (lstatSync(join(USER_DATA, 'models')).isSymbolicLink()) unlinkSync(join(USER_DATA, 'models'));
    } catch {
      /* gone */
    }
  }
  return failed.length || fixtures.failed.length ? 1 : 0;
}

// Last-resort watchdog so CI never hangs on a wedged child process.
const watchdog = setTimeout(() => {
  console.error('Suite watchdog: still running after 25 minutes, giving up.');
  app.exit(3);
}, 25 * 60_000);
watchdog.unref();

app.whenReady()
  .then(main)
  .then(
    (code) => app.exit(code),
    (e) => {
      console.error('Suite crashed:', e?.stack ?? e);
      app.exit(4);
    },
  );
