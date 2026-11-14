import { createArtifactStore } from "../artifacts/store";
import type { Binding } from "./binding";
import { createEngine } from "../core/engine";
import { ScriptedBackend } from "./fake-backend";

export default {
  name: "engine",
  create(host) {
    const owner_epoch = 1;
    return createEngine({ synthesis_timeout_ms: host.synthesis_timeout_ms ?? 2000, clock: host.clock, backend: host.ports?.backend ?? new ScriptedBackend(host.clock),
      owner_epoch, package_version: "0.0.0-conformance",
      limits: { max_chars: { read: 1000, speak: 900, ask_prompt: 800 }, lookahead: 2, aligner_reap_ms: 50 },
      engines: host.engines ?? [{ family: "edge", max_chars: 120, legacy: false, clone: false, timing: "none", cancel: "abort_only", available: true }],
      voices: host.voices ?? { profiles: { synthetic: { kind: "preset", revision: "synthetic-1", voice: "synthetic" } }, default_voice: "synthetic", hebrew_voice: "he-IL-HilaNeural" },
      artifacts: createArtifactStore(host.store, owner_epoch),
    });
  },
} satisfies Binding;
