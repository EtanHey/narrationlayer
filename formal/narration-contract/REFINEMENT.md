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
| `control`, `pid` | `current.control_epoch`, `current.player_instance_id`; `job_epoch` records when that job was installed |
| `failure` | Backend failure maps to generation failed; existing playback terminal stays immutable |
| `player`, `backend`, `outstanding` | Physical processes are outside S2a; cancellation effect supplies no exit proof |

| Model action | Reducer input / transition |
|---|---|
| `Init`, `StartGeneration` | `initialState(owner_epoch, epoch_authority)`, accepted request with resolved plan/identity; accepted then plan then backend start effect |
| `Deliver` | Matching backend piece, next planned index and piece id only |
| `Seal`, `Commit` | Backend commit accepted only after the entire plan prefix was delivered |
| `EndGeneration`, `Cancel`, `SynthesisFailure`, `PublishFailure` | Stop or backend failure; logical fence, generation terminal and independent playback terminal |
| `Spawn` | Spawned feedback installs a delivered current/next live job; first-sample feedback witnesses actual start; no process spawn or permit implementation |
| `Feedback(j,o,a)` | Feedback identity gate followed by control/player pair gate and EOF coverage gate |
| `Stop`, `PlayerReaped` | Logical stop only; scoped control applies this transition in admission order to each reached, unexcluded session (rulings 78-82); one ack, outcome always says physical unknown, not reaped |
| `Pause`, `Resume` | S5a records pause_owner, manual takeover and owner-matched resume; accepted controls reanchor; no I09 restart proof yet |
| `Seek`, `ReapOld` | Seek preserves pause_owner, resolves delivered-word/audio targets and acknowledges offset/clamping; I09 binds the stage-A mirror only; no physical restart or ReapOld proof |
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

Round 1: the top-level state is `{owner_epoch, epoch_authority, seq, sessions}`. Every fresh event,
including errors, uses the one owner counter; replaying an ack does not allocate
another seq. Unknown-session commands emit UNKNOWN_SESSION. Foreign asynchronous
feedback/results are dropped for I02; a wire feedback session is checked before
its epoch. Owner/attempt are NOT wire feedback fields: the binding supplies the
identity envelope, so I02 is only as strong as that binding's routing.

A delivered current/next piece's `spawned` edge installs the live player and piece;
other player IDs stay stale. `epoch_authority` is explicit once per engine/binding: host (A)
adopts higher epochs on controls/feedback and rejects lower ones, without minting;
engine (B) mints on accepted pause, resume, seek and explicit `reanchor`
restart/speed inputs. The engine owner submits that reanchor before spawning the
replacement; spawned feedback itself does not mint. A host speed bump can arrive
on feedback alone. Stale controls yield one ack with current; stale feedback yields
one sequenced error with details.current. Stop bypasses the epoch fence by the
lead's ruling; VoiceLayer confirmation of that errata question remains pending.

The redundant fenced clause of the backend and feedback guards was removed:
cancellation already fixes both terminals and outcome. The generation terminal
check is the operative backend I03 fence; playback terminals protect EOF before publication. Request
admission idempotency/deduplication remains outside S2a (control receipts are covered).
The exhaustive check folds identical state/depth pairs, preserving multiplicities,
so every script through depth 4 from three reachable two-piece/two-session seeds is
represented. It checks state AND effects, including no post-fence piece_ready.

Final-round refinement: the stage/epoch authority is fixed on the engine, never on
accept. Reanchor is engine-only in the input type; host attempts return a plain
internal HOST_REANCHOR refusal, with no wire event. Engine refusals are plain
UNKNOWN_SESSION/TERMINAL values. Park has no input in S2a; S5 owns park state.
The host deliberately adopts larger epochs from matching live feedback or a valid
spawned job. At an unchanged epoch, a different instance on the same piece is stale;
a restart must advance the epoch. Epoch changes clear the previous-job slot.

No order is assumed between the current exit and the next spawn. A next-piece
spawn retains one previous `(player_instance_id,piece_index)`; its same-epoch exit
settles silently when completed, or accepts player_failed when failed. Repeated
spawn notifications preserve that pending slot. No terminal reopens. This handles
distinct and reused player IDs; fixtures cover both exit/spawn orders. Input ownership follows the S2d immutable snapshot contract below.

## S2c admission and failure diagnostics outside the model

The model starts at an accepted request. The three input additions are `admit`,
`refuse`, and backend `failure` carrying an error. `admit` either requests planning
without changing state, replays the stored original accepted without allocating a
sequence, or emits one conflict error. `refuse` emits one admission error. Neither
changes sessions or the serialisable idempotency index. Only a successful new `accept`
records the key, session and original accepted receipt. A duplicate `accept`
rechecks admission: identical requests replay; differing requests conflict, even
if the caller already minted a different session ID. No second session or backend
start is created. The caller passes parsed requests for canonical comparison.
The index survives JSON round trips and has no eviction in this slice.

A live backend failure emits its synthesis error before the existing outcome;
its generation/fence transitions are unchanged. Contract §7 corrects the old
always-speech_failed fallback: with no delivered audio playback is synth_failed,
and after any delivered piece it is speech_failed. An existing playback terminal
(including completed after EOF) still wins. Terminal/fenced attempts
still emit nothing. These additions cannot reopen an I01 terminal, accept foreign
I02 feedback, unfreeze I03 delivery, or bypass I04 coverage: admission inputs never
touch those fields, and failure retains their existing guards. The exhaustive
code check also parses every fresh and replayed event using the wire parser.
The refusal input carries only code, message and optional request_id. The reducer
copies §2.5's six admission/negotiation phase/retry pairs; planner failures use
INVALID_REQUEST/admit. Unknown runtime codes get internal INVALID_REFUSAL, with
no sequence/event. Both refusal and synthesis errors copy only named fields:
extra caller type/details/session/command fields never become wire diagnostics.
Refused keys are not recorded; plan is not replayed; a new owner epoch starts a
new index. Same request_id under different keys remains allowed pending the
contract decision. Later eviction must remove a session and its index together.

The exhaustive checker retains every depth, letter and safety assertion, adds a
duplicate-accept letter, verifies original accepted replay/conflict/error ordering,
parses each distinct serialized event once, and caches JSON fingerprints of
immutable traversal objects (WeakMap). These caches only avoid repeating parsing
or serialization; each transition still executes the actual reducer and every
applicable assertion. The timeout remains 20 seconds.

This extends code coupling, not the formal model or engine acceptance. Retry,
per-session last seq, speed, pause and index eviction remain outside S2c.

## S2d immutable snapshots and reducer cost

Callers must never mutate a state passed to or returned by `reduce`, an input
once passed, or an effect. The reducer relies on that ownership contract: it
shares requests, plans, cursors and delivered pieces by reference. Mutating a
shared session or payload would change multiple snapshots at once and invalidate
replay comparisons and cached fingerprints. State remains plain JSON data.

A transition copies the top level and only its changed session, replacing changed
cursors, delivered arrays and receipt arrays. Other sessions and unchanged fields
retain their references; a transition with no change returns the original state.
The sessions/admissions maps are shallow-copied only when their entries change. This
still costs O(number of sessions) for a changed session map, but never copies the
other sessions' text or word tables. Admission-only errors share the maps.

Replay is the exception to input sharing: the small control command and its ack
are deep-copied into the bounded receipt list. Later caller mutation of a command
cannot alter its original replay identity or response. Accepted receipts contain
only freshly constructed scalar fields. The former defensive copying guarantee
for requests, plans, cursors and delivered pieces is intentionally replaced by
the immutable-input contract; command mutation isolation remains tested.

Ordinary reducer tests and every exhaustive transition freeze state and input
recursively, except the deliberate post-call command/replay mutation probes.
The S2d builder (w52, 2026-11-14) compared state and effects against bf3e3f82
on 220,640 transitions, zero differences. The independent reviewer (rv88,
2026-11-14) reran 219,920 merged traversal transitions plus 478 named/setup
calls on Bun 1.4.4 and 1.3.11, zero differences. These were scratch proofs,
recorded in [the merge receipt](https://github.com/EtanHey/narrationlayer/pull/91#issuecomment-6867412155)
and [the review](https://github.com/EtanHey/narrationlayer/pull/91#issuecomment-6867316348).
A later slice owes validation of untyped cursors with missing or extra keys;
the reference-restoration comparison currently assumes full typed cursors.
Replay effects detach accepted/control ack events before handing them out.
The session detaches planner plans and publication pieces on ingestion, so a
provider retaining and mutating its return value cannot rewrite a live read.
This changes storage ownership and cost, not the fences, inputs or wire behavior.
No eviction, per-session last seq or retry input is introduced.

## S4b duration and engine lifecycle records

The reducer sequences `synthesis_requested` at the backend call, and sequences
`audio_ready` immediately before each accepted `piece_ready`, followed by `duration`.
The request input contains identity, index, UTF-16 length and monotonic time;
kind comes from the plan's first segment, never request text. It changes only
`seq`, and is dropped for unknown, foreign, non-running or terminal sessions.
Publication computes cumulative `known_ms` with the exact decoded-sample formula
and supplies it alongside the piece. A decreasing or invalid receipt is refused
before delivery; the session's existing receipt-rejection path fails synthesis.
The last emitted duration is retained independently of control targets; the
cursor's previously unchanged `duration_ms` is updated on accepted delivery.
These numeric fields and emissions do not add a model transition:

- I01: neither the new input nor emissions changes generation, playback, fence,
  delivered list or outcome. Existing terminals remain immutable.
- I02: the new input uses the same owner/session/attempt fence. The emissions
  occur only on an already identity-checked piece; no domain state changes.
- I03: non-running/terminal requests are dropped; fenced late pieces cannot
  produce audio-ready or duration. No input or emission clears the fence or
  changes generation, playback, delivered list or outcome.
- I04: the existing piece transition alone appends to delivered. The emissions
  neither append nor seal/commit, and `final` reflects complete plan coverage.
  Rejecting an invalid duration does not introduce a partial delivery; the
  existing failure transition is used. No new EOF or commit rule is introduced.

The depth-4 alphabet stays at 40: the request input is checked separately for
EVERY session at EVERY reachable frontier, including depth 4, asserting identical
session maps and only the expected sequence increment/record. Its execution
therefore cannot affect a later domain transition; named tests additionally
cover foreign/unknown identities and the live record contents. Piece delivery
now emits two additional sequenced events and updates cursor duration: these
observable numbers distinguish snapshots that formerly shared a serialization.
Counts move from 44,227 visits / 38,729 distinct to 44,380 / 38,876; represented
prefixes remain 7,876,923. The new request input is not a letter in those counts.
The model, configurations and checking program are unchanged. This is reducer
and publication evidence, not player, binding-level or live acceptance.

## S7b-1 lease release

Reducer SHA-256: `69ede0401b395d097babc68bdfcbbd324f14c4b39f290dfe17d16b7fbbb5eb73`.
ART-01 exercises I06 at the points it lists; I06 stays design-level: released delivered leases are excluded from subsequent
outcome receipts; generation and playback coverage still use all delivered pieces.
The existing alphabet does not include artifact_release; custody offset tests
exercise releases before and after outcomes across two sessions, including
same-turn release followed by stop, final exited feedback or shutdown.

## S7b-2 shutdown

Reducer SHA-256: `efe6e0cd67d1f5389054eb78edcec9cc709b7001eaa22202bf498454ce3b0d1c`.

S7b-2 adds a shutdown input: complete delivered coverage commits, otherwise
interrupted; playback ends as shutdown only when no earlier terminal was accepted. The bounded alphabet still omits this
input; custody offset tests and SHUT-01 exercise it, not the model alphabet.

## S5d resync display state

Rulings 83-88 add a pure resync transaction: one addressed ack, one connection
snapshot of sessions without outcomes in admission order, their plans and one
resync timing update per delivered piece. No delivery or lease is created. Each
fresh event advances seq; replayed receipts do not. The separate session_seqs
map records every addressed emission, including acks and guarded-feedback errors,
without changing the domain session map. Snapshot position is the stage-A mirror.
I01-I04 guards and transitions are unchanged; resync changes only sequence
metadata and the command receipt. Existing exhaustive depth/alphabet remain 4/40;
metadata distinguishes formerly equal states: visits 44,380 -> 46,613, distinct
38,876 -> 40,762; represented prefixes stay 7,876,923. The feedback-guards test's
whole-state assertion now explicitly includes only the intended last-seq update.
SNAP-01 source mutations remove the live filter or substitute untimed plan words;
the whole mutation driver supplies sensitivity and restored-pass evidence.
No new model-level or host/player acceptance is claimed.
