import type { Limits, Message } from "../messages/messages";
import { createEngineSession, type Backend, type Clock } from "../session/session";
import { createPublication, type ArtifactPort } from "../publication/publication";
import type { createArtifactStore } from "../artifacts/store";
import { planRead } from "../../plan/read-plan";

import { parseVoices, selectVoice, type Voices } from "../selection/voice";
import { projectStructuredSpeech } from "../../text/voicelayer/structured-speech";

/** Host owns voice data, byte custody and time; this factory owns their composition. */
export function createEngine(options: {
  clock: Clock; backend: Backend<{ bytes: Uint8Array; timings: unknown }>;
  artifacts: ArtifactPort & Pick<ReturnType<typeof createArtifactStore>, "resolve" | "minted" | "releaseFromHost" | "shutdown" | "custody">; owner_epoch: number; limits: Limits;
  package_version: string;
  synthesis_timeout_ms: number;
  observe?: Parameters<typeof createEngineSession>[0]["observe"];
  engines: Message<"welcome">["engines"];
  voices: Voices;
}) {
  const voices = parseVoices(structuredClone(options.voices)), engines = structuredClone(options.engines);
  const session = createEngineSession({ ...options,
    // Stage-A player edges belong to the host.
    welcome: { package_version: options.package_version, protocol_minor: 0,
      caps: ["read", "speak", "ask_prompt", "display_document", "word_timing", "artifacts", "lifecycle"], engines },
    planner: { plan: (request, _limits, identity) => {
      const projection = request.input.format === "markdown" ? projectStructuredSpeech(request.input.text) : { displayText: request.input.text, speechText: request.input.text };
      const selection = selectVoice(request, projection.displayText, projection.speechText.replace(/ {2,}/g, " ").trim().length, voices, engines);
      const { engine } = selection;
      const capability = engines.find(capability => capability.family === engine.family) ?? (engine.family === "qwen3_clone" ? { max_chars: undefined } : undefined);
      if (!capability) throw new Error("selected engine family is not declared");
      // No declared cap means whole sentences; the cutter requires a positive safe integer.
      return { ...planRead({ request, identity, engine, max_chars: capability.max_chars ?? Number.MAX_SAFE_INTEGER }), selection };
    } },
    publication: createPublication(options.artifacts),
  });
  return { ...session, custody: () => options.artifacts.custody(),
    shutdown(deadline: number) {
      options.artifacts.shutdown();
      return session.shutdown(deadline);
    }, resolve: (handle: string, lease_id: string) => options.artifacts.resolve(handle, lease_id) };
}
