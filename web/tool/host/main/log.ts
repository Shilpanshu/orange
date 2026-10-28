// Orange 1.x's log(): lines go to the app log through the bridge (bridge.rs "log").
export function log(...parts: unknown[]) {
  const line = parts
    .map((p) => {
      if (p instanceof Error) return p.stack ?? p.message;
      if (typeof p === 'string') return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(' ');
  console.log(line);
  try {
    (window as any).orange.send('log', line.slice(0, 4000));
  } catch {
    /* logging must never throw */
  }
}
