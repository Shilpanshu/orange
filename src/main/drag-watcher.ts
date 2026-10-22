// Watches global mouse + keyboard input to spot "dragging something, then tapped a modifier".
// libuiohook installs WH_MOUSE_LL / WH_KEYBOARD_LL hooks, which keep firing during Explorer's
// OLE drag loop, so we can react while the user is still holding the file.
import { EventEmitter } from 'node:events';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import type { ModKey } from './settings';

// libuiohook event types. uiohook-napi's typings omit EVENT_MOUSE_DRAGGED but the native side sends it.
const EVENT_KEY_PRESSED = 4;
const EVENT_KEY_RELEASED = 5;
const EVENT_MOUSE_PRESSED = 7;
const EVENT_MOUSE_RELEASED = 8;
const EVENT_MOUSE_MOVED = 9;
const EVENT_MOUSE_DRAGGED = 10;

const DRAG_THRESHOLD = 8; // physical px the pointer must travel before we treat it as a drag

const MOD_CODES = new Map<number, Exclude<ModKey, 'none'>>([
  [UiohookKey.Shift, 'shift'],
  [UiohookKey.ShiftRight, 'shift'],
  [UiohookKey.Ctrl, 'ctrl'],
  [UiohookKey.CtrlRight, 'ctrl'],
  [UiohookKey.Alt, 'alt'],
  [UiohookKey.AltRight, 'alt'],
]);

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
  private originX = 0;
  private originY = 0;
  private heldMods = new Set<number>();
  listeningNav = false;

  start() {
    if (process.env.ORANGE_DEBUG) {
      uIOhook.on('input', (e: any) => {
        if (e.type !== 9 && e.type !== 10) console.log('hook', e.type, e.button ?? e.keycode ?? '', e.x ?? '', e.y ?? '');
      });
    }
    // One listener for every event. The hook reports each mouse move (hundreds a second), so the
    // move path returns at once unless a button is down, and allocates nothing.
    uIOhook.on('input', this.onInput);
    uIOhook.start();
  }

  private onInput = (e: any) => {
    const type: number = e.type;
    if (type === EVENT_MOUSE_MOVED || type === EVENT_MOUSE_DRAGGED) {
      if (this.dragging) return;
      if (!this.down) {
        if (type === EVENT_MOUSE_MOVED) return;
        // Movement with a button held arrives as EVENT_MOUSE_DRAGGED.
        this.down = true;
        this.originX = e.x;
        this.originY = e.y;
      }
      if (Math.abs(e.x - this.originX) + Math.abs(e.y - this.originY) > DRAG_THRESHOLD) this.beginDrag();
      return;
    }
    switch (type) {
      case EVENT_MOUSE_PRESSED:
        if (e.button !== 1) return;
        this.down = true;
        this.leftDown = true;
        this.dragging = false;
        this.originX = e.x;
        this.originY = e.y;
        return;
      case EVENT_MOUSE_RELEASED: {
        // Another button released during a left drag doesn't end it; ending a right/middle drag does.
        if (e.button !== 1 && this.leftDown) return;
        const was = this.dragging;
        this.down = false;
        this.leftDown = false;
        this.dragging = false;
        if (was) this.emit('release');
        return;
      }
      case EVENT_KEY_PRESSED: {
        const nav = NAV[e.keycode];
        if (this.listeningNav && nav) {
          this.emit('nav', nav);
          return;
        }
        const mod = MOD_CODES.get(e.keycode);
        if (!mod) return;
        // Auto-repeat sends keydown continuously while held; react only once per press. Track
        // presses outside drags too, so a key held since before the drag (Ctrl+drag to copy,
        // Shift+drag to move) is not taken for a tap when its repeats arrive mid-drag.
        if (this.heldMods.has(e.keycode)) return;
        this.heldMods.add(e.keycode);
        if (this.dragging) this.emit('modifier', mod);
        return;
      }
      case EVENT_KEY_RELEASED:
        this.heldMods.delete(e.keycode);
        return;
    }
  };

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
