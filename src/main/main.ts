import { app, Tray, Menu, ipcMain, nativeImage, globalShortcut, BrowserWindow, nativeTheme, shell } from 'electron';
import { DragWatcher } from './drag-watcher';
import { Wheel, registerWheelIpc } from './wheel';
import type { WheelPrefs } from '../shared/catalog';
import { settings, type ModKey } from './settings';
import { asset } from './paths';
import type { WheelKind } from '../shared/catalog';
import { runChoice } from './jobs';
import { openSettings } from './windows';
import { explorerSelection, startHelper } from './helper';
import { log } from './log';
import { hud } from './hud';
import { registerFileIpc } from './ipc-files';
import { shelf } from './shelf';
import { officeStatus, installLibreOffice } from './engines/office';
import { binDir } from './paths';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startCrashCapture, reportProblem } from './diagnostics';
import { startUpdater, updateState, check as checkForUpdates, installNow } from './updater';
import './presets'; // registers the presets:* IPC
import { registerContextMenu, handleArgv } from './context-menu';
import { startWatching, stopWatching } from './watch';
import { registerClipboardHotkey, unregisterClipboardHotkey, openClipboardPopover } from './clipboard';

if (process.env.ORANGE_USER_DATA) app.setPath('userData', process.env.ORANGE_USER_DATA); // separate profile for test runs
if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId('app.orange.converter');
startCrashCapture();

let tray: Tray | null = null;
const watcher = new DragWatcher();
const wheel = new Wheel();

const KEY_LABEL: Record<ModKey, string> = { shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', none: '' };

function wheelForMod(mod: ModKey): WheelKind | null {
  const k = settings.get().keys;
  if (k.convert === mod) return 'convert';
  if (k.tools === mod) return 'tools';
  if (k.actions === mod) return 'actions';
  return null;
}

/** Explorer's right-click menu (and other launchers) open the wheel in click mode. */
function openWheelFor(w: WheelKind, paths: string[]) {
  if (!paths.length) return;
  watcher.listeningNav = false;
  wheel.open({ wheel: w, mode: 'click', paths, prefs: wheelPrefs() });
}

/** Only the installed app owns the Explorer menu, so a dev run never repoints it. */
function syncContextMenu() {
  if (app.isPackaged) registerContextMenu(settings.get().contextMenu).catch((e) => log('context menu', e));
}

/** What the wheel needs to order and decorate slices: pins, last choices, saved presets. */
function wheelPrefs(): WheelPrefs {
  const s = settings.get();
  return {
    favorites: s.favorites,
    recents: s.recents,
    presets: s.presets.map((p) => ({ id: p.id, name: p.name, tool: p.tool, kinds: p.kinds })),
  };
}

function trayMenu(): Menu {
  const up = updateState();
  const updateItem: Electron.MenuItemConstructorOptions =
    up.status === 'ready'
      ? { label: `Restart to update to ${up.version}`, click: () => installNow() }
      : up.status === 'downloading'
        ? { label: `Downloading update… ${Math.round(up.percent ?? 0)}%`, enabled: false }
        : { label: 'Check for updates', click: () => checkForUpdates(true) };
  return Menu.buildFromTemplate([
    { label: `Orange ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Show shelf', click: () => shelf.add([]) },
    { label: 'Convert clipboard…', click: () => openClipboardPopover() },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'How to use', click: () => openSettings('welcome') },
    { type: 'separator' },
    updateItem,
    { label: 'Report a problem…', click: () => reportProblem().catch((e) => log('report failed', e)) },
    { type: 'separator' },
    { label: 'Quit Orange', role: 'quit' },
  ]);
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.setToolTip('Orange: drag a file, then tap Shift');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => openSettings());
}

// Only this shortcut is unregistered on change; the clipboard shortcut manages its own.
let selectionHotkey = '';
function applyHotkey() {
  if (selectionHotkey) globalShortcut.unregister(selectionHotkey);
  const hk = (selectionHotkey = settings.get().selectionHotkey);
  if (!hk) return;
  try {
    globalShortcut.register(hk, async () => {
      const paths = await explorerSelection();
      if (!paths.length) return;
      watcher.listeningNav = false;
      wheel.open({ wheel: 'convert', mode: 'click', paths, prefs: wheelPrefs() });
    });
  } catch (e) {
    log('hotkey register failed', e);
  }
}

app.whenReady().then(() => {
  settings.load();
  nativeTheme.themeSource = settings.get().theme;
  app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin && app.isPackaged });

  wheel.create();
  hud.register();
  registerFileIpc();
  buildTray();
  startHelper();
  // The first Shell COM call costs ~120 ms; pay it now so the first wheel of the day is exact.
  explorerSelection().catch(() => {});
  applyHotkey();

  // Read the Explorer selection as soon as a drag starts (the source window is still in front),
  // so the wheel can show options for the exact files instead of guessing from MIME types.
  let dragSelection: Promise<string[]> = Promise.resolve([]);
  watcher.on('dragstart', () => {
    dragSelection = explorerSelection();
  });
  watcher.on('modifier', (mod: ModKey) => {
    const w = wheelForMod(mod);
    log('modifier during drag', mod, w);
    if (!w) return;
    watcher.listeningNav = true;
    wheel.open({ wheel: w, mode: 'drag', prefs: wheelPrefs() });
    dragSelection.then((paths) => {
      if (paths.length && wheel.isOpen) wheel.setPaths(paths);
    });
  });
  watcher.on('release', () => {
    watcher.listeningNav = false;
    wheel.releaseSoon();
  });
  watcher.on('nav', (key: string) => {
    if (key === 'escape') {
      watcher.listeningNav = false;
      wheel.close();
      return;
    }
    wheel.nav(key);
  });
  watcher.start();
  startWatching();
  syncContextMenu();
  registerClipboardHotkey((paths) => openWheelFor('convert', paths));
  // Launched from the Explorer menu: open the wheel once the wheel page has loaded.
  const launchArgv = process.argv;
  if (wheel.win.webContents.isLoading()) wheel.win.webContents.once('did-finish-load', () => handleArgv(launchArgv, openWheelFor));
  else handleArgv(launchArgv, openWheelFor);
  log('Orange started');

  registerWheelIpc(wheel, (itemId, paths) => {
    watcher.listeningNav = false;
    runChoice(itemId, paths).catch((e) => log('job failed', e));
  });

  ipcMain.handle('settings:keyNames', () => {
    const k = settings.get().keys;
    return { convert: KEY_LABEL[k.convert], tools: KEY_LABEL[k.tools], actions: KEY_LABEL[k.actions] };
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:report', () => reportProblem());
  ipcMain.handle('app:checkUpdates', () => checkForUpdates(true));
  ipcMain.handle('app:updateState', () => updateState());
  startUpdater(() => tray?.setContextMenu(trayMenu()));
  ipcMain.handle('engines:status', async () => {
    const st = await officeStatus();
    const has = (p: string) => existsSync(join(binDir, p));
    return {
      ...st,
      bundled: {
        'FFmpeg (video and audio)': has('ffmpeg.exe'),
        'ImageMagick (images)': has('imagemagick/magick.exe'),
        'Pandoc (documents)': has('pandoc.exe'),
        'Ghostscript (PDF)': has('gs/bin/gswin64c.exe'),
        '7-Zip (archives)': has('7z.exe'),
      },
    };
  });
  ipcMain.handle('engines:installLibreOffice', () => installLibreOffice());
  ipcMain.handle('app:openLogs', () => shell.openPath(app.getPath('logs')));
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    settings.set(patch);
    if (patch && 'contextMenu' in patch) syncContextMenu();
    nativeTheme.themeSource = settings.get().theme;
    app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin && app.isPackaged });
    applyHotkey();
    return settings.get();
  });

  if (!settings.get().onboarded) openSettings('welcome');
});

// A second launch is either the Explorer menu (paths in argv) or the user opening Orange again.
app.on('second-instance', (_e, argv) => {
  if (!handleArgv(argv, openWheelFor)) openSettings();
});
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher.stop();
  stopWatching();
  unregisterClipboardHotkey();
});

export { BrowserWindow };
