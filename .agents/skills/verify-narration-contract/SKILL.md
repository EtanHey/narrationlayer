---
name: verify-narration-contract
description: Check NarrationLayer contract changes and legacy job-store marker publication; use when touching job-store, cancellation, playback fencing, retention, eligibility or admission.
---

Run `formal/narration-contract/check.sh` from the repository root. Requires existing Bun, Python 3, Java and `~/.local/bin/tlc`; install nothing automatically. Read `formal/narration-contract/README.md` and `coverage.json` first.

Coverage sync: `2ea3d6ccf3105611c5e27409622d52e68dc3e338`. Only `src/job-store.ts:170-179` (`markDone`, `markFailed`) is behaviorally coupled, through real filesystem observations. I01-I10 describe a future contract, not existing engine behavior. Move the sync commit/hash only after reviewing changed source, updating the source map, and repeating both actual-source mutations and restoration.

The command creates an isolated scratch directory, executes actual copied source, checks its observed trace with TLC, removes each opposite-marker unlink in turn, requires invariant failure, restores original bytes and requires the baseline result again. It never edits product source. A missed mutation, source drift, uncovered action, wrong counterexample or unexpected TLC failure stops the command. Inspect the printed artifact directory's `summary.json`, `*/tlc.out`, generated configs and `*/observations.json`.

Read each TLC result with pstack `/statechart`: show shortest paths in plain words and distinguish model mistakes from reproduced product behavior. No install is authorized; use the existing Java/TLC. C21's intentionally false `NoLateFailure` is a reachability witness, not a bug. Other deliberately broken variants test sensitivity. Keep failing evidence; change a model only to match intended semantics, never weaken an invariant to get a pass.

`CHECKS_PASS` covers this bounded package only. Report I01-I10 as design-level; each implementing reducer/lease/admission/derivation PR must add real-code scratch-mutation coupling and its C-case fixtures before claiming that coverage. Use `/maintain-formal-verification-skill` after changes that did not rerun verification. Do not render, play audio, contact a daemon, download tools/models, access private assets or open a PR from this skill.
