// Watches global mouse + keyboard input to spot "dragging something, then tapped a modifier".
// libuiohook installs WH_MOUSE_LL / WH_KEYBOARD_LL hooks, which keep firing during Explorer's
// OLE drag loop, so we can react while the user is still holding the file.
import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey } from 'uiohook-napi';

// libuiohook's EVENT_MOUSE_DRAGGED; uiohook-napi's typings omit it but the native side sends it.
const EVENT_MOUSE_DRAGGED = 10;
import type { ModKey } from './settings';

const DRAG_THRESHOLD = 8; // physical px the pointer must travel before we treat it as a drag

const MOD_CODES: Record<Exclude<ModKey, 'none'>, number[]> = {
  shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
  ctrl: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
  alt: [UiohookKey.Alt, UiohookKey.AltRight],
};

export type NavKey = 'left' | 'right' | 'up' | 'down' | 'enter' | 'escape' | 'tab';

const NAV: Record<number, NavKey> = {
  [UiohookKey.ArrowLeft]: 'left',
  [UiohookKey.ArrowRight]: 'right',
  [UiohookKey.ArrowUp]: 'up',
  [UiohookKey.ArrowDown]: 'down',
  [UiohookKey.Enter]: 'enter',
  [UiohookKey.Escape]: 'escape',
  [UiohookKey.Tab]: 'tab',
};

export interface DragWatcherEvents {
  modifier: (mod: Exclude<ModKey, 'none'>) => void; // modifier pressed mid-drag
  release: () => void; // left button released (drag ended somewhere)
  nav: (key: NavKey) => void; // arrow/enter/escape while the wheel listens
}

export class DragWatcher extends EventEmitter {
  private down = false;
  // A left press we saw ourselves. Without it, `down` came from a drag event, which libuiohook
  // also sends for right- and middle-button drags.
  private leftDown = false;
  private dragging = false;
  private origin = { x: 0, y: 0 };
  private heldMods = new Set<number>();
  listeningNav = false;

  start() {
    if (process.env.ORANGE_DEBUG) {
      uIOhook.on('input', (e: any) => {
        if (e.type !== 9 && e.type !== 10) console.log('hook', e.type, e.button ?? e.keycode ?? '', e.x ?? '', e.y ?? '');
      });
    }
    uIOhook.on('mousedown', (e) => {
      if (e.button !== 1) return;
      this.down = true;
      this.leftDown = true;
      this.dragging = false;
      this.origin = { x: e.x, y: e.y };
    });
    uIOhook.on('mousemove', (e) => {
      if (!this.down || this.dragging) return;
      if (Math.abs(e.x - this.origin.x) + Math.abs(e.y - this.origin.y) > DRAG_THRESHOLD) this.beginDrag();
    });
    // Movement with a button held arrives as EVENT_MOUSE_DRAGGED, which uiohook-napi only
    // forwards through the generic 'input' event.
    uIOhook.on('input', (e: any) => {
      if (e.type !== EVENT_MOUSE_DRAGGED) return;
      if (!this.down) {
        this.down = true;
        this.origin = { x: e.x, y: e.y };
      }
      if (!this.dragging && Math.abs(e.x - this.origin.x) + Math.abs(e.y - this.origin.y) > DRAG_THRESHOLD) this.beginDrag();
    });
    uIOhook.on('mouseup', (e) => {
      // Another button released during a left drag doesn't end it; ending a right/middle drag does.
      if (e.button !== 1 && this.leftDown) return;
      const was = this.dragging;
      this.down = false;
      this.leftDown = false;
      this.dragging = false;
      if (was) this.emit('release');
    });
    uIOhook.on('keydown', (e) => {
      if (this.listeningNav && NAV[e.keycode]) {
        this.emit('nav', NAV[e.keycode]);
        return;
      }
      for (const [mod, codes] of Object.entries(MOD_CODES)) {
        if (codes.includes(e.keycode)) {
          // Auto-repeat sends keydown continuously while held; react only once per press. Track
          // presses outside drags too, so a key held since before the drag (Ctrl+drag to copy,
          // Shift+drag to move) is not taken for a tap when its repeats arrive mid-drag.
          if (this.heldMods.has(e.keycode)) return;
          this.heldMods.add(e.keycode);
          if (this.dragging) this.emit('modifier', mod as Exclude<ModKey, 'none'>);
          return;
        }
      }
    });
    uIOhook.on('keyup', (e) => {
      this.heldMods.delete(e.keycode);
    });
    uIOhook.start();
  }

  // The source window (usually Explorer) is still in front at this point, so main can read
  // its selection to learn exactly which files are being dragged.
  private beginDrag() {
    this.dragging = true;
    if (process.env.ORANGE_DEBUG) console.log('drag started');
    this.emit('dragstart');
  }

  get isDragging() {
    return this.dragging;
  }

  stop() {
    try {
      uIOhook.stop();
    } catch {
      /* already stopped */
    }
  }
}
