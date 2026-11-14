import type { Binding } from "./binding";
import { createEngine } from "../core/engine";
import { ScriptedBackend } from "./fake-backend";

export default {
  name: "engine",
  create(host) {
    let artifact = 0;
    const owner_epoch = 1;
    return createEngine({ clock: host.clock, backend: host.ports?.backend ?? new ScriptedBackend(host.clock),
      owner_epoch, package_version: "0.0.0-conformance",
      limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 2, aligner_reap_ms: 50 },
      engines: [{ family: "edge", legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }],
      chooseEngine: () => ({ family: "edge", profile_revision: "synthetic-1", voice: "synthetic" }),
      artifacts: {
        async put(bytes, signal) {
          signal.throwIfAborted();
          const handle = `memory:${owner_epoch}:${++artifact}`;
          if (host.store.has(handle)) throw new Error("artifact handle already exists");
          host.store.set(handle, bytes.slice());
          return { handle, lease_id: `lease:${artifact}`, format: "wav" };
        },
        async commit(_identity, signal) { signal.throwIfAborted(); },
      },
    });
  },
} satisfies Binding;
