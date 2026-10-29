# P3a signed-out hosted evidence

Status: hosted signed-out checks passed on 2026-10-29. Signed-in and physical-phone steps UNRUN.
URL: https://clear-river-2b6e42e022.lakebed.app
Expiry printed by CLI: `2026-11-05T15:09:50.897Z`. Anonymous, unclaimed; no account or OAuth keys created.
Lakebed CLI/runtime: `0.0.41`; build artifact hash:
`sha256:0b5ced402b8ce5a57619261178d7c04a4c358ec1b8c438990d5a8dc9560bc1e6`.

| Check | Evidence | Result |
| --- | --- | --- |
| HTTPS / certificate / headers | `checks.json` | 200; TLS 1.3; issuer YR1; subject `*.lakebed.app`; browser accepted certificate. `cache-control: no-store`, `nosniff`, SAMEORIGIN, CSP frame ancestors self. |
| Signed-out UI | `1280-signed-out.png`, `390-signed-out.png` | Sign in with Google visible, zero textareas; no answer components. |
| No-session data access | `auth-probes.json` | Six credential-free connections to `/__lakebed/ws` refused with HTTP 401, `Sign in to use this app.` before any handler payload could be sent. Names identify intended handlers, not six distinct handler executions. |
| Tone playback | `checks.json` | Click Play advanced to 0.418974 s; not paused. Pause then seek reached 3.2 s and stayed paused. |
| Tone transport | `checks.json` | Generated 286,694-byte WAV Blob in the browser. No network HTTP GET/Range for audio. Chrome reports a local `blob:` media GET with `Range: bytes=0-`; that is local Blob access, not hosted HTTP audio. |
| Empty database | `db-list.json`, `usage.json` | Every app table has 0 rows; usage reports 0 state bytes/rows. All nine indexes ready, no failed indexes. |
| Deploy logs | `logs.json` | Anonymous deploy created with the built artifact hash. |
| Size | `size.json`, `../size.ts` | Artifact 299,647 bytes; conservative row-state upper estimate 964,034 bytes, each below 1,048,576. Physical hosted index bytes unmeasured. |

The screenshots were captured in an owned isolated Chrome Beta context after
`agent-browser start` exited 0, using Playwright `connectOverCDP` on `127.0.0.1:9333`.
390 CSS pixels is viewport evidence, not a physical-phone receipt.
No sign-in button was clicked; all signed-in behavior remains untested.
