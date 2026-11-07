# Dashboard publisher admission v2

Install `requirements.txt` with Python 3.13. Root `bun test` and the dedicated CI job run the Python suite. The JSON schemas describe the v2 handoff and delivery.

`admit()` checks raw HTML, expanded shell, exact artifact bytes, saved key/kind pairs, lineage history, candidate-bound provider probe and an existing lock owned by this process or an ancestor. Stable refusal codes: `HANDOFF_MISSING`, `HANDOFF_SCHEMA`, `DASHBOARD_ID`, `SOURCE_SHA`, `LINEAGE_EXISTS`, `ANSWER_PERSISTENCE`, `ANSWER_IDENTITY`, `PROVIDER_NOT_READY`, `SAVED_LOCAL_ONLY`, `ARTIFACT_TOO_LARGE`, `DEPLOY_LOCK`.

`delivery()` requires a handoff, admission and `unlisted-candidate` staging proof bound to the promoted shell. Account proof attests server acknowledgement, an independent signed-in client, restoration and cleanup. Required probe is existing-empty-field or dedicated-key; disposableRecord means no prior user data, and cleanedUp means restored pre-probe value, with the row allowed to remain. Approved HTTPS origins come from the operator. builtHtmlSha256 identifies the single-file BUILD output; the gate compares sourceHtmlSha256 only against prepared sourcePath/index.html. Source, shell and artifact hashes represent different bytes. Normal receipts echo `handoff.design.admission`; existing files are preserved.

Explicit `backfill` input supplies dashboardId, sourceHtmlSha256, sourceHtml bytes and accountProof, with no handoff/admission/staging. It always emits `backfilled: true`, staging mode `none-backfill` with the served shell hash and design `UNKNOWN_BACKFILL`. It cannot authorize deployment.

`gate.py` consumes JSON stdin; binary fields use base64. Its `manifest-only` mode requires a trusted baseline, unchanged non-manifest sources/client bytes and unchanged non-generated artifact fields. `python3 ratchet.py CONFIG.json` scans configured `paths` for executable gate calls immediately before PUT/update/CLI sinks. It checks sanctioned scripts, not arbitrary programs.

The host owns probe observations, accepted-lineage registry updates and live staging/promotion, which are unbuilt here. Fake test observations prove no hosted account round trip. Developer-auth holders can bypass the gate with a raw CLI; only the sanctioned writer creates delivery receipts.
