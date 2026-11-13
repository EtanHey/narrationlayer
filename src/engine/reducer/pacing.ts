import type { SessionState, State } from "./session";
/** Next strict-prefix piece; all pacing facts belong to the reducer. */
export function nextSynthesisIndex(session: SessionState, lookahead: number, sessions: State["sessions"]): number | undefined {
  if (session.generation !== "running" || session.fenced) return;
  const index = session.delivered.length;
  if (index >= session.plan.pieces.length) return;
  const start = session.request.start;
  if (start && typeof start === "object") {
    const prior = Object.hasOwn(sessions, start.after_session) ? sessions[start.after_session] : undefined;
    // Exact identity: an unknown predecessor has not completed; wait for it or stop.
    if (!prior || prior.generation === "running") return;
    // Amendment 1: first_sample, not spawned, hands prefetch back to normal pacing.
    if (!session.started && index > 0) return;
  }
  // Contract L76 counts pieces past the playing piece; lead ruling: minimum 1
  // avoids waiting for a spawn of unsynthesized audio. S1b owns parser bounds.
  if (index > session.current.piece_index + Math.max(1, lookahead)) return;
  return index;
}
