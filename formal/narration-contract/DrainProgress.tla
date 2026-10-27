-------------------------- MODULE DrainProgress --------------------------
EXTENDS Naturals
CONSTANT Responsive
VARIABLES backend, fenced, closed, safe
vars == <<backend, fenced, closed, safe>>
Init == /\ backend = "active" /\ fenced = FALSE /\ closed = FALSE /\ safe = FALSE
Abort == /\ ~fenced /\ fenced' = TRUE /\ UNCHANGED <<backend, closed, safe>>
Close == /\ ~closed /\ closed' = TRUE /\ UNCHANGED <<backend, fenced, safe>>
Exit == /\ Responsive /\ backend = "active" /\ backend' = "exited"
 /\ UNCHANGED <<fenced, closed, safe>>
DeclareSafe == /\ closed /\ backend = "exited" /\ ~safe /\ safe' = TRUE
 /\ UNCHANGED <<backend, fenced, closed>>
Next == Abort \/ Close \/ Exit \/ DeclareSafe
\* Only this conditional progress model assumes a responsive backend and close.
Spec == Init /\ [][Next]_vars /\ WF_vars(Exit) /\ WF_vars(Close) /\ WF_vars(DeclareSafe)
Safe == safe => closed /\ backend = "exited"
EventuallySafe == <>safe
==========================================================================
