// Bottom-right progress panel. One window, many job rows.
import { BrowserWindow, screen, ipcMain, shell } from 'electron';
import { join, basename } from 'node:path';
import { page, distDir } from './paths';
import { settings } from './settings';
import { releaseWhenHidden } from './windows';

const W = 360;

interface Row {
  id: number;
  title: string;
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'notice';
  progress: number;
  note?: string;
  outputs?: string[];
  errors?: string[];
  undoable?: boolean;
}

class Hud {
  private win: BrowserWindow | null = null;
  private rows = new Map<number, Row>();
  private cancels = new Map<number, () => void>();
  private seq = 0;
  private timers = new Map<number, NodeJS.Timeout>();
  private lastSend = 0;
  private pendingSend?: NodeJS.Timeout;
  private height = 80;
  /** A chime asked for while the page was still loading; played once it has loaded. */
  private chimePending = false;

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
    this.win.webContents.once('did-finish-load', () => {
      this.flush(true);
      if (this.chimePending) this.chime();
    });
    // Between jobs the panel is closed rather than kept hidden, freeing its renderer; the next job
    // opens it again, as the first job after launch does.
    releaseWhenHidden(this.win);
    return this.win;
  }

  private chime() {
    const win = this.win;
    this.chimePending = !win || win.isDestroyed() || win.webContents.isLoading();
    if (!this.chimePending) win!.webContents.send('hud:chime');
  }

  private place(height: number) {
    this.height = height;
    // Only the panel itself reports its height; a report arriving after it closed needs no panel.
    const win = this.win;
    if (!win || win.isDestroyed()) return;
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
    const rows = [...this.rows.values()];
    if (!rows.length) {
      // Nothing to show: hide the panel, without opening one just to hide it.
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const win = this.ensure();
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
        this.remove(id);
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
      /**
       * Mark the job finished. By default Undo moves `outputs` to the Recycle Bin; tools that
       * change files in place (e.g. Rename) pass their own `undo` instead.
       */
      done: (outputs: string[], errors: string[] = [], undo?: (() => Promise<void>) | null) => {
        // null = this job changed files in place and can't be undone safely: no button.
        const fn = undo === null ? null : (undo ?? (outputs.length ? () => this.trash(outputs) : null));
        if (fn) this.undos.set(id, fn);
        this.undoKinds.set(id, undo ? 'custom' : 'trash');
        if (settings.get().sounds && outputs.length) this.chime();
        this.finish(id, { state: 'done', progress: 1, outputs, errors, note: undefined, undoable: !!fn }, errors.length ? 12000 : 8000);
      },
      failed: (msg: string) => this.finish(id, { state: 'failed', note: msg }, 12000),
      cancelled: () => this.finish(id, { state: 'cancelled', note: 'Cancelled' }, 1800),
    };
  }

  /** Forgets a row and everything kept for it (its Undo holds the output list). */
  private remove(id: number) {
    this.rows.delete(id);
    this.undos.delete(id);
    this.undoKinds.delete(id);
    this.cancels.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  notice(msg: string) {
    const id = ++this.seq;
    this.rows.set(id, { id, title: msg, state: 'notice', progress: 0 });
    this.finish(id, {}, 4000);
  }

  private undos = new Map<number, () => Promise<void>>();
  private undoKinds = new Map<number, 'trash' | 'custom'>();

  private async trash(paths: string[]) {
    for (const p of paths) await shell.trashItem(p).catch(() => {});
  }

  register() {
    ipcMain.on('hud:undo', async (_e, id: number) => {
      const undo = this.undos.get(id);
      const r = this.rows.get(id);
      if (!undo || !r) return;
      this.undos.delete(id);
      try {
        await undo();
        const n = r.outputs?.length ?? 0;
        const title =
          this.undoKinds.get(id) === 'trash' && n
            ? `Undone: ${n === 1 ? 'the new file was' : `${n} new files were`} moved to the Recycle Bin`
            : 'Undone';
        this.finish(id, { state: 'notice', title, undoable: false }, 3500);
      } catch (e: any) {
        this.finish(id, { state: 'failed', note: `Couldn't undo: ${e?.message ?? e}`, undoable: false }, 8000);
      }
    });
    ipcMain.on('hud:height', (_e, h: number) => this.place(h));
    ipcMain.on('hud:cancel', (_e, id: number) => this.cancels.get(id)?.());
    ipcMain.on('hud:dismiss', (_e, id: number) => {
      this.remove(id);
      this.flush(true);
    });
    ipcMain.on('hud:reveal', (_e, p: string) => shell.showItemInFolder(p));
    // Only files a job made: opening is launching, so the panel can't be used to run anything else.
    ipcMain.on('hud:open', (_e, p: string) => {
      if ([...this.rows.values()].some((r) => r.outputs?.includes(p))) void shell.openPath(p);
    });
    // A monitor was unplugged or rearranged: bring a visible panel back on screen.
    const replace = () => {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.place(this.height);
    };
    screen.on('display-removed', replace);
    screen.on('display-metrics-changed', replace);
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
