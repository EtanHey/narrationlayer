import type { Limits, Message } from "../messages/messages";
import { createEngineSession, type Backend, type Clock } from "../session/session";
import { createPublication, type ArtifactPort } from "../publication/publication";
import type { createArtifactStore } from "../artifacts/store";
import { planRead } from "../../plan/read-plan";

/** Host owns backend selection, byte custody and time; this factory owns their composition. */
export function createEngine(options: {
  clock: Clock; backend: Backend<{ bytes: Uint8Array; timings: unknown }>;
  artifacts: ArtifactPort & Pick<ReturnType<typeof createArtifactStore>, "resolve" | "minted" | "releaseFromHost">; owner_epoch: number; limits: Limits;
  package_version: string;
  engines: Message<"welcome">["engines"];
  chooseEngine(request: Message<"narrate">): Message<"plan">["engine"];
}) {
  return { ...createEngineSession({ ...options,
    // Stage-A player edges belong to the host.
    welcome: { package_version: options.package_version, protocol_minor: 0,
      caps: ["read", "speak", "ask_prompt", "display_document", "word_timing", "artifacts", "lifecycle"], engines: options.engines },
    planner: { plan: (request, _limits, identity) => {
      const engine = options.chooseEngine(request);
      const capability = options.engines.find(capability => capability.family === engine.family);
      if (!capability) throw new Error("selected engine family is not declared");
      // No declared cap means whole sentences; the cutter requires a positive safe integer.
      return planRead({ request, identity, engine, max_chars: capability.max_chars ?? Number.MAX_SAFE_INTEGER });
    } },
    publication: createPublication(options.artifacts),
  }), resolve: (handle: string, lease_id: string) => options.artifacts.resolve(handle, lease_id) };
}
