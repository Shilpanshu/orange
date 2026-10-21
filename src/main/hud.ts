// Bottom-right progress panel. One window, many job rows.
import { BrowserWindow, screen, ipcMain, shell } from 'electron';
import { join, basename } from 'node:path';
import { page, distDir } from './paths';

const W = 360;

interface Row {
  id: number;
  title: string;
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'notice';
  progress: number;
  note?: string;
  outputs?: string[];
  errors?: string[];
}

class Hud {
  private win: BrowserWindow | null = null;
  private rows = new Map<number, Row>();
  private cancels = new Map<number, () => void>();
  private seq = 0;
  private timers = new Map<number, NodeJS.Timeout>();
  private lastSend = 0;
  private pendingSend?: NodeJS.Timeout;

  private ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: W,
      height: 80,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: join(distDir, 'preload.js'), sandbox: false },
    });
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.loadFile(page('hud'));
    this.win.webContents.once('did-finish-load', () => this.flush(true));
    return this.win;
  }

  private place(height: number) {
    const win = this.ensure();
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const h = Math.min(Math.max(height, 40), 520);
    win.setBounds({ x: wa.x + wa.width - W - 12, y: wa.y + wa.height - h - 12, width: W, height: h });
  }

  private flush(force = false) {
    // Progress can fire hundreds of times a second; cap UI updates at ~30fps.
    const now = Date.now();
    if (!force && now - this.lastSend < 33) {
      if (!this.pendingSend) this.pendingSend = setTimeout(() => ((this.pendingSend = undefined), this.flush(true)), 33);
      return;
    }
    this.lastSend = now;
    const win = this.ensure();
    const rows = [...this.rows.values()];
    if (!rows.length) {
      win.hide();
      return;
    }
    if (!win.webContents.isLoading()) win.webContents.send('hud:rows', rows);
    if (!win.isVisible()) win.showInactive();
  }

  private finish(id: number, patch: Partial<Row>, linger: number) {
    const r = this.rows.get(id);
    if (!r) return;
    Object.assign(r, patch);
    this.cancels.delete(id);
    this.flush(true);
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => {
        this.rows.delete(id);
        this.flush(true);
      }, linger),
    );
  }

  start(title: string, _count: number, onCancel: () => void) {
    const id = ++this.seq;
    this.rows.set(id, { id, title, state: 'running', progress: 0 });
    this.cancels.set(id, onCancel);
    this.flush(true);
    return {
      progress: (f?: number, note?: string) => {
        const r = this.rows.get(id);
        if (!r) return;
        if (f !== undefined) r.progress = f;
        if (note !== undefined) r.note = note;
        this.flush();
      },
      done: (outputs: string[], errors: string[] = []) =>
        this.finish(id, { state: 'done', progress: 1, outputs, errors, note: undefined }, errors.length ? 12000 : 6000),
      failed: (msg: string) => this.finish(id, { state: 'failed', note: msg }, 12000),
      cancelled: () => this.finish(id, { state: 'cancelled', note: 'Cancelled' }, 1800),
    };
  }

  notice(msg: string) {
    const id = ++this.seq;
    this.rows.set(id, { id, title: msg, state: 'notice', progress: 0 });
    this.finish(id, {}, 4000);
  }

  register() {
    ipcMain.on('hud:height', (_e, h: number) => this.place(h));
    ipcMain.on('hud:cancel', (_e, id: number) => this.cancels.get(id)?.());
    ipcMain.on('hud:dismiss', (_e, id: number) => {
      this.rows.delete(id);
      this.flush(true);
    });
    ipcMain.on('hud:reveal', (_e, p: string) => shell.showItemInFolder(p));
    ipcMain.on('hud:open', (_e, p: string) => shell.openPath(p));
    // Let the user hover to keep a finished row around.
    ipcMain.on('hud:hold', (_e, id: number, hold: boolean) => {
      const r = this.rows.get(id);
      if (!r || r.state === 'running') return;
      clearTimeout(this.timers.get(id));
      if (!hold) this.finish(id, {}, 2500);
    });
  }
}

export const hud = new Hud();
export const fileLabel = (p: string) => basename(p);
