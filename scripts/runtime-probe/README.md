# Runtime probe

Copy `probe.example.json` to `~/.config/narrationlayer/probe.json` outside the
repository, fill every placeholder, then run `python3 probe.py`. Keep tokens in
the configured outside-repository token file. The app check always uses its root;
clip and audio URLs must target a current dashboard. The explicit clip and relay
URLs include their respective origins, ports and paths; no separate `host` is required.

`NL_PROBE_CONFIG` overrides the config location. Existing `NL_PROBE_STATE_DIR`,
`NL_PROBE_INBOX`, `NL_PROBE_TOKEN_FILE`, `NL_PROBE_CLIP_URL`, `NL_PROBE_RELAY_URL`,
`NL_PROBE_APP_URL`, `NL_PROBE_AUDIO_URL`, `NL_PROBE_AUDIO_URL_ENDPOINT` overrides remain.
Set `NL_PROBE_INBOX` independently in launchd so invalid/missing JSON can still
notify the operational inbox. Otherwise the last configured inbox is used, then
`inbox.md` in the state directory on a first run without configuration.

DNS plus a 2xx HEAD must succeed for at least one of two independent public hosts;
redirects do not count. Sleep/DarkWake events count as asleep only within
`sleep_event_max_age_minutes` (default 30); a Wake has a separate
`wake_grace_minutes` (default 5). Older events permit remote checks.
Client offline/asleep records `SKIPPED` and evidence without judging remotes.
After `skip_notice_hours` (default 2) of continuous skipping, one SKIP-NOTICE
alerts the inbox. It stays suppressed across skip-reason changes until a real
check or config error resets the episode. Missing power history is a setup error.
`CONFIG-ERROR` and `FAIL` exit 1 and post once per status transition; healthy and
skipped runs exit 0. Skips preserve the last real status, including legacy state.
A healthy run after either error posts `RECOVERY`. State writes are atomic and locked.

Install only a merged copy at a stable path outside the checkout, record its
SHA-256, and point launchd at that copy using the existing Python interpreter.
Installation, launchd reload and live acceptance are separate from these tests:
`python3 -m unittest discover -s tests -p 'test_runtime_probe.py' -v`.

Tests load the selected `PROBE_UNDER_TEST` only after setting temporary inbox,
state, token and config paths. Every invocation guards file opens, directory
creation and atomic replacement against writes outside its temporary directory,
including legacy import-time inbox globals.
