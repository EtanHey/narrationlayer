import path from "node:path";

/** Resolve a destination strictly below root, including a separator in the check. */
export function resolveWithinRoot(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...parts);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (destination === resolvedRoot || !destination.startsWith(prefix)) {
    throw new Error(`Path escapes root: ${destination}`);
  }
  return destination;
}
