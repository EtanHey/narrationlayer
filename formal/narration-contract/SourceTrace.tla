--------------------------- MODULE SourceTrace ---------------------------
EXTENDS Naturals, Sequences
CONSTANT Observations
VARIABLE i
Init == i = 1
Next == /\ i < Len(Observations) /\ i' = i + 1
Spec == Init /\ [][Next]_i
\* src/job-store.ts:170-179, observed only after a single writer's awaited call.
LegacyExclusive == ~(Observations[i].done /\ Observations[i].failed)
==========================================================================
