import { existsSync, realpathSync } from "node:fs";
export type Containment = "macos-sandbox" | "in-process-tripwire";
export const sandboxExecutable = "/usr/bin/sandbox-exec";
export const sandboxAvailable = (): boolean => process.platform === "darwin" && existsSync(sandboxExecutable);
/** Allow only the parent's TCP loopback port; deny socket creation/traffic elsewhere.
 * Exec permits Bun's initial image; fork denial also denies posix_spawn, including
 * the same Bun binary. A same-image exec replacement inherits the sandbox.
 */
export function sandboxProfile(port: number, binary = process.execPath): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid sandbox sink port");
  return `(version 1)
(allow default)
(deny mach-lookup)
(deny lsopen)
(deny appleevent-send)
(deny file-write*)
(allow file-write* (literal "/dev/null"))
(deny signal)
(allow signal (target self))
(deny network*)
(allow network-outbound (remote tcp4 "localhost:${port}"))
(deny process-fork)
(deny process-exec*)
(allow process-exec (literal ${JSON.stringify(realpathSync(binary))}))`;
}
export function sandboxCommand(command: string[], port: number): string[] {
  return [sandboxExecutable, "-p", sandboxProfile(port, command[0]), ...command];
}
