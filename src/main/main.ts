import { app, Tray, Menu, ipcMain, nativeImage, globalShortcut, BrowserWindow, nativeTheme, shell } from 'electron';
import { DragWatcher } from './drag-watcher';
import { Wheel, registerWheelIpc } from './wheel';
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

if (!app.requestSingleInstanceLock()) app.exit(0);
app.setAppUserModelId('app.orange.converter');

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

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.setToolTip('Orange: drag a file, then tap Shift');
  const menu = Menu.buildFromTemplate([
    { label: 'Orange is running', enabled: false },
    { type: 'separator' },
    { label: 'Show shelf', click: () => shelf.add([]) },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'How to use', click: () => openSettings('welcome') },
    { type: 'separator' },
    { label: 'Quit Orange', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => openSettings());
}

function applyHotkey() {
  globalShortcut.unregisterAll();
  const hk = settings.get().selectionHotkey;
  if (!hk) return;
  try {
    globalShortcut.register(hk, async () => {
      const paths = await explorerSelection();
      if (!paths.length) return;
      watcher.listeningNav = false;
      wheel.open({ wheel: 'convert', mode: 'click', paths });
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
  applyHotkey();

  watcher.on('modifier', (mod: ModKey) => {
    const w = wheelForMod(mod);
    log('modifier during drag', mod, w);
    if (!w) return;
    watcher.listeningNav = true;
    wheel.open({ wheel: w, mode: 'drag' });
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
    nativeTheme.themeSource = settings.get().theme;
    app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin && app.isPackaged });
    applyHotkey();
    return settings.get();
  });

  if (!settings.get().onboarded) openSettings('welcome');
});

app.on('second-instance', () => openSettings());
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher.stop();
});

export { BrowserWindow };
