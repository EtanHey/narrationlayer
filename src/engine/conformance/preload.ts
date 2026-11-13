import { syncBuiltinESMExports, builtinModules } from "node:module";
import { trapState } from "./wall-guard.js";
import { trapped, verifyInventory, type TrapKind } from "./inventory.js";
verifyInventory();
for (const [key, kind] of Object.entries(trapped.globals)) {
  if (kind === "realm" && Object.hasOwn(globalThis, key)) trap(globalThis, key, kind, key);
}
// Bun 1.3 permits frozen environment descriptors; 1.4 rejects them.
for (const env of new Set([process.env, Bun.env])) {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]) {
    try { Object.defineProperty(env, key, { value: env[key] ?? "", enumerable: true, writable: false, configurable: false }); }
    catch { /* OPEN until S0c on runtimes refusing frozen environment properties. */ }
  }
}
// This process is disposable: traps are never restored, even after publication.
function deny(kind: TrapKind, api: string): never {
  trapState.violations.push({ kind: kind === "worker" ? "spawn" : kind, api });
  process.exitCode = 1;
  throw new Error(`conformance forbids ${api}`);
}
function replace(target: object, key: string, value: unknown, api: string): void {
  try { Object.defineProperty(target, key, { value, configurable: Object.getOwnPropertyDescriptor(target, key)?.configurable ?? true, writable: false }); }
  catch { trapState.failures.push(api); }
}
function trap(target: object, key: string, kind: TrapKind, api: string): void {
  replace(target, key, function () { return deny(kind, api); }, api);
}
// Load modules before patching: https and other builtins construct shared agents.
const noDeprecation = process.noDeprecation;
process.noDeprecation = true;
const modules = Object.entries(trapped.modules).filter(([name]) => builtinModules.includes(name) && !["process", "perf_hooks", "os", "timers", "timers/promises"].includes(name))
  .map(([name, kind]) => ({ name, kind, module: require(name) }));
process.noDeprecation = noDeprecation;
for (const [key, kind] of Object.entries(trapped.bun)) {
  if (!(key in Bun) || ["file", "write"].includes(key)) continue; // file/write have conditional wrappers below
  if (key === "dns") {
    for (const method of Object.keys(Bun.dns)) if (typeof Reflect.get(Bun.dns, method) === "function") trap(Bun.dns, method, kind, `Bun.dns.${method}`);
  } else {
    const value = Reflect.get(Bun, key);
    if (value && typeof value === "object") {
      replace(Bun, key, new Proxy(value, { get() { return deny(kind, `Bun.${key}`); } }), `Bun.${key}`);
    } else trap(Bun, key, kind, `Bun.${key}`);
  }
}
for (const { name, kind, module } of modules) {
  // ws has a callable CJS default. Intercept its superclass construction
  // before either supported Bun version initializes the native transport.
  if (name === "ws") Object.setPrototypeOf(module, function () { return deny(kind, "ws.WebSocket"); });
  for (const key of Object.getOwnPropertyNames(module)) {
    if (typeof module[key] === "function") trap(module, key, kind, `${name}.${key}`);
  }
  if (module.globalAgent) for (const key of ["createConnection", "addRequest"]) trap(module.globalAgent, key, kind, `${name}.globalAgent.${key}`);
}
// Local files remain available; remote schemes must not construct native clients.
for (const key of ["file", "write"] as const) {
  const original = Bun[key];
  replace(Bun, key, new Proxy(original, { apply(target, receiver, args) {
    const path = args[0] instanceof URL ? args[0].href : args[0];
    if (typeof path === "string" && /^[a-z][a-z0-9+.-]*:/i.test(path) && !/^file:/i.test(path)) deny("network", `Bun.${key} remote scheme`);
    return Reflect.apply(target, receiver, args);
  } }), `Bun.${key}`);
}
for (const key of ["connect", "listen", "serve"]) if (!Object.hasOwn(trapped.bun, key)) throw new Error(`unreviewed ${key}`);
for (const key of ["fetch", "WebSocket"]) trap(globalThis, key, "network", key);
trapState.fetchTrap = globalThis.fetch;
trap(globalThis, "Worker", "worker", "Worker");
for (const key of ["setTimeout", "setInterval", "setImmediate"]) trap(globalThis, key, "clock", key);
for (const key of ["wait", "waitAsync"]) trap(Atomics, key, "clock", `Atomics.${key}`);
for (const name of ["node:timers", "node:timers/promises"]) {
  const module = require(name);
  for (const key of ["setTimeout", "setInterval", "setImmediate"]) trap(module, key, "clock", `${name}.${key}`);
  if (module.scheduler) for (const key of ["wait", "yield"]) trap(module.scheduler, key, "clock", `${name}.scheduler.${key}`);
}
trap(AbortSignal, "timeout", "clock", "AbortSignal.timeout");
const temporal = Reflect.get(globalThis, "Temporal");
if (temporal?.Now) for (const key of Object.getOwnPropertyNames(temporal.Now)) if (typeof temporal.Now[key] === "function") trap(temporal.Now, key, "clock", `Temporal.Now.${key}`);
trap(require("node:os"), "uptime", "clock", "node:os.uptime");
const perfHooks = require("node:perf_hooks");
for (const key of Object.getOwnPropertyNames(perfHooks)) if (typeof perfHooks[key] === "function") trap(perfHooks, key, "clock", `node:perf_hooks.${key}`);
const OriginalDate = Date;
trap(OriginalDate, "now", "clock", "Date.now");
replace(globalThis, "Date", new Proxy(OriginalDate, {
  apply() { return deny("clock", "Date"); },
  construct(target, args) { return args.length ? Reflect.construct(target, args) : deny("clock", "Date"); },
}), "Date");
replace(OriginalDate.prototype, "constructor", globalThis.Date, "Date.prototype.constructor");
for (const target of new Set([performance, Object.getPrototypeOf(performance)])) {
  for (const key of ["now", "mark", "measure", "eventLoopUtilization", "toJSON"]) trap(target, key, "clock", `performance.${key}`);
  try { Object.defineProperty(target, "timeOrigin", { get: () => deny("clock", "performance.timeOrigin"), configurable: false }); }
  catch { trapState.failures.push("performance.timeOrigin"); }
}
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
for (const key of ["exit", "reallyExit"]) trap(process, key, "exit", `process.${key}`);
if ("execve" in process) trap(process, "execve", "spawn", "process.execve");
syncBuiltinESMExports();
Object.defineProperty(trapState, "installed", { value: true, configurable: false, writable: false });
Object.defineProperty(trapState, "fetchTrap", { value: globalThis.fetch, configurable: false, writable: false });
process.on("unhandledRejection", () => { trapState.violations.push({ kind: "exit", api: "unhandledRejection" }); process.exitCode = 1; });
