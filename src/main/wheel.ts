// The radial menu window. One transparent, always-on-top window is created at startup and
// re-positioned under the cursor on demand, so opening it costs a single setBounds + show.
import { BrowserWindow, screen, ipcMain } from 'electron';
import { join } from 'node:path';
import { page, distDir } from './paths';
import type { WheelKind } from '../shared/catalog';
import { log } from './log';

const SIZE = 440; // DIP; must match --wheel-size in wheel.css

export type WheelMode = 'drag' | 'click';

export interface WheelOpen {
  wheel: WheelKind;
  mode: WheelMode;
  // Known paths (click mode, from the Explorer selection). In drag mode the renderer only sees MIME types.
  paths?: string[];
}

export class Wheel {
  win!: BrowserWindow;
  isOpen = false;
  private hideTimer?: NodeJS.Timeout;

  create() {
    this.win = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(distDir, 'preload.js'),
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.loadFile(page('wheel'));
    this.win.webContents.on('console-message', (e) => log('[wheel]', e.message));
    this.win.on('blur', () => {
      // In click mode, clicking elsewhere dismisses the wheel.
      if (this.isOpen && this.mode === 'click') this.close();
    });
  }

  private mode: WheelMode = 'drag';

  open(opts: WheelOpen) {
    clearTimeout(this.hideTimer);
    this.mode = opts.mode;
    const p = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(p);
    const wa = display.workArea;
    // Keep the wheel on-screen even near edges.
    const x = Math.round(Math.min(Math.max(p.x - SIZE / 2, wa.x), wa.x + wa.width - SIZE));
    const y = Math.round(Math.min(Math.max(p.y - SIZE / 2, wa.y), wa.y + wa.height - SIZE));
    this.win.setBounds({ x, y, width: SIZE, height: SIZE });
    this.win.webContents.send('wheel:open', { ...opts, cursor: { x: p.x - x, y: p.y - y } });
    if (!this.isOpen) {
      if (opts.mode === 'click') {
        this.win.show();
        this.win.focus();
      } else {
        this.win.showInactive();
      }
      this.win.setAlwaysOnTop(true, 'screen-saver');
    }
    this.isOpen = true;
  }

  nav(key: string) {
    if (this.isOpen) this.win.webContents.send('wheel:nav', key);
  }

  // Called when the mouse button went up; if no drop landed on us shortly after, close.
  releaseSoon() {
    if (!this.isOpen || this.mode !== 'drag') return;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.close(), 400);
  }

  close() {
    clearTimeout(this.hideTimer);
    if (!this.isOpen) return;
    this.isOpen = false;
    this.win.webContents.send('wheel:close');
    // Let the close animation play, then actually hide.
    this.hideTimer = setTimeout(() => {
      if (!this.isOpen) this.win.hide();
    }, 140);
  }
}

export function registerWheelIpc(wheel: Wheel, onChoose: (itemId: string, paths: string[]) => void) {
  ipcMain.on('wheel:choose', (_e, itemId: string, paths: string[]) => {
    wheel.close();
    if (itemId && paths?.length) onChoose(itemId, paths);
  });
  ipcMain.on('wheel:dismiss', () => wheel.close());
}
