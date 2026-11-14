/** R103: only fixed callback identifiers and standard error kinds cross the log port. */
export type HostLog = (entry: { callback: string; error_name: string }) => void;
export class HostFault extends Error { constructor(readonly callback: string) { super("host callback failed"); } }
export function hostCallbacks(log?: HostLog) {
  function report(callback: string, error: unknown) {
    let error_name = "NonError";
    try { error_name = error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof Error ? "Error" : "NonError"; } catch { /* A thrown proxy is also untrusted. */ }
    try { void Promise.resolve(log?.({ callback, error_name })).catch(() => {}); } catch { /* R103: logging cannot break the host. */ }
  }
  function call<T>(callback: string, run: () => T): T {
    try { return run(); } catch (error) { report(callback, error); throw new HostFault(callback); }
  }
  return { report, call,
    ignore(callback: string, run: () => unknown) {
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
