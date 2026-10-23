// node:events, enough for the ported main-process code (EventEmitter on/once/off/emit).
type Fn = (...a: any[]) => void;
export class EventEmitter {
  private _ev = new Map<string | symbol, Fn[]>();
  on(e: string | symbol, f: Fn) {
    (this._ev.get(e) ?? this._ev.set(e, []).get(e)!).push(f);
    return this;
  }
  addListener(e: string | symbol, f: Fn) {
    return this.on(e, f);
  }
  once(e: string | symbol, f: Fn) {
    const w = (...a: any[]) => {
      this.off(e, w);
      f(...a);
    };
    return this.on(e, w);
  }
  off(e: string | symbol, f: Fn) {
    const l = this._ev.get(e);
    if (l) this._ev.set(e, l.filter((x) => x !== f));
    return this;
  }
  removeListener(e: string | symbol, f: Fn) {
    return this.off(e, f);
  }
  removeAllListeners(e?: string | symbol) {
    if (e === undefined) this._ev.clear();
    else this._ev.delete(e);
    return this;
  }
  emit(e: string | symbol, ...a: any[]) {
    const l = this._ev.get(e);
    if (!l?.length) return false;
    for (const f of [...l]) f(...a);
    return true;
  }
  listenerCount(e: string | symbol) {
    return this._ev.get(e)?.length ?? 0;
  }
  setMaxListeners() {
    return this;
  }
}
export default EventEmitter;
export function once(em: EventEmitter, e: string): Promise<any[]> {
  return new Promise((res) => em.once(e, (...a: any[]) => res(a)));
}
