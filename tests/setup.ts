// Imported first by run.ts, before any app module: settings.ts and others read app.getPath('userData')
// at import time, so the private profile must be in place before they load.
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const RUN_DIR = process.env.ORANGE_TEST_RUN_DIR || join(tmpdir(), 'orange-tests', `run-${Date.now()}`);
export const USER_DATA = process.env.ORANGE_USER_DATA || join(RUN_DIR, 'userdata');
export const REPO = process.env.ORANGE_REPO || process.cwd();

mkdirSync(USER_DATA, { recursive: true });
app.setPath('userData', USER_DATA);
app.setAppLogsPath(join(USER_DATA, 'logs'));
app.disableHardwareAcceleration(); // hidden print windows only; keeps GPU-process noise out
process.setSourceMapsEnabled?.(true);

/**
 * Microsoft Office must never show a window during tests. Orange skips Office apps listed in
 * <userData>/office-blocked.json (that is how it remembers an unactivated copy), so the private profile
 * starts with them blocked. Excel is always blocked (unactivated on the dev PC: it shows the activation
 * wizard). ORANGE_TEST_OFFICE=1 lets Word and PowerPoint run over Orange's hidden COM route.
 */
export const OFFICE_ALLOWED = process.env.ORANGE_TEST_OFFICE === '1';
const now = Date.now();
writeFileSync(join(USER_DATA, 'office-blocked.json'), JSON.stringify(OFFICE_ALLOWED ? { excel: now } : { word: now, powerpoint: now, excel: now }));
