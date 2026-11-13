# S2a session reducer refinement

Status: pure reducer coupling for I01–I04, not engine, journal, player or History acceptance.
The legacy filesystem binding and its sync commit remain unchanged. Message shapes
come from `src/engine/messages/messages.ts`; the reducer imports only those types.

| Model variable used by I01–I04 | Reducer representation |
|---|---|
| `job`, `owner`, `attempt` | `session_id`, `owner_epoch`, `attempt_id`; fixed for this reducer instance |
| `generation` | `generation`; running folds queued/sealing, commit is a distinct backend input |
| `playback` | `playback`; null until a terminal, then the first accepted reason |
| `generationLock`, `playbackLock` | Terminal values themselves; transition guards prevent replacement |
| `delivered` | Strict ordered prefix `delivered` of `plan.pieces`, including artifact receipts |
| `fenced`, `fenceCoverage` | `fenced`; delivered prefix frozen at cancellation/failure, witnessed by tests |
| `started`, `eof` | `started` after matching first-sample feedback, `eof` after guarded final exit |
| `matched`, `staleSeen` | Foreign feedback returns unchanged state; no separate diagnostic latch needed |
| `control`, `pid` | `current.control_epoch`, `current.player_instance_id` |
| `failure` | Backend failure maps to generation failed; existing playback terminal stays immutable |
| `player`, `backend`, `outstanding` | Physical processes are outside S2a; cancellation effect supplies no exit proof |

| Model action | Reducer input / transition |
|---|---|
| `Init`, `StartGeneration` | `initialState`, accepted request with resolved plan; accepted then plan then backend start effect |
| `Deliver` | Matching backend piece, next planned index and piece id only |
| `Seal`, `Commit` | Backend commit accepted only after the entire plan prefix was delivered |
| `EndGeneration`, `Cancel`, `SynthesisFailure`, `PublishFailure` | Stop or backend failure; logical fence, generation terminal and independent playback terminal |
| `Spawn` | Matching first-sample feedback witnesses actual start; no spawn or permit implementation |
| `Feedback(j,o,a)` | Feedback identity gate followed by control/player pair gate and EOF coverage gate |
| `Stop`, `PlayerReaped` | Logical stop only; outcome always says physical unknown, not reaped |
| `Pause`, `Resume`, `Seek`, `ReapOld` | Only control epoch/cursor mirror updates here; no I09 pause/restart proof |
| `Successor` | A new reducer value with explicit identities; scheduling/physical retirement not implemented |
| `Step` | Single pure transition, separate immutable domain terminals, one deferred session outcome |

The model's two-chunk bound represents an ordered prefix with zero, partial and
complete coverage. Here `delivered` grows only by the next element of the finite
plan; commit and EOF compare its length to N, and EOF also checks the last planned
index and actual start. Induction on that prefix makes the same safety argument
for any N: cancellation freezes the prefix and neither completion guard depends
on the number two. Tests exercise N=1,2,5. This is a refinement argument, not a
machine-checked unbounded proof or a liveness claim.

Beyond the model: ID-01 fences the same-session `(control_epoch, player_instance_id)`
pair and returns STALE_EPOCH with current; seq advances once per fresh event; the
last 32 command receipts replay the first ack without allocating seq. Changed
arguments reject without replacing the first receipt. I01's model locks are
per-attempt; the reducer additionally emits one outcome only after both domains
settle, allowing EOF then publication failure (C21). Control acks are binding
responses, not post-outcome session events. Retention, admission, replay, timing,
queueing, pause ownership/cursor resolution, actual player lifecycle and all
I05–I10 remain outside this slice. Stage A History remains host-owned.
