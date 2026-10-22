// Auto-update from GitHub Releases (electron-updater + the NSIS installer).
// Checks shortly after launch and every few hours, downloads in the background, and installs
// on quit. Users can also restart right away from the tray.
import { app } from 'electron';
import type { AppUpdater } from 'electron-updater';
import { hud } from './hud';
import { log } from './log';

const FIRST_CHECK_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateState = { status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; version?: string; percent?: number };

let state: UpdateState = { status: 'idle' };
let onChange: (s: UpdateState) => void = () => {};
let manual = false;

function set(next: UpdateState) {
  state = next;
  onChange(state);
}

export function updateState() {
  return state;
}

export function startUpdater(listener: (s: UpdateState) => void) {
  onChange = listener;
  // Updates only make sense for an installed build.
  if (!app.isPackaged) return;
  setTimeout(() => check(false), FIRST_CHECK_MS);
  setInterval(() => check(false), INTERVAL_MS);
}

let updater: AppUpdater | null = null;

/** electron-updater is loaded on the first check (30 s after launch), not at startup. */
function autoUpdater(): AppUpdater {
  if (updater) return updater;
  const u: AppUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
  updater = u;

  u.logger = { info: (m: unknown) => log('[update]', String(m)), warn: (m: unknown) => log('[update]', String(m)), error: (m: unknown) => log('[update]', String(m)), debug: () => {} } as any;
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;

  u.on('checking-for-update', () => set({ status: 'checking' }));
  u.on('update-not-available', () => {
    set({ status: 'idle' });
    if (manual) hud.notice(`Orange ${app.getVersion()} is up to date.`);
    manual = false;
  });
  u.on('update-available', (info) => {
    set({ status: 'downloading', version: info.version, percent: 0 });
    if (manual) hud.notice(`Downloading Orange ${info.version}…`);
  });
  u.on('download-progress', (p) => set({ ...state, status: 'downloading', percent: p.percent }));
  u.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version });
    hud.notice(`Orange ${info.version} is ready. It installs when you quit, or choose Restart to update in the tray.`);
    manual = false;
  });
  u.on('error', (e) => {
    log('update error', e);
    set({ status: 'error' });
    if (manual) hud.notice("Couldn't check for updates. Check your connection and try again.");
    manual = false;
  });
  return u;
}

export function check(fromUser = true) {
  if (!app.isPackaged) {
    if (fromUser) hud.notice('Updates are only available in the installed app.');
    return;
  }
  // Ready: it installs on quit. Restarting is the tray's explicit "Restart to update", never a side
  // effect of "Check for updates" (Settings has that button), which would kill running jobs.
  if (state.status === 'ready') {
    if (fromUser) hud.notice(`Orange ${state.version} is ready. It installs when you quit, or choose Restart to update in the tray.`);
    return;
  }
  if (state.status === 'checking' || state.status === 'downloading') return;
  manual = fromUser;
  autoUpdater().checkForUpdates().catch((e) => log('update check failed', e));
}

export function installNow() {
  // isSilent=true keeps the installer UI hidden; isForceRunAfter=true relaunches Orange.
  autoUpdater().quitAndInstall(true, true);
}
