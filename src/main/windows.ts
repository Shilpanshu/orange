// Tool windows, settings and the shelf. Tool windows load renderer/tool with the tool id + paths
// in the URL hash (read in the page via `orange.args`).
import { BrowserWindow, nativeTheme, screen, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import { page, distDir, asset } from './paths';
import { TOOLS } from '../shared/catalog';

const open = new Map<string, BrowserWindow>();

// Preferred window sizes per tool (DIP). Editors get more room than small option dialogs.
const SIZES: Record<string, [number, number]> = {
  compress: [520, 560],
  metadata: [720, 640],
  extractArchive: [480, 320],
  createPdf: [760, 620],
  mergePdf: [760, 620],
  splitPdf: [720, 600],
  audioChannels: [720, 520],
  normalizeAudio: [720, 560],
};
const DEFAULT_SIZE: [number, number] = [1080, 760];

function chrome(): Electron.BrowserWindowConstructorOptions {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: dark ? '#1a1816' : '#f6f3ef', symbolColor: dark ? '#f3eee8' : '#1f1b16', height: 40 },
    backgroundColor: dark ? '#1a1816' : '#f6f3ef',
    icon: asset('icon.png'),
    show: false,
    webPreferences: { preload: join(distDir, 'preload.js'), sandbox: false, spellcheck: false },
  };
}

function hashArgs(args: object) {
  return encodeURIComponent(JSON.stringify(args));
}

export function openTool(toolId: string, paths: string[]) {
  const [w, h] = SIZES[toolId] ?? DEFAULT_SIZE;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    ...chrome(),
    width: Math.min(w, wa.width - 40),
    height: Math.min(h, wa.height - 40),
    minWidth: Math.min(w, 460),
    minHeight: Math.min(h, 320),
    x: Math.round(wa.x + (wa.width - Math.min(w, wa.width - 40)) / 2),
    y: Math.round(wa.y + (wa.height - Math.min(h, wa.height - 40)) / 2),
    title: TOOLS.find((t) => t.id === toolId)?.label ?? 'Orange',
  });
  win.loadFile(page('tool'), { hash: hashArgs({ tool: toolId, paths }) });
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  const key = `tool:${toolId}:${win.id}`;
  open.set(key, win);
  win.on('closed', () => open.delete(key));
  return win;
}

export function openSettings(tab?: string) {
  const existing = open.get('settings');
  if (existing && !existing.isDestroyed()) {
    if (tab) existing.webContents.send('settings:tab', tab);
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({ ...chrome(), width: 760, height: 620, minWidth: 620, minHeight: 480, title: 'Orange' });
  win.loadFile(page('settings'), { hash: hashArgs({ tab: tab ?? 'general' }) });
  win.once('ready-to-show', () => win.show());
  open.set('settings', win);
  win.on('closed', () => open.delete('settings'));
  return win;
}

// Shared dialogs the renderer pages can call.
ipcMain.handle('dialog:folder', async (e, title?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const r = await dialog.showOpenDialog(win!, { title: title ?? 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:files', async (e, filters?: Electron.FileFilter[], multi = true) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  const r = await dialog.showOpenDialog(win!, { filters, properties: multi ? ['openFile', 'multiSelections'] : ['openFile'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle('theme:dark', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => {
  const dark = nativeTheme.shouldUseDarkColors;
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setTitleBarOverlay?.({ color: dark ? '#1a1816' : '#f6f3ef', symbolColor: dark ? '#f3eee8' : '#1f1b16' });
    } catch {
      /* windows without an overlay */
    }
  }
});
