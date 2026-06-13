# Local Voice Profile Template

Keep real reference audio, transcripts, tokens, and cloned-voice source material
outside git. Put private profile entries in ignored `profiles.local.yaml` or a
file referenced by `NARRATIONLAYER_PROFILES_FILE`.

```yaml
profiles:
  - id: private-local-reader
    name: Private Local Reader
    renderer: voicelayer-qwen3
    voice_profile:
      id: private-local-reader
      language: en-US
    render:
      engine: voicelayer-qwen3
      daemon_url: http://127.0.0.1:8880
      timeout_ms: 120000
      auth_token_file: ~/.voicelayer/daemon.secret
      timing_backend: whisper-cli
      pause_strategy: punctuation
      max_utterance_words: 24
      min_utterance_words: 3
      sentence_pause_seconds: 0.65
      comma_pause_seconds: 0.25
      trim_silence: true
      silence_threshold_db: -45
      silence_padding_seconds: 0.18
      repair_word_timings: true
      max_chunk_duration_seconds: 45
      max_chunk_seconds_per_word: 3
      max_chunk_retries: 1
      reference_clip: /absolute/path/to/private/reference.wav
      reference_text_path: /absolute/path/to/private/reference.txt
```

The profile id is public-safe; the referenced files are not.

For F5-TTS MLX, IndexTTS2, VoxCPM2, or another local runner, keep the runner
path private and use the generic command adapter:

```yaml
profiles:
  - id: private-f5-bakeoff
    name: Private F5 Bakeoff
    renderer: external-command
    voice_profile:
      id: private-f5-bakeoff
      language: en-US
    render:
      engine: external-command
      command: /absolute/path/to/private/runner
      args:
        - --text
        - "{script}"
        - --output
        - "{output_path}"
        - --reference
        - "{reference_clip}"
      timeout_ms: 120000
      output_ext: wav
      timing_backend: estimated
      reference_clip: /absolute/path/to/private/reference.wav
```

Only use reference media you have rights or authorization to use. The public
repo should stay neutral and legitimate-use oriented; private profiles decide
which local media and adapters are available on a given machine.
