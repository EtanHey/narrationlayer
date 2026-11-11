# Runtime probe

Copy `probe.example.json` to `~/.config/narrationlayer/probe.json` outside the
repository, fill every placeholder, then run `python3 probe.py`. Keep tokens in
the configured outside-repository token file. The app check always uses its root;
clip and audio URLs must target a current dashboard. `host` identifies the media
origin; the explicit clip and relay URLs include their respective ports and paths.

`NL_PROBE_CONFIG` overrides the config location. Existing `NL_PROBE_STATE_DIR`,
`NL_PROBE_INBOX`, `NL_PROBE_TOKEN_FILE`, `NL_PROBE_CLIP_URL`, `NL_PROBE_RELAY_URL`,
`NL_PROBE_APP_URL`, `NL_PROBE_AUDIO_URL`, `NL_PROBE_AUDIO_URL_ENDPOINT` overrides remain.
Set `NL_PROBE_INBOX` independently in launchd so invalid/missing JSON can still
notify the operational inbox. Otherwise the last configured inbox is used, then
`inbox.md` in the state directory on a first run without configuration.

DNS plus HEAD must succeed for at least one of two independent public hosts.
Sleep/DarkWake or a wake within `wake_grace_minutes` records `SKIPPED` and evidence;
no remote checks or inbox posts occur. Missing power history is a setup error.
`CONFIG-ERROR` and `FAIL` exit 1 and post once per status transition; healthy and
skipped runs exit 0. Skips preserve the last real status, including legacy state.
A healthy run after either error posts `RECOVERY`. State writes are atomic and locked.

Install only a merged copy at a stable path outside the checkout, record its
SHA-256, and point launchd at that copy using the existing Python interpreter.
Installation, launchd reload and live acceptance are separate from these tests:
`python3 -m unittest discover -s tests -p 'test_runtime_probe.py' -v`.
