/** R103: only fixed callback identifiers and standard error kinds cross the log port. */
export type HostCallback = "observe.event" | "observe.input" | "clock.now" | "clock.monotonic"
  | "clock.schedule" | "clock.cancel" | "backend.synthesizeRequest" | "publication.piece"
  | "publication.commit" | "publication.release" | "artifacts.put" | "artifacts.release"
  | "artifacts.releaseFromHost" | "artifacts.minted" | "artifacts.resolve" | "artifacts.custody"
  | "artifacts.commit" | "artifacts.shutdown" | "store.has" | "store.set" | "store.get" | "store.delete";
export type HostErrorName = "TypeError" | "RangeError" | "Error" | "NonError";
export type HostLog = (entry: { callback: HostCallback; error_name: HostErrorName }) => void;
export class HostFault extends Error { constructor(readonly callback: HostCallback) { super("host callback failed"); } }
export function hostCallbacks(log?: HostLog) {
  function report(callback: HostCallback, error: unknown) {
    let error_name: HostErrorName = "NonError";
    try { error_name = error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof Error ? "Error" : "NonError"; } catch { /* A thrown proxy is also untrusted. */ }
    try { void Promise.resolve(log?.({ callback, error_name })).catch(() => {}); } catch { /* R103: logging cannot break the host. */ }
  }
  function call<T>(callback: HostCallback, run: () => T): T {
    try { return run(); } catch (error) { report(callback, error); throw new HostFault(callback); }
  }
  return { report, call,
    ignore(callback: HostCallback, run: () => unknown) {
      try { void Promise.resolve(run()).catch(error => report(callback, error)); } catch (error) { report(callback, error); }
    },
    schedule(clock: { schedule(ms: number, callback: () => void): () => void }, ms: number, callback: () => void) {
      let active = true;
      const cancel = call("clock.schedule", () => clock.schedule(ms, () => { if (active) { active = false; callback(); } }));
      return () => {
        active = false; // R102(a): logically cancelled even if the host cannot cancel its timer.
        try { void Promise.resolve(cancel()).catch(error => report("clock.cancel", error)); } catch (error) { report("clock.cancel", error); }
      };
    },
  };
}
