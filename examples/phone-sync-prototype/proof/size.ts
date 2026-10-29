import { byteLength } from "lakebed/anonymous";
import { LIMITS } from "../capsule/shared/protocol";

const artifact = await Bun.file(new URL("../.lakebed/artifacts/capsule.anonymous.json", import.meta.url)).json();
// JSON-encoded normalizedRequest/receipt strings at most double their already-encoded
// byte lengths (quotes/backslashes). All duplicated operation fields together are a
// subset of the normalized JSON, bounded by MAX_NORMALIZED_UTF8, including escaping.
// ownerId is outside the operation: reserve six bytes per input byte plus quotes.
// 1024 extra bytes cover keys, UUID id, outcome, sequence and ISO metadata per event.
const eventUpperBytes = 2 * LIMITS.MAX_NORMALIZED_UTF8 + 2 + LIMITS.MAX_NORMALIZED_UTF8
  + 2 * LIMITS.MAX_RECEIPT_UTF8 + 2 + 6 * LIMITS.MAX_ID_UTF8 + 2 + 1024;
// Heads/memberships reserve 2 KiB each, quota 1 KiB; include row-array separators.
const stateUpperBytes = LIMITS.MAX_EVENTS * (eventUpperBytes + 1)
  + LIMITS.MAX_HEADS * 2048 + LIMITS.MAX_ACCOUNTS * 2048 + 1024 + 2;
const result = { artifactBytes: byteLength(artifact), limitBytes: 1048576,
  eventUpperBytes, stateUpperBytes, rows: LIMITS.MAX_EVENTS + LIMITS.MAX_HEADS + LIMITS.MAX_ACCOUNTS + 1,
  indexBytes: null,
  indexNote: "Physical hosted index bytes unmeasured. SDK 0.0.41 memory-store stateBytes counts JSON rows only, excluding indexes. Hosted worst-case usage remains unrun." };
console.log(JSON.stringify(result, null, 2));
if (result.artifactBytes > result.limitBytes || stateUpperBytes > result.limitBytes) process.exit(1);
