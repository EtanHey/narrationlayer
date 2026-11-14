import type { ArtifactPort } from "../publication/publication";
export type ArtifactIdentity = Parameters<ArtifactPort["put"]>[1];
export interface BytePort {
  has(handle: string): boolean;
  get(handle: string): Uint8Array | undefined;
  set(handle: string, bytes: Uint8Array): unknown;
  delete(handle: string): unknown;
}
export class ArtifactStoreError extends Error {
  constructor(readonly code: "collision" | "sealed" | "shutdown" | "storage" | "aborted" | "owner") { super(`artifact ${code}`); }
}
/** Synchronous byte port; hosts resolve player paths outside this module.
 * Host must enforce one live store per byte port and owner epoch; restart/reconnect uses a new epoch. */
export function createArtifactStore(port: BytePort, owner_epoch: number) {
  let next = 0, closed = false;
  const live = new Map<string, ArtifactIdentity & { handle: string; lease_id: string }>();
  const sealed = new Set<string>(), pending = new Set<string>();
  const attempt = (id: Omit<ArtifactIdentity, "piece_id">) => JSON.stringify([id.owner_epoch, id.session_id, id.attempt_id]);
  const check = (signal: AbortSignal) => { if (signal.aborted) throw new ArtifactStoreError("aborted"); };
  return {
    async put(bytes: Uint8Array, identity: ArtifactIdentity, signal: AbortSignal) {
      check(signal);
      if (closed) throw new ArtifactStoreError("shutdown");
      if (identity.owner_epoch !== owner_epoch) throw new ArtifactStoreError("owner");
      if (sealed.has(attempt(identity))) throw new ArtifactStoreError("sealed");
      const handle = `memory:${owner_epoch}:${++next}`, lease_id = `lease:${owner_epoch}:${next}`;
      let writing = false;
      try {
        if (port.has(handle)) throw new ArtifactStoreError("collision");
        check(signal);
        writing = true;
        port.set(handle, bytes.slice());
        check(signal);
        live.set(lease_id, { owner_epoch, session_id: identity.session_id, attempt_id: identity.attempt_id, piece_id: identity.piece_id, handle, lease_id });
        return { handle, lease_id, format: "wav" as const };
      } catch (error) {
        if (writing) { try { port.delete(handle); } catch { throw new ArtifactStoreError("storage"); } }
        throw error instanceof ArtifactStoreError ? error : new ArtifactStoreError("storage");
      }
    },
    minted(lease_id: string): boolean {
      const prefix = `lease:${owner_epoch}:`, suffix = lease_id.slice(prefix.length), n = Number(suffix);
      return lease_id.startsWith(prefix) && Number.isSafeInteger(n) && n > 0 && n <= next && String(n) === suffix;
    },
    custody() { return { live: [...live.values()].map(({ lease_id, handle, session_id, piece_id }) => ({ lease_id, handle, session_id, piece_id })), pending_delete: [...pending] }; },
    pendingDeletes() { return [...pending]; },
    releaseFromHost(lease_id: string): { kind: "released" | "expired" } {
      const entry = live.get(lease_id);
      if (!entry) return { kind: "expired" };
      live.delete(lease_id);
      queueMicrotask(() => { try { port.delete(entry.handle); } catch { pending.add(entry.handle); } });
      return { kind: "released" };
    },
    release(lease_id: string): ReturnType<ArtifactPort["release"]> {
      const entry = live.get(lease_id);
      if (!entry) return { kind: "expired" };
      try { port.delete(entry.handle); } catch { return { kind: "failed" }; }
      live.delete(lease_id);
      return { kind: "released" };
    },
    resolve(handle: string, lease_id: string): { kind: "resolved"; bytes: Uint8Array } | { kind: "expired" | "failed" } {
      const entry = live.get(lease_id);
      if (!entry || entry.handle !== handle) return { kind: "expired" };
      let bytes: Uint8Array | undefined;
      try { bytes = port.get(handle); } catch { return { kind: "failed" }; }
      return bytes ? { kind: "resolved", bytes: bytes.slice() } : { kind: "expired" };
    },
    /** Live leases in put order, including interleaved attempts. */
    leases(session_id: string) {
      return [...live.values()].filter(entry => entry.session_id === session_id).map(entry => ({ ...entry }));
    },
    async commit(identity: Omit<ArtifactIdentity, "piece_id">, signal: AbortSignal) {
      check(signal); // No await: abort before commit leaves it open; after commit cannot unseal it.
      sealed.add(attempt(identity));
    },
    shutdown() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => { for (const handle of pending) {
        try { port.delete(handle); pending.delete(handle); } catch { /* Retain for the host drain. */ }
      } });
    },
  } satisfies ArtifactPort & Record<string, unknown>;
}
