import type { Binding } from "./binding";
import engine from "./engine-binding";
/** Wrong: a refused word seek advances the playing piece anyway. */
const broken: Binding = { name: "broken-seek-reject-moves", create(host) {
  const c = engine.create(host); let last: { session_id: string; start_ms: number } | undefined;
  return { ...c, events: (async function* () { for await (const e of c.events) {
    if (e.type === "piece_ready") last = e;
    if (e.type === "control_ack" && e.reason === "word timing unavailable" && last)
      c.send({ protocol: "nl.engine/1", type: "control", command_id: `wrong-move-${e.seq}`, session_id: last.session_id, op: "seek", args: { audio_ms: last.start_ms } });
    yield e;
  } })() };
} };
export default broken;
