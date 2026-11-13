# VoiceLayer projection sources

Copied unchanged from [EtanHey/voicelayer](https://github.com/EtanHey/voicelayer),
commit `7d13b6203b1fa70f3d652c127769246d9a8b1b0a`, under the Apache License 2.0 (see LICENSE).

| File | Git blob id |
| --- | --- |
| `display-tokens.ts` | `5da77152f9580b384015ff56e22b347a5bd9fb43` |
| `inline-code-spans.ts` | `a28a4e577f83e37621d75055780dd50bf973f8c1` |
| `markdown-to-speech.ts` | `88731858441cb5c63ceaa941e5402fa7a4579351` |
| `structured-speech.ts` | `d67115aa3532a2efee781cda5f0901c9b48b6f32` |
| `sections.ts` | `5c27bffcae547f44dfa48209d322acabd5f5b8ea` |
| `structured-display.ts` | `55bcd5449bafa0e63de16ad5c4bfad8bac33c09c` |

Do not edit these six source files here. Make changes in VoiceLayer and re-pin
this copy. NarrationLayer's own projection will live outside this folder.

The ported test files differ from VoiceLayer's (import paths; in
`structured-display.test.ts` the tests below are removed), so they are NOT pinned
by blob id; only the six source files are.

These five tests stay whole in VoiceLayer: they test the size of VoiceLayer's
own socket event, which is VoiceLayer's wire format and not part of projection.

- `S3 keeps completed replay structure within the layout budget and drops oversized decoration`
- `retains complete preparing structure for 20 bullets`
- `retains complete preparing structure for 100 bullets`
- `keeps paused receipt identity and cursor within the frame when retained layout is oversized`
- `serializes bounded layout, dropping an oversized optional layout before any speech text`

In `tts-sections.test.ts`, the `conserves exact ranges for …` callback calls
`check(source, 7)` in a block body and returns nothing, as required by this
repository's Bun test types. Its name and assertions are unchanged.
