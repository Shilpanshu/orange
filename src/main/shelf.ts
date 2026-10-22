// The shelf: a small always-on-top window pinned to a screen edge that holds files until you drag
// them somewhere else. Items stay until removed or the shelf is closed.
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, shell, type NativeImage } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { asset, distDir, page } from './paths';
import { settings } from './settings';
import { log } from './log';

export interface ShelfItem {
  path: string;
  name: string;
  size: number;
  dir: boolean;
  missing?: boolean;
}

const WIDTH = 252;
const TAB_W = 34;
const TAB_H = 132;

class Shelf {
  private win: BrowserWindow | null = null;
  private items: ShelfItem[] = [];
  private collapsed = false;
  private contentHeight = 220;
  private thumbs = new Map<string, Promise<string>>();
  private registered = false;
  private loaded = false;

  add(paths: string[]) {
    this.register();
    const have = new Set(this.items.map((i) => i.path.toLowerCase()));
    for (const raw of paths) {
      if (!raw) continue;
      const p = resolve(raw); // Windows shell APIs want backslashes
      if (have.has(p.toLowerCase()) || !existsSync(p)) continue;
      have.add(p.toLowerCase());
      this.items.push(itemFor(p));
    }
    const win = this.ensure();
    if (this.collapsed) this.setCollapsed(false);
    this.push();
    if (!win.isVisible()) {
      this.place();
      win.showInactive();
    } else this.place();
  }

  private ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: WIDTH,
      height: 240,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#23201d' : '#fffdfa',
      title: 'Orange shelf',
      icon: asset('icon.png'),
      webPreferences: { preload: join(distDir, 'preload.js'), sandbox: false, spellcheck: false },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    this.win.loadFile(page('shelf'), { hash: encodeURIComponent(JSON.stringify({ edge: this.edge() })) });
    this.win.webContents.once('did-finish-load', () => {
      this.loaded = true;
      this.push();
    });
    this.loaded = false;
    this.win.on('closed', () => {
      this.win = null;
      this.items = [];
      this.collapsed = false;
      this.thumbs.clear();
    });
    return this.win;
  }

  private edge(): 'left' | 'right' {
    return settings.get().shelfEdge === 'left' ? 'left' : 'right';
  }

  private place() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const cur = win.getBounds();
    const display = win.isVisible() ? screen.getDisplayMatching(cur) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    const w = this.collapsed ? TAB_W : WIDTH;
    const h = this.collapsed ? TAB_H : Math.round(Math.min(Math.max(this.contentHeight, 180), wa.height * 0.8));
    const x = this.edge() === 'left' ? wa.x + 8 : wa.x + wa.width - w - 8;
    // Once shown, keep the vertical position (the user may have dragged it); start centred.
    const y = win.isVisible() ? Math.min(Math.max(cur.y, wa.y + 8), wa.y + wa.height - h - 8) : wa.y + Math.round((wa.height - h) / 2);
    win.setBounds({ x, y, width: w, height: h });
  }

  private setCollapsed(v: boolean) {
    this.collapsed = v;
    this.win?.webContents.send('shelf:collapsed', v);
    this.place();
  }

  private push() {
    const win = this.win;
    if (!win || win.isDestroyed() || !this.loaded) return;
    for (const it of this.items) it.missing = !existsSync(it.path);
    win.webContents.send('shelf:items', this.items, this.collapsed);
  }

  remove(paths: string[]) {
    const drop = new Set(paths.map((p) => p.toLowerCase()));
    this.items = this.items.filter((i) => !drop.has(i.path.toLowerCase()));
    this.push();
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }

  private thumb(p: string): Promise<string> {
    let t = this.thumbs.get(p);
    if (!t) {
      t = (async () => {
        try {
          const img = await nativeImage.createThumbnailFromPath(p, { width: 96, height: 96 });
          if (!img.isEmpty()) return img.toDataURL();
        } catch {
          /* no thumbnail handler for this type: use its icon */
        }
        // Folders look better with the window's own folder glyph than the shell's generic icon.
        if (statSync(p).isDirectory()) return '';
        const icon = await app.getFileIcon(p, { size: 'large' });
        return icon.isEmpty() ? '' : icon.toDataURL();
      })();
      this.thumbs.set(p, t);
    }
    return t;
  }

  private async dragIcon(paths: string[]): Promise<NativeImage> {
    try {
      const url = await this.thumb(paths[0]);
      const img = url ? nativeImage.createFromDataURL(url) : nativeImage.createEmpty();
      if (!img.isEmpty()) return img.resize({ width: 48 });
    } catch {
      /* fall through */
    }
    return nativeImage.createFromPath(asset('icon.png')).resize({ width: 48 });
  }

  register() {
    if (this.registered) return;
    this.registered = true;
    ipcMain.handle('shelf:thumb', (_e, p: string) => this.thumb(p));
    ipcMain.on('shelf:add', (_e, paths: string[]) => this.add(paths));
    ipcMain.on('shelf:remove', (_e, paths: string[]) => this.remove(paths));
    ipcMain.on('shelf:clear', () => this.close());
    ipcMain.on('shelf:collapse', (_e, v: boolean) => this.setCollapsed(v));
    ipcMain.on('shelf:height', (_e, h: number) => {
      if (!Number.isFinite(h)) return;
      this.contentHeight = Math.round(h);
      if (!this.collapsed) this.place();
    });
    // Only what is on the shelf: opening is launching, so the page can't be used to run anything else.
    ipcMain.on('shelf:open', (_e, p: string) => {
      if (typeof p === 'string' && this.items.some((i) => i.path.toLowerCase() === p.toLowerCase())) void shell.openPath(p);
    });
    ipcMain.on('shelf:reveal', (_e, p: string) => shell.showItemInFolder(p));
    // Dragging items out: must start from the renderer's dragstart, synchronously.
    ipcMain.on('shelf:drag', async (e, paths: string[]) => {
      const files = paths.filter((p) => existsSync(p));
      if (!files.length) return;
      try {
        // A cached thumbnail keeps this effectively synchronous after the first render.
        const icon = await this.dragIcon(files);
        e.sender.startDrag({ file: files[0], files, icon });
      } catch (err) {
        log('shelf drag failed', err);
      }
    });
    settings.on('change', () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('shelf:edge', this.edge());
        this.place();
      }
    });
  }
}

function itemFor(p: string): ShelfItem {
  try {
    const st = statSync(p);
    return { path: p, name: basename(p) || p, size: st.isDirectory() ? 0 : st.size, dir: st.isDirectory() };
  } catch {
    return { path: p, name: basename(p) || p, size: 0, dir: false, missing: true };
  }
}

export const shelf = new Shelf();
