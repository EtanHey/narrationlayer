export const trapState: { installed: boolean; fetchTrap?: typeof fetch; failures: string[]; violations: { kind: "clock" | "network" | "spawn" | "exit" | "realm"; api: string }[] } = { installed: false, failures: [], violations: [] };
// Case-local guard only; S0b owns the complete process preload and real-I/O traps.
export async function withoutWallTime<T>(run: () => Promise<T>, recordViolation: (violated: boolean) => void = () => {}): Promise<T> {
  if (trapState.installed) {
    const start = trapState.violations.length;
    try { return await run(); } finally { recordViolation(trapState.violations.slice(start).some(v => v.kind === "clock")); }
  }
  const targets: [object, string][] = [[Date, "now"], [performance, "now"], [globalThis, "setTimeout"], [globalThis, "setInterval"], [Bun, "sleep"]];
  const originals = targets.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
  let violated = false;
  const OriginalDate = globalThis.Date;
  const deny = () => { violated = true; throw new Error("wall time forbidden"); };
  try {
    globalThis.Date = new Proxy(OriginalDate, { apply: deny, construct(target, args) { if (!args.length) return deny(); return Reflect.construct(target, args); } });
    for (const [target, key] of targets) Object.defineProperty(target, key, { ...(Object.getOwnPropertyDescriptor(target, key) ?? { configurable: true }), value: () => { violated = true; throw new Error("wall time forbidden"); } });
    const result = await run();
    if (violated) throw new Error("wall time forbidden");
    return result;
  } finally {
    recordViolation(violated);
    globalThis.Date = OriginalDate;
    targets.forEach(([target, key], i) => { const original = originals[i]; if (original) Object.defineProperty(target, key, original); else Reflect.deleteProperty(target, key); });
  }
}

export const trapsPresent = () => trapState.installed && trapState.fetchTrap === globalThis.fetch;
