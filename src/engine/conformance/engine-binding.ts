import { createArtifactStore } from "../artifacts/store";
import type { Binding } from "./binding";
import { createEngine } from "../core/engine";
import { ScriptedBackend } from "./fake-backend";

export default {
  name: "engine",
  create(host) {
    const owner_epoch = 1;
    return createEngine({ clock: host.clock, backend: host.ports?.backend ?? new ScriptedBackend(host.clock),
      owner_epoch, package_version: "0.0.0-conformance",
      limits: { max_chars: { read: 1000, speak: 1000, ask_prompt: 1000 }, lookahead: 2, aligner_reap_ms: 50 },
      engines: [{ family: "edge", max_chars: 120, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }],
      chooseEngine: () => ({ family: "edge", profile_revision: "synthetic-1", voice: "synthetic" }),
      artifacts: createArtifactStore(host.store, owner_epoch),
    });
  },
} satisfies Binding;
