// The one module that owns synchronous spawning for tests (tests/architecture/spawn-guard.test.ts enforces it).
// A test budget cannot interrupt a blocked spawnSync, so the child's own timeout is what ends it: both helpers take
// `timeout` as a required number (the type checker rejects a call without one), refuse a missing or non-positive
// one at run time too, and throw an error naming the command on a spawn error, a timeout or a kill.
import { spawnSync as nodeSpawnSync } from "node:child_process";

function requireTimeout(cmd: string[], timeout: unknown): number {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    throw new Error(`${cmd.join(" ")}: a synchronous spawn needs a positive finite timeout, got ${String(timeout)}`);
  return timeout;
}

/** Bun.spawnSync with a required timeout. Returns the result; a timeout or a kill throws. */
export function spawnChecked(cmd: string[], options: { timeout: number; cwd?: string; env?: Record<string, string | undefined>; stdin?: Buffer }) {
  const timeout = requireTimeout(cmd, options?.timeout);
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", ...options, timeout });
  if (result.exitedDueToTimeout || result.signalCode) {
    throw new Error(`${cmd.join(" ")}: ${result.exitedDueToTimeout ? `timed out after ${timeout} ms` : `killed by ${result.signalCode}`}\n${result.stderr.toString()}`);
  }
  return result;
}

/** node:child_process spawnSync with a required timeout and utf8 output. Returns status/stdout/stderr; a spawn error
 * (ENOENT, ETIMEDOUT), a timeout or a kill throws. A non-zero exit is returned for the caller to assert on. */
export function nodeSpawnChecked(command: string, args: string[], options: { timeout: number; cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) {
  const cmd = [command, ...args];
  const timeout = requireTimeout(cmd, options?.timeout);
  const result = nodeSpawnSync(command, args, { ...options, timeout, encoding: "utf8" });
  if (result.error || result.signal) {
    const why = result.error ? `${result.error.message}` : `killed by ${result.signal}`;
    throw new Error(`${cmd.join(" ")}: ${why} (timeout ${timeout} ms)\n${result.stderr ?? ""}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
