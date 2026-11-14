import type { Limits, Message } from "../messages/messages";
import { createEngineSession, type Backend, type Clock } from "../session/session";
import { createPublication, type ArtifactPort } from "../publication/publication";
import { planRead } from "../../plan/read-plan";

/** Host owns backend selection, byte custody and time; this factory owns their composition. */
export function createEngine(options: {
  clock: Clock; backend: Backend<{ bytes: Uint8Array; timings: unknown }>;
  artifacts: ArtifactPort; owner_epoch: number; limits: Limits;
  package_version: string;
  engines: Message<"welcome">["engines"];
  chooseEngine(request: Message<"narrate">): Message<"plan">["engine"];
}) {
  return createEngineSession({ ...options,
    // Artifact capability awaits S7 live leases; stage-A player edges belong to the host.
    welcome: { package_version: options.package_version, protocol_minor: 0,
      caps: ["read", "speak", "ask_prompt", "display_document", "word_timing", "lifecycle"], engines: options.engines },
    planner: { plan: (request, limits, identity) => planRead({ request, limits, identity, engine: options.chooseEngine(request) }) },
    publication: createPublication(options.artifacts),
  });
}
