import { events, requests, type Event, type Limits, type Message, type Request } from "./messages";
import { InvalidField, type Schema } from "./schema";
export type ParseError = { code: "INVALID_REQUEST" | "UNSUPPORTED_VERSION" | "INPUT_TOO_LONG" | "NOT_NEGOTIATED" | "MISSING_CAPABILITY"; path: string; phase: "admit" | "negotiate"; retry: "never" | "after_resync"; message: string; details?: Message<"error">["details"] };
export type Result<T> = { ok: true; value: T } | { ok: false; error: ParseError };
const fail = (code: ParseError["code"], path: string): Result<never> => ({ ok: false, error: { code, path, phase: ["UNSUPPORTED_VERSION", "NOT_NEGOTIATED", "MISSING_CAPABILITY"].includes(code) ? "negotiate" : "admit", retry: code === "NOT_NEGOTIATED" ? "after_resync" : "never", message: code } });
function parse<T>(input: unknown, registry: Record<string, Schema<T>>, ignoreUnknown: boolean): Result<T | null> {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("INVALID_REQUEST", "$");
    const value = input as Record<string, unknown>;
    if (typeof value.protocol !== "string" || !/^nl\.engine\/\d+$/.test(value.protocol)) return fail("INVALID_REQUEST", "$.protocol");
    if (value.protocol !== "nl.engine/1") return fail("UNSUPPORTED_VERSION", "$.protocol");
    if (typeof value.type !== "string") return fail("INVALID_REQUEST", "$.type");
    if (!Object.hasOwn(registry, value.type)) return ignoreUnknown ? { ok: true, value: null } : fail("INVALID_REQUEST", "$.type");
    return { ok: true, value: registry[value.type].read(value, "$") };
  } catch (error) { return fail("INVALID_REQUEST", error instanceof InvalidField ? error.path : "$"); }
}
/** Engine-side receiver. Limits are the negotiated welcome limits. */
export function parseRequest(input: unknown, limits?: Limits): Result<Request> {
  const result = parse<Request>(input, requests, false);
  if (!result.ok) return result;
  const value = result.value;
  if (!value) return fail("INVALID_REQUEST", "$.type");
  if (value.type === "narrate") {
    if (limits && value.input.text.length > limits.max_chars[value.use]) return fail("INPUT_TOO_LONG", "$.input.text");
  }
  return { ok: true, value };
}
/** Host-side receiver: null explicitly means an unknown event was ignored. */
export const parseEvent = (input: unknown): Result<Event | null> => parse<Event>(input, events, true);
/** Session admission gate; negotiation state belongs to the caller. */
export function requireNegotiated(welcomed: boolean): Result<true> { return welcomed ? { ok: true, value: true } : fail("NOT_NEGOTIATED", "$.type"); }
/** Pure hello -> welcome negotiation. The caller supplies its immutable advertised welcome. */
export function negotiate(input: unknown, welcome: Message<"welcome">): Result<Message<"welcome">> {
  try { if (!input || typeof input !== "object" || !("type" in input) || input.type !== "hello") return fail("NOT_NEGOTIATED", "$.type"); } catch { return fail("NOT_NEGOTIATED", "$.type"); }
  const parsed = parseRequest(input);
  if (!parsed.ok) return parsed;
  if (parsed.value.type !== "hello") return fail("NOT_NEGOTIATED", "$.type");
  const missing = [...new Set(["lifecycle", ...(parsed.value.stage === "B" ? ["player"] : []), ...parsed.value.required_caps])].filter(cap => !welcome.caps.includes(cap));
  if (missing.length) {
    // Unknown names can carry text. Report at most eight wire positions, never
    // their contents, even truncated. Known capability names are fixed literals.
    const known = new Set(["read", "speak", "ask_prompt", "display_document", "word_timing", "alignment", "seek", "speed", "artifacts", "amplitude", "lifecycle", "seed", "player", "speaker_permits", "read_queue", "previous_read", "replay"]);
    return { ok: false, error: { code: "MISSING_CAPABILITY", path: "$.required_caps", phase: "negotiate", retry: "never", message: "MISSING_CAPABILITY", details: {
      missing_caps: missing.filter(cap => known.has(cap)),
      unknown_cap_indices: parsed.value.required_caps.flatMap((cap, index) => !known.has(cap) && missing.includes(cap) ? [index] : []).slice(0, 8),
    } } };
  }
  return { ok: true, value: welcome };
}
