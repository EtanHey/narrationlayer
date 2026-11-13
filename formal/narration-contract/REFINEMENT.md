# S2a session reducer refinement

Status: pure reducer coupling for I01–I04, not engine, journal, player or History acceptance.
The legacy filesystem binding and its sync commit remain unchanged. Message shapes
come from `src/engine/messages/messages.ts`; the reducer imports only those types.

| Model variable used by I01–I04 | Reducer representation |
|---|---|
| `job`, `owner`, `attempt` | `sessions[id].session_id`, top-level `owner_epoch`, `sessions[id].attempt_id`; fixed per accepted session |
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
| `Init`, `StartGeneration` | `initialState(owner_epoch)`, accepted request with resolved plan/identity/epoch authority; accepted then plan then backend start effect |
| `Deliver` | Matching backend piece, next planned index and piece id only |
| `Seal`, `Commit` | Backend commit accepted only after the entire plan prefix was delivered |
| `EndGeneration`, `Cancel`, `SynthesisFailure`, `PublishFailure` | Stop or backend failure; logical fence, generation terminal and independent playback terminal |
| `Spawn` | Matching first-sample feedback witnesses actual start; no spawn or permit implementation |
| `Feedback(j,o,a)` | Feedback identity gate followed by control/player pair gate and EOF coverage gate |
| `Stop`, `PlayerReaped` | Logical stop only; outcome always says physical unknown, not reaped |
| `Pause`, `Resume`, `Seek`, `ReapOld` | Control/reanchor inputs update epoch/cursor mirror; no I09 pause/restart proof |
| `Successor` | A new entry under `sessions` with explicit identities; scheduling/physical retirement not implemented |
| `Step` | Single pure transition, separate immutable domain terminals, one deferred session outcome |

The model's two-chunk bound represents an ordered prefix with zero, partial and
complete coverage. Here `delivered` grows only by the next element of the finite
plan; commit and EOF compare its length to N, and EOF also checks the last planned
index and actual start. Induction on that prefix makes the same safety argument
for any N: cancellation freezes the prefix and neither completion guard depends
on the number two. Tests exercise N=1,2,5 through ordinary spawned/first-sample/exited feedback for every piece, without a seek, with both distinct and reused player IDs. This is a refinement argument, not a
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

Round 1: the top-level state is `{owner_epoch, seq, sessions}`. Every fresh event,
including errors, uses the one owner counter; replaying an ack does not allocate
another seq. Unknown-session commands emit UNKNOWN_SESSION. Foreign asynchronous
feedback/results are dropped for I02; a wire feedback session is checked before
its epoch. Owner/attempt are NOT wire feedback fields: the binding supplies the
identity envelope, so I02 is only as strong as that binding's routing.

A delivered current/next piece's `spawned` edge installs the live player and piece;
other player IDs stay stale. `epoch_authority` is explicit per session: host (A)
adopts higher epochs on controls/feedback and rejects lower ones, without minting;
engine (B) mints on accepted pause/park, resume, seek and explicit `reanchor`
restart/speed inputs. The engine owner submits that reanchor before spawning the
replacement; spawned feedback itself does not mint. A host speed bump can arrive
on feedback alone. Stale controls yield one ack with current; stale feedback yields
one sequenced error with details.current. Stop bypasses the epoch fence by the
lead's ruling; VoiceLayer confirmation of that errata question remains pending.

The redundant fenced clause of the backend and feedback guards was removed:
cancellation already fixes both terminals and outcome. The outcome guard suppresses
late work; domain terminal guards also protect EOF before publication. Request
admission idempotency/deduplication remains outside S2a (control receipts are covered).
The exhaustive check folds identical state/depth pairs, preserving multiplicities,
so every script through depth 4 from three reachable two-piece/two-session seeds is
represented. It checks state AND effects, including no post-fence piece_ready.
