------------------------ MODULE NarrationContract ------------------------
EXTENDS Naturals, TLC
CONSTANT Mutant
VARIABLE s
GTerminal == {"committed", "failed", "cancelled"}
PTerminal == {"completed", "failed", "cancelled", "stopped"}
Idle(x) == x \in {"none", "exited"}
Init == \E job \in {1, 2}: s =
 [job |-> job, owner |-> 1, attempt |-> 1, control |-> 1, pid |-> 1,
  generation |-> "queued", playback |-> "preparing", retention |-> "held", eligibility |-> "pending",
  generationLock |-> "", playbackLock |-> "", delivered |-> 0, fenced |-> FALSE, failure |-> "none",
  backend |-> "none", outstanding |-> FALSE, player |-> "none", paused |-> FALSE,
  started |-> FALSE, playingSaved |-> FALSE, pending |-> FALSE,
  archive |-> FALSE, eof |-> FALSE, leases |-> 1, exists |-> TRUE,
  admission |-> "open", permit |-> 1, close |-> 0, capture |-> FALSE,
  restart |-> FALSE, matched |-> TRUE, staleSeen |-> FALSE, playerUnknown |-> FALSE,
  selectedRejected |-> FALSE, timing |-> 0, timingAttempt |-> 0, seekPause |-> FALSE,
  fenceCoverage |-> 0, seekOK |-> TRUE]
\* Locks witness domain-scoped terminal immutability within one attempt/session.
Step(n) == s' = [n EXCEPT
 !.generationLock = IF n.attempt # s.attempt THEN ""
       ELSE IF s.generationLock = "" /\ n.generation \in GTerminal THEN n.generation ELSE s.generationLock,
 !.playbackLock = IF n.attempt # s.attempt THEN ""
       ELSE IF s.playbackLock = "" /\ n.playback \in PTerminal THEN n.playback ELSE s.playbackLock,
 !.fenceCoverage = IF n.fenced /\ ~s.fenced THEN s.delivered ELSE s.fenceCoverage,
 !.seekOK = IF n.attempt # s.attempt THEN TRUE
           ELSE IF s.restart /\ ~n.restart THEN n.paused = s.paused ELSE s.seekOK]
StartGeneration == /\ s.generation = "queued" /\ s.admission = "open"
 /\ Step([s EXCEPT !.generation = "running", !.backend = "active", !.outstanding = TRUE])
Deliver == /\ ((s.generation = "running" /\ ~s.fenced) \/ (Mutant = "late-delivery" /\ s.fenced))
 /\ s.delivered < 2
 /\ Step([s EXCEPT !.delivered = @ + 1])
Seal == /\ s.generation = "running" /\ s.delivered = 2
 /\ Step([s EXCEPT !.generation = "sealing"])
Commit == /\ (s.generation = "sealing" /\ ~s.fenced)
             \/ (Mutant = "late-commit" /\ s.fenced /\ s.delivered = 2)
 /\ Step([s EXCEPT !.generation = "committed"])
\* Client abort fences publication; it supplies NO backend quiescence proof.
EndGeneration(outcome, phase) == /\ s.generation \notin GTerminal
 /\ Step([s EXCEPT !.generation = outcome, !.failure = phase, !.fenced = TRUE,
  !.backend = IF Mutant = "abort-drain" THEN "exited" ELSE @,
  !.playback = IF Mutant = "reopen-terminal" THEN "preparing"
        ELSE IF s.playback \in PTerminal THEN @
        ELSE IF s.player = "active" THEN "stopping" ELSE outcome])
Cancel == EndGeneration("cancelled", "cancel")
SynthesisFailure == /\ s.generation = "running" /\ EndGeneration("failed", "synthesis")
PublishFailure == /\ s.generation = "sealing" /\ EndGeneration("failed", "publication")
BackendExit == /\ s.backend = "active"
 /\ Step([s EXCEPT !.backend = "exited", !.outstanding = FALSE])
Spawn == /\ s.playback = "preparing" /\ ~s.paused /\ ~s.fenced
 /\ s.admission = "open" /\ s.permit = 1 /\ Idle(s.player)
 /\ (~s.capture \/ Mutant = "capture-spawn")
 /\ s.delivered > 0 /\ s.eligibility # "rejected" /\ s.exists
 /\ Step([s EXCEPT !.playback = "playing", !.player = "active",
      !.pid = s.control, !.started = TRUE, !.pending = TRUE])
Pause == /\ s.playback \in {"preparing", "playing"} /\ ~s.capture
 /\ Step([s EXCEPT !.playback = "paused", !.paused = TRUE])
Resume == /\ s.playback = "paused"
 /\ Step([s EXCEPT !.playback = IF s.player = "active" THEN "playing" ELSE "preparing",
                    !.paused = FALSE])
Seek == /\ s.playback \in {"preparing", "playing", "paused"} /\ s.control = 1
 /\ s.eligibility = "eligible" /\ ~s.fenced
 /\ Step([s EXCEPT !.control = 2, !.restart = TRUE, !.playback = "stopping",
      !.seekPause = s.paused, !.paused = IF Mutant = "seek-start-pause" THEN FALSE ELSE @])
ReapOld == /\ s.restart /\ (s.player # "unknown" \/ Mutant = "unknown-reap")
 /\ Step([s EXCEPT !.player = "exited", !.restart = FALSE,
  !.playback = IF s.playback \in PTerminal THEN @
        ELSE IF s.generation \in {"failed", "cancelled"} THEN s.generation
        ELSE IF s.paused THEN "paused" ELSE "preparing",
  !.paused = IF Mutant = "seek-pause" THEN FALSE ELSE @])
\* Wrong identity can settle retired physical work via ReapOld, never the cursor.
Feedback(j, o, a) ==
 LET matches == <<j,o,a>> = <<s.job,s.owner,s.attempt>> IN
 /\ s.player = "active" /\ s.playback \in {"playing", "paused"}
 /\ IF matches \/ Mutant = "foreign-feedback"
     THEN /\ (s.delivered = 2 \/ Mutant = "truncated-eof") /\ ~s.fenced
          /\ Step([s EXCEPT !.playback = "completed", !.player = "exited",
                !.eof = TRUE, !.matched = matches])
     ELSE /\ ~s.staleSeen /\ Step([s EXCEPT !.staleSeen = TRUE])
Stop == /\ s.playback \notin PTerminal /\ ~s.restart
 /\ Step([s EXCEPT !.playback = IF s.player = "active" THEN "stopping" ELSE "stopped"])
PlayerReaped == /\ s.playback = "stopping" /\ ~s.restart
 /\ (s.player # "unknown" \/ Mutant = "unknown-reap")
 /\ Step([s EXCEPT !.player = "exited",
  !.playback = IF s.generation \in {"failed", "cancelled"} THEN s.generation ELSE "stopped"])
PersistPlaying == /\ s.started /\ s.pending
 /\ Step([s EXCEPT !.playingSaved = TRUE, !.pending = FALSE])
Archive == /\ s.playback = "completed" /\ (s.playingSaved \/ Mutant = "archive-prerequisite")
 /\ ~s.archive
 /\ Step([s EXCEPT !.archive = TRUE, !.retention = "durable"])
Release == /\ s.generation \in GTerminal /\ s.playback \in PTerminal
 /\ Idle(s.backend) /\ (Idle(s.player) \/ Mutant = "early-release") /\ ~s.pending /\ s.leases = 1
 /\ (s.archive \/ s.playback # "completed")
 /\ Step([s EXCEPT !.leases = 0, !.retention = "releasable"])
Delete == /\ s.exists
 /\ ((s.retention = "releasable" /\ s.leases = 0 /\ ~s.pending) \/ Mutant = "lease-delete")
 /\ Step([s EXCEPT !.exists = FALSE])
ObserveTiming(hash) == /\ s.delivered = 2 /\ s.eligibility = "pending"
 /\ (hash = 1 \/ Mutant = "timing-identity")
 /\ Step([s EXCEPT !.eligibility = "eligible", !.timing = hash, !.timingAttempt = s.attempt])
Reject == /\ s.eligibility = "eligible" /\ Step([s EXCEPT !.eligibility = "rejected"])
Select == /\ s.eligibility = "eligible" \/ (Mutant = "reject-reuse" /\ s.eligibility = "rejected")
 /\ ~s.selectedRejected
 /\ Step([s EXCEPT !.selectedRejected = (s.eligibility = "rejected")])
Capture == /\ s.admission = "open" /\ ~s.capture /\ Idle(s.player)
 /\ Step([s EXCEPT !.capture = TRUE])
CaptureEnd == /\ s.capture /\ Step([s EXCEPT !.capture = FALSE])
Close == /\ s.admission = "open"
 /\ Step([s EXCEPT !.admission = "closed", !.permit = 0, !.close = 1])
Drain == /\ s.admission = "closed" /\ Idle(s.backend) /\ Idle(s.player)
 /\ ~s.capture /\ s.leases = 0 /\ ~s.pending
 /\ Step([s EXCEPT !.admission = "safe"])
\* Recovery never interprets loss of a process as physical backend exit.
Crash == /\ s.backend = "active" \/ s.player = "active"
 /\ Step([s EXCEPT !.backend = IF @ = "active" THEN "unknown" ELSE @,
   !.player = IF @ = "active" THEN "unknown" ELSE @,
   !.playerUnknown = s.playerUnknown \/ s.player = "active"])
Successor == /\ s.owner = 1 /\ s.admission = "open"
 /\ s.generation \in GTerminal /\ s.playback \in PTerminal
 /\ Idle(s.backend) /\ Idle(s.player) /\ ~s.pending /\ s.exists
 /\ Step([s EXCEPT !.owner = 2, !.attempt = 2, !.control = 1, !.pid = 1,
  !.generation = "queued", !.playback = "preparing", !.fenced = FALSE, !.delivered = 0,
  !.eof = FALSE, !.started = FALSE, !.paused = FALSE, !.matched = TRUE, !.failure = "none",
  !.restart = FALSE, !.seekPause = FALSE,
  !.eligibility = IF Mutant = "stale-derivation" THEN @ ELSE "pending",
  !.timing = IF Mutant = "stale-derivation" THEN @ ELSE 0,
  !.timingAttempt = IF Mutant = "stale-derivation" THEN @ ELSE 0, !.selectedRejected = FALSE,
  !.archive = FALSE, !.playingSaved = FALSE, !.retention = "held", !.leases = 1])
Next == StartGeneration \/ Deliver \/ Seal \/ Commit \/ Cancel \/ PublishFailure \/ SynthesisFailure
 \/ BackendExit \/ Spawn \/ Pause \/ Resume \/ Seek \/ ReapOld \/ Stop
 \/ PlayerReaped \/ PersistPlaying \/ Archive \/ Release \/ Delete
 \/ Reject \/ Select \/ Capture \/ CaptureEnd \/ Close
 \/ Drain \/ Crash \/ Successor \/ (\E h \in {1,2}: ObserveTiming(h))
 \/ (\E j,o,a \in {1,2}: Feedback(j,o,a))
Spec == Init /\ [][Next]_s
TypeOK == /\ s.job \in {1,2} /\ s.owner \in {1,2} /\ s.attempt \in {1,2}
 /\ s.control \in {1,2} /\ s.pid \in {1,2} /\ s.delivered \in 0..2
 /\ s.generation \in {"queued", "running", "sealing"} \cup GTerminal
 /\ s.playback \in {"preparing", "playing", "paused", "stopping"} \cup PTerminal
 /\ s.retention \in {"held", "durable", "releasable"} /\ s.eligibility \in {"pending", "eligible", "rejected"}
 /\ s.backend \in {"none", "active", "exited", "unknown"}
 /\ s.player \in {"none", "active", "exited", "unknown"}
 /\ s.admission \in {"open", "closed", "safe"} /\ s.leases \in 0..1
I01 == (s.generationLock = "" \/ s.generation = s.generationLock) /\ (s.playbackLock = "" \/ s.playback = s.playbackLock)
I02 == s.matched
I03 == s.fenced => s.generation # "committed" /\ s.delivered = s.fenceCoverage
I04 == (s.playback = "completed" => s.eof /\ s.delivered = 2 /\ s.started)
 /\ (s.generation = "committed" => s.delivered = 2)
I05 == ~s.selectedRejected
I06 == ~s.exists => s.leases = 0 /\ ~s.pending /\ Idle(s.player) /\ Idle(s.backend)
I07 == s.archive => s.started /\ s.playingSaved
I08 == /\ ~(s.capture /\ s.player = "active")
 /\ (s.admission = "safe" => s.close = 1 /\ s.permit = 0
 /\ Idle(s.backend) /\ ~s.outstanding /\ Idle(s.player)
 /\ ~s.capture /\ ~s.playerUnknown /\ s.leases = 0 /\ ~s.pending)
I09 == s.seekOK /\ (s.restart => s.paused = s.seekPause) /\ (s.playback = "paused" => s.paused)
I10 == s.eligibility \in {"eligible", "rejected"} => s.timing = 1 /\ s.timingAttempt = s.attempt
\* C21 reachability witness, checked as an intentionally false invariant.
NoLateFailure == ~(s.playback = "completed" /\ s.generation = "failed" /\ s.failure = "publication")
==========================================================================
