# Dashboard publisher admission v2

Install `requirements.txt` with Python 3.13. Root `bun test` and the dedicated CI job run the Python suite. The JSON schemas describe the v2 handoff and delivery. The only contract source is [golems master](https://github.com/EtanHey/golems/blob/master/skills/golem-powers/audio-dashboard/references/publish-contract-v2.md); read it from golems origin/master, not retired docs.local copies.

`admit()` checks raw HTML, expanded shell, exact artifact bytes, saved key/kind pairs, lineage history, candidate-bound provider probe and an existing lock owned by this process or an ancestor. Stable refusal codes: `HANDOFF_MISSING`, `HANDOFF_SCHEMA`, `DASHBOARD_ID`, `SOURCE_SHA`, `LINEAGE_EXISTS`, `ANSWER_PERSISTENCE`, `ANSWER_IDENTITY`, `PROVIDER_NOT_READY`, `SAVED_LOCAL_ONLY`, `ARTIFACT_TOO_LARGE`, `DEPLOY_LOCK`.

`delivery()` requires an explicit `deliveries` registry (omitted/None refuses DELIVERIES_SCHEMA), a handoff, admission and staging proof bound to the promoted shell. Accepted ids require in-place-maintenance; new ids use unlisted-candidate. Account proof attests server acknowledgement, an independent signed-in client, restoration and cleanup. Required probe is existing-empty-field or dedicated-key; disposableRecord means no prior user data, and cleanedUp means restored pre-probe value, with the row allowed to remain. Approved HTTPS origins come from the operator. builtHtmlSha256 identifies the single-file BUILD output; the gate compares sourceHtmlSha256 only against prepared sourcePath/index.html. Source, shell and artifact hashes represent different bytes. Normal receipts echo `handoff.design.admission`; runtime status is recomputed from shell bytes and config before accepting the admission echo. Existing files are preserved.

Explicit `backfill` input supplies dashboardId, sourceHtmlSha256, sourceHtml bytes, accountProof and observed answerIdentity/providerReady, with no handoff/admission/staging. It always emits `backfilled: true`, staging mode `none-backfill` with the served shell hash and design `UNKNOWN_BACKFILL`. It cannot authorize deployment. Backfill needs no registry because it records historical account proof, never normal acceptance; a supplied registry is still shape-checked.

`gate.py` consumes JSON stdin; binary fields use base64. Its `manifest-only` mode requires a trusted baseline, unchanged non-manifest sources/client bytes and unchanged non-generated artifact fields. `python3 ratchet.py CONFIG.json` scans configured `paths` for executable gate calls immediately before PUT/update/CLI sinks. Python uses AST statements and JavaScript uses a string/comment-aware token scanner. They recognize direct PUTs, dynamic method arguments, CLI argv/string forms and gate redefinitions. Findings use RATCHET_UNGATED_PUT or RATCHET_GATE_REDEFINED. Ratchet gateModule config selects the canonical shim file; import paths must match its exact relative path (default ./publish-admission.mjs). It checks sanctioned scripts, not arbitrary programs.

The host owns probe observations, accepted-lineage registry updates and live staging/promotion, which are unbuilt here. Fake test observations prove no hosted account round trip. Developer-auth holders can bypass the gate with a raw CLI; only the sanctioned writer creates delivery receipts.

`answer-runtimes.json` is the NL-owned runtime allowlist. `runtime_config` (or stdin runtimeConfig) can select an operator-owned config file. Hash exactly the single `(function installAnswerPersistence() {` through `\n})();` block, trimmed. Both received input and served shell must contain that block once and match answerRuntimeSha256. Unknown runtimes refuse; deprecated runtimes require an accepted registry entry with the same dashboardId. Delivery admission.answerRuntime echoes current/deprecated; deprecated is the recorded maintenance warning. These static checks never replace the staging account proof.

An accepted dashboardId/sourceHtmlSha256 pair bypasses FIRST_IN_LINEAGE history rejection even when other pages share the lineage. FIRST_IN_LINEAGE always requires design.firstInLineage with a reason and a recorded, nonempty approvedBy; otherwise FIRST_IN_LINEAGE_UNAPPROVED refuses. A new FIRST_IN_LINEAGE page in an existing lineage still refuses LINEAGE_EXISTS.

Receipt failures distinguish STAGING_PROOF (missing), STAGING_MODE, STAGING_SHELL, ADMISSION_SHELL, ADMISSION_SOURCE, ADMISSION_ID, ADMISSION_DESIGN, ANSWER_RUNTIME_ECHO, BACKFILL_OBSERVATIONS, ACCOUNT_PROOF (schema or row count), DELIVERY_ORIGIN and DELIVERY_SCHEMA. Prepared index symlinks/escapes refuse SOURCE_PATH. Missing date-time/URI format validators refuse FORMAT_VALIDATORS; install the pinned format extra.

Ratchet limits: it does not resolve computed aliases, reflection, dynamically imported/generated/evaluated code, runtime-built command argv or options, or JavaScript template interpolations. Its JavaScript lexer is not a complete ECMAScript/TypeScript parser or control-flow proof; regex literals and arbitrary expression grammar can defeat static recognition. A method variable is conservatively treated as a possible PUT. The configured publisher inventory and real publisher boundary remain necessary; this is not a sandbox against a developer-auth holder.

Staging modes are unlisted-candidate, in-place-maintenance and none-backfill; unknown modes refuse INVALID_STAGING_MODE. For pre-PUT admission, pass staging intent to admit()/gate.py; delivery always checks it. In-place maintenance requires a 64-hex previousServedShellSha256, COMPARED or REDESIGN_APPROVED, and an accepted dashboardId in the supplied deliveries registry (MAINTENANCE_PREVIOUS_SHELL, MAINTENANCE_DESIGN, MAINTENANCE_NOT_ACCEPTED). It writes a normal receipt for PASS grading; none-backfill remains exclusive to explicit backfill. Actual rollback and account/clear-persists probes belong to the live publisher workflow.

An accepted ID must use in-place-maintenance (MAINTENANCE_REQUIRED). Its previous shell must differ from the candidate and match the last accepted row's servedShellSha256 when recorded (MAINTENANCE_PREVIOUS_SHELL). The host appends accepted history in delivery order. Registry shape is validated once per admission/delivery entry point: every lineage maps to a list of row objects, otherwise DELIVERIES_SCHEMA. First-lineage approval requires a nonblank reason and approvedBy other than case-insensitive UNRECORDED; missing required backfill keys fail BACKFILL_INPUT before field access.

Both firstInLineage and redesign approvals require nonblank, single-line reason/approvedBy and a named approver other than case-insensitive UNRECORDED. Invalid FIRST_IN_LINEAGE approval refuses FIRST_IN_LINEAGE_UNAPPROVED; invalid REDESIGN_APPROVED approval refuses REDESIGN_UNAPPROVED before schema validation. Schemas enforce the same fields. jobPath remains disallowed per the agreed removal from the canonical contract.

Each answer-runtimes.json entry requires a nonempty consumerMarkers array of nonblank exact substrings. admit() checks those runtime-specific markers together in one served script; missing/invalid marker config refuses ANSWER_RUNTIME_CONFIG, while a missing consumer/status marker refuses PROVIDER_NOT_READY. Both seeded runtime sources subscribe through listen(remote, onStatus, ...); the old literal .onStatus( check falsely refused both. Deprecated status still restricts an entry to an accepted id and is echoed for PASS_DEPRECATED_RUNTIME grading by the delivery validator. Public runtime fixtures are copied from golems with source commits, hashes and the upstream license. Static markers do not replace account proof.

### Read saved answers

Run from a checkout after `bun install --frozen-lockfile` (including devDependencies):

```sh
bun run answers export --dashboard synthetic-page --out "$HOME/answers.md" --runtime /path/to/capsule/scripts/publish-runtime.mjs
```

Needs Node, Python 3 with `bs4` and any other imports used by the local readback, an existing Lakebed developer login, and the capsule layout: `scripts/publish-runtime.mjs`, `scripts/publish_readback.py`, and `node_modules/lakebed/dist/`. Loading the trusted local runtime runs its publisher vendor-manifest check; vendor drift refuses export. The runtime supplies deployment configuration, which stays untracked. Alternatively set `NARRATIONLAYER_PUBLISH_RUNTIME`.

Repeat `--dashboard` for more pages. Retained `*artifact.json` files are searched in the capsule's `.lakebed`; pass `--baseline-dir /path/to/retained-artifacts` for the publisher's optional second baseline directory (not searched automatically). `--jobs-dir /path/to/builds` cross-checks hosted titles with `<id>/job.json`.

The command is read-only: one database read, no deploy, mutation, browser, lock write or answers on stdout. Reports are atomically replaced with mode 0600; symlink outputs and invalid parents refuse before authentication. Fixed refusal messages distinguish login, runtime, vendor drift, manifest drift and missing retained artifacts without exposing SDK messages.

Every card appears in page order. Option picks, free-text notes and note-only decisions have separate counts. Checkbox indices map to labels. Multiple owners have separate groups labelled by short hashes; a single owner is identified once per page. Served metadata is escaped; values are JSON in fenced blocks. Empty card fields are labelled as probe keys. Unmatched keys appear separately; app bookkeeping lists only keys and revisions. Row timestamps describe saved fields, not individual selections.

### Image media and visual pages

A `mediaManifest` row may declare `kind`: `mp3`, `webp`, `png`, `jpeg` (`.jpg` or `.jpeg`) or `svg`. A row without `kind` is an mp3 row and must be named `assets/<name>.mp3`; a declared kind must name its own extension (`assets/<name>.<ext>`). The schema expresses both, so a mismatch refuses `HANDOFF_SCHEMA`. That is the one tightening of the manifest's shape: the host already refused any other name at run time (`server/dashboard-media-runtime.ts:8`, "Invalid UploadThing entry").

`type: "visual"` is a document with no answers: `answerKeys` is empty, `answerRuntimeSha256` and `answerPersistence` are absent, and every row is an image. Identity, source hash, lineage/design approval, staging, artifact size and lock checks are unchanged. Admission echoes `pageType: visual` and `answerRuntime: none`. Delivery takes the proof that fits the page (`PROOF_KIND` otherwise): an answer page its answer round trip, a visual page `accountProof.method: "visual-render"` (`delivery.schema.json` third branch). Its admission echo is `pageType: visual`, `answerRuntime: none`. The visual proof records, and `delivery()` checks:

| Code | The proof is refused when |
|---|---|
| `VISUAL_PROOF_RENDER` | the renders are not exactly one at 390 and one at 1280, signed in, of this page id, with `shellSha256` equal to the served shell's sha256 (the client hashes the shell it assembled, so the render was of exactly these bytes), each reporting every manifest image loaded and no horizontal overflow |
| `VISUAL_PROOF_MEDIA_STATUS` | a manifest image has no media row, or its row is not HTTP 200 from a `*.ufs.sh` host |
| `VISUAL_PROOF_MEDIA_TYPE` | the response's content type (parameters ignored) is not the kind's own (`image/webp`, `image/png`, `image/jpeg`, `image/svg+xml`) |
| `VISUAL_PROOF_MEDIA_BYTES` | the fetched bytes' sha256 or length differ from the handoff row (a 200 with the wrong bytes fails here) |
| `VISUAL_PROOF_ANSWER_ROWS` | any answer row exists under the page's id after the proof |
| `VISUAL_PROOF_SIGNED_OUT` | the signed-out request did not answer 401: for the page's media when it has images, for the page itself when it has none |

Who observes what is the publisher's contract: the browser step reports the renders; the publisher itself fetches each image by its key and reads the answer rows and the signed-out status.

| Code | Refused when |
|---|---|
| `MEDIA_KIND` | the same file is named twice, or a name breaks the kind/extension rule on a path the schema does not see |
| `MEDIA_TOO_LARGE` | mp3 over 5 MiB, webp/png/jpeg over 2 MiB, svg over 256 KiB |
| `MEDIA_COUNT` | over 200 files or over 40 images on one page |
| `MEDIA_BYTES` | supplied bytes differ from the row's size or sha256, or lack the kind's magic bytes |
| `MEDIA_SVG_UNCHECKED` | an svg row arrives without its bytes (`admit(media=...)`, stdin `mediaBase64`) |
| `MEDIA_SVG_UNSAFE` | the svg is not well-formed `<svg>`; has a doctype, entity or processing instruction; a `script`, `foreignObject`, `iframe`, `embed` or `object`; an `on*` attribute; an `href`/`src` that is not `#fragment`; a `url(` not to `#fragment`, `@import`, `javascript:`; **any backslash or `/*` in an attribute value or style text** (CSS escapes and comments cannot exist, so the literal checks see everything; entities are decoded by the parser first); or any at-rule except `@media` |
| `MEDIA_REFERENCE` | in the parsed markup, an attribute value mentioning `assets/` is anything but a manifest image in `<img data-nl-media>` or a manifest clip in an `<audio>`/`<source>` `src` (the served shell of an audio page carries it as a URL ending in the file); or a manifest image is never referenced |
| `VISUAL_MARKUP` | a visual page contains `applet`, `audio`, `embed`, `frame`, `iframe`, `object`, `source`, `track` or `video` (detail: the element) |
| `VISUAL_ANSWERS` | a visual page declares answer fields; or its HTML holds the answer runtime (`installAnswerPersistence`); or its markup carries the template's answer attributes `data-note` or `data-decision` (every answering card has both; no visual page needs them); or rows are saved under its id |
| `VISUAL_AUDIO` | a visual page has an mp3 row (with or without `kind`) |

**Why an svg's script is inert here:** an svg is only ever referenced as `<img data-nl-media>` (`MEDIA_REFERENCE`). An svg loaded through `<img>` runs no script and loads no outside resource in every browser, and it is served from the media host's origin, not the app's. The scan is a second wall.

**What only code judges** (the schema cannot express it): sizes, counts, duplicates, bytes and magic, the svg scan, the markup rules. **What the gate does not judge:** what a visual page's script does at run time. That a visual page writes no answer and plays no clip is enforced by the host: its answers endpoints refuse a page id that is not a registered audio page, and its signed media endpoint serves a visual page only its own catalog, which holds no audio (capsule tests `server/visual-media.isolated.ts`).

**Invariant for existing pages:** `test_admission_golden.py` runs a corpus of pre-kind audio handoffs through `admit()` (no media argument) against a golden recorded from master (`python3 admission_golden.py cf4dedb2`). Every case matches except the named tightenings, each admitted on master and now refused for its stated reason: a no-kind row that is not `assets/<name>.mp3`, a duplicate file, an mp3 over 5 MiB, over 200 rows, a clip named outside `<audio src>`, an `assets/` path the manifest lacks.
