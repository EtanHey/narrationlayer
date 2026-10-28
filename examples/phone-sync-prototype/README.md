# Synthetic phone sync: bounded P1 algorithm slice

Status: PARTIAL / SPLIT REQUIRED. This directory is not a capsule or deployable backend.
It exports no data handler, session override, admin endpoint or storage adapter.
Keep the approved Lakebed state plus future authorized-media architecture.

Fixed fixture: `d-demo-r1`, immutable content revision `synthetic-r1`, questions
`q-orbit-r1` / `q-tide-r1`, each with `answer` / `note`. Values are invented.
Changed question meaning must get a new question ID.

`protocol.ts` strictly normalizes an untrusted operation, compares stored replay bytes,
and decides a new field event from scoped evidence. It returns a proposal; it does not
append, assign an event ID, publish a receipt, mutate a head or reserve capacity.
`sealReceipt` bounds JSON bytes; the future adapter must construct the required receipt
and check its assigned ID before publication. Empty resolution text explicitly clears.

Run `bun test examples/phone-sync-prototype/protocol.test.ts`. These tests exercise
local deterministic algorithms only. They do not prove Lakebed auth, rollback,
concurrent transactions, last-slot admission or client draft/outbox behavior.

Required next split, before any endpoint can use this module:
- Real `requireSignedIn()` plus active membership on every read/write; owner from auth.
- Four scalar-field tables with `userId()`, `id(table)`, `.optional()` and scoped indexes.
- Checked `take(2)` singleton reads; self-enrollment with no reactivation; global quota.
- Authorized op lookup/replay before NEW-operation freshness/head/capacity checks.
- Complete pending read `take(MAX_PENDING+1)`, exact count and scoped parent reads.
- Atomic event/immutable receipt/head/quota writes, 48/64 reservation and safe refusals.
- Bounded heads/history/receipt queries and actual signed-in capsule checks.
- Client draft retention, uncertain-ack and account-switch reconciliation in P2.

Primary evidence: [agents](https://lakebed.dev/agents.md),
[database](https://docs.lakebed.dev/database/index.md), [auth](https://docs.lakebed.dev/auth/index.md),
[capsule API](https://docs.lakebed.dev/capsule-api/index.md), [limits](https://docs.lakebed.dev/limits/index.md).
Researched CLI pin: `lakebed@0.0.41`, Node >=22.18, database API v1; CLI not installed/run.
Built-in Google sign-in needs existing authorized accounts; named local guests cannot pass it.
Free anonymous deployment ownership is separate from visitor auth; no deploy was attempted.
Static assets are limited to favicon; P2 must verify any synthetic-tone delivery route.
Protected-media authorization, Range/Blob, grants, expiry, revocation, cache and audit remain unrun.
