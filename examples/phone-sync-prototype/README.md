# Synthetic phone sync: P1 protocol + capsule reads and writes

Status: P1c read/write capsule. Not deployed, not
acceptance of the phone prototype. Keep the approved Lakebed state plus future authorized-media architecture.

Fixed fixture: `d-demo-r1`, immutable content revision `synthetic-r1`, questions
`q-orbit-r1` / `q-tide-r1`, each with `answer` / `note`. Values are invented.
Changed question meaning must get a new question ID.

Layout (`capsule/` is a Lakebed v0 capsule; its build resolves imports only inside it):
- `capsule/shared/protocol.ts` strictly normalizes an untrusted operation, compares stored replay
  bytes and decides a field event from scoped evidence. Only `normalize()` outputs reach
  `replay`/`decide` (module-private brand). Empty resolution text explicitly clears.
- `capsule/server/schema.ts`: memberships/heads/events/quota, `userId()`, `id("events").optional()`.
- `capsule/server/store.ts`: `enroll`/`save`/`resolve` over a narrow `Db` port
  (`withIndex` eq/gt, `take`, `insert`, `update`). C2 order: membership, op lookup, replay or
  `OP_ID_REUSE`, then new-op target/content/capacity (48 ordinary, 64 total, heads 8, pending 16,
  accounts 2), `take(MAX_PENDING+1)` pending + canonical + scoped parents, `decide`, then insert
  event, seal its receipt with the assigned id, update head and quota. Singletons use checked `take(2)`.
- `capsule/server/index.ts`: `auth.requireSignIn: true`; each mutation takes `userId` from
  `ctx.auth.requireSignedIn()` only. Each query does the same. No admin, grant, revoke or reset handler.
- `capsule/server/reads.ts`: all reads require current active membership. `heads(dashboardId)`
  returns field heads with `canonical` (row or null) and complete current `pending` rows; resolved
  conflicts remain only in history. `history(dashboardId, questionId, field, { cursor, numItems })`
  uses Lakebed `paginate`, with 1–16 items and the returned opaque `continueCursor` (null initially).
  Cursors are bound to the scoped query. `receipt(dashboardId, deviceId, opId)` returns the original
  stored receipt or null; a stored dashboard mismatch is denied. Revocation denies historical reads.

Run `bun test examples/phone-sync-prototype`. `store.test.ts` runs `store.ts` against
`memory-db.ts`, a **local in-memory adapter: evidence about this code, not Lakebed proof**. It models only
the subset above, serialized writes, and throw-means-rollback; identities are injected in the test.
`reads.test.ts` runs every P1c case twice: that adapter and Lakebed's exported `MemoryCapsuleStore`
+ `DatabaseSession`, using the actual serialized schema and read transactions. Both are **local
adapter evidence** with injected accounts. The first adapter models pagination with a test-only
query-bound cursor; Lakebed uses its own authenticated cursor format. Neither proves hosted auth.

Real runtime (`npx lakebed dev`, `lakebed@0.0.41` on Node >=22.18): no-session and named-guest
(`?lakebed_guest=alice`) WebSocket requests to all three mutations and all three queries are
refused with 401 at upgrade, before handler execution.

UNRUN until P3 (hosted, real Google sign-in with existing accounts): signed-in success paths,
cross-account isolation through real accounts, hosted transaction rollback and serialization,
measured state-byte usage. Client draft/outbox and account-switch reconciliation are P2.

Primary evidence: [agents](https://lakebed.dev/agents.md),
[database](https://docs.lakebed.dev/database/index.md), [auth](https://docs.lakebed.dev/auth/index.md),
[capsule API](https://docs.lakebed.dev/capsule-api/index.md), [limits](https://docs.lakebed.dev/limits/index.md).
Free anonymous deployment ownership is separate from visitor auth; no deploy was attempted.
Static assets are limited to favicon; P2 must verify any synthetic-tone delivery route.
Protected-media authorization, Range/Blob, grants, expiry, revocation, cache and audit remain unrun.
