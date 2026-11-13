import { syncBuiltinESMExports } from "node:module";
import { trapState } from "./wall-guard.js";
// This process is disposable: traps are never restored, even after publication.
function deny(kind: "clock" | "network" | "spawn" | "exit", api: string): never {
  trapState.violations.push({ kind, api });
  process.exitCode = 1;
  throw new Error(`conformance forbids ${api}`);
}
function replace(target: object, key: string, value: unknown, api: string): void {
  try { Object.defineProperty(target, key, { value, configurable: false, writable: false }); }
  catch { trapState.failures.push(api); }
}
function trap(target: object, key: string, kind: "clock" | "network" | "spawn" | "exit", api: string): void {
  replace(target, key, function () { return deny(kind, api); }, api);
}
for (const key of ["spawn", "spawnSync", "$"]) trap(Bun, key, "spawn", `Bun.${key}`);
for (const key of ["connect", "listen", "serve"]) trap(Bun, key, "network", `Bun.${key}`);
for (const key of ["fetch", "WebSocket"]) trap(globalThis, key, "network", key);
trap(globalThis, "Worker", "spawn", "Worker");
for (const key of ["setTimeout", "setInterval", "setImmediate"]) trap(globalThis, key, "clock", key);
for (const key of ["sleep", "sleepSync", "nanoseconds"]) trap(Bun, key, "clock", `Bun.${key}`);
for (const key of ["wait", "waitAsync"]) trap(Atomics, key, "clock", `Atomics.${key}`);
const groups = {
  "node:child_process": "spawn", "node:worker_threads": "spawn",
  "node:net": "network", "node:tls": "network", "node:http": "network",
  "node:https": "network", "node:dgram": "network",
} as const;
const modules = Object.entries(groups).map(([name, kind]) => ({ name, kind, module: require(name) }));
for (const { name, kind, module } of modules) {
  for (const key of Object.keys(module)) {
    if (typeof module[key] === "function") trap(module, key, kind, `${name}.${key}`);
  }
  // Existing agents otherwise retain their original constructors and methods.
  if (module.globalAgent) for (const key of ["createConnection", "addRequest"]) trap(module.globalAgent, key, kind, `${name}.globalAgent.${key}`);
}
for (const name of ["node:timers", "node:timers/promises"]) {
  const module = require(name);
  for (const key of ["setTimeout", "setInterval", "setImmediate"]) trap(module, key, "clock", `${name}.${key}`);
  if (module.scheduler) for (const key of ["wait", "yield"]) trap(module.scheduler, key, "clock", `${name}.scheduler.${key}`);
}
const OriginalDate = Date;
trap(OriginalDate, "now", "clock", "Date.now");
replace(globalThis, "Date", new Proxy(OriginalDate, {
  apply() { return deny("clock", "Date"); },
  construct(target, args) { return args.length ? Reflect.construct(target, args) : deny("clock", "Date"); },
}), "Date");
replace(OriginalDate.prototype, "constructor", globalThis.Date, "Date.prototype.constructor");
trap(performance, "now", "clock", "performance.now");
try { Object.defineProperty(performance, "timeOrigin", { get: () => deny("clock", "performance.timeOrigin"), configurable: false }); }
catch { trapState.failures.push("performance.timeOrigin"); }
const hrtime = function () { return deny("clock", "process.hrtime"); };
Object.defineProperty(hrtime, "bigint", { value: () => deny("clock", "process.hrtime.bigint") });
replace(process, "hrtime", hrtime, "process.hrtime");
trap(process, "uptime", "clock", "process.uptime");
const Format = Intl.DateTimeFormat;
function formatter(args: unknown[]) {
  const value = Reflect.construct(Format, args);
  return new Proxy(value, { get(target, key) {
    const member = Reflect.get(target, key, target);
    if (key === "format" || key === "formatToParts") return (...dates: unknown[]) => dates[0] === undefined ? deny("clock", `Intl.DateTimeFormat.${String(key)}`) : Reflect.apply(member, target, dates);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}
replace(Intl, "DateTimeFormat", new Proxy(Format, { apply: (_t, _r, args) => formatter(args), construct: (_t, args) => formatter(args) }), "Intl.DateTimeFormat");
replace(Format.prototype, "constructor", Intl.DateTimeFormat, "Intl.DateTimeFormat.prototype.constructor");
trap(process, "exit", "exit", "process.exit");
syncBuiltinESMExports();
trapState.installed = true;
process.on("unhandledRejection", () => { trapState.violations.push({ kind: "exit", api: "unhandledRejection" }); process.exitCode = 1; });
