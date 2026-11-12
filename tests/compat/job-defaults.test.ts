import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProfiles, qwenConfigFromProfile } from "../../src/profiles.js";
import { createJobFromPayload, renderJob } from "../../src/service.js";
import { argvLog, fixture, golden, withEnv, wrappers } from "./harness.js";

test("job defaults: gain-only profile uses the default EQ corner", async () => {
  const f = await fixture(true);
  try {
    const wrapperPath = await wrappers(f.root);
    const profileFile = path.join(f.root, "profiles.yaml");
    await writeFile(profileFile, `profiles:\n  - id: compat-eq-default\n    accepted: true\n    renderer: voicelayer-qwen3\n    profile_version: synthetic-v1\n    render:\n      reference_clip: ${f.root}/reference.wav\n      reference_text: Synthetic reference.\n      daemon_url: ${f.url}\n      auth_token_file: ${f.root}/auth\n      eq_highshelf_gain_db: 3\n      timing_backend: none\n`);
    const dataDir = path.join(f.root, "data");
    await createJobFromPayload({ job_id: "compat-eq-job", renderer: "voicelayer-qwen3", voice_profile: "compat-eq-default",
      segments: [{ id: "segment", title: "Synthetic EQ", script: "Hello", duration_seconds: 1 }] }, dataDir);
    const result = await withEnv({ PATH: `${wrapperPath}${path.delimiter}${process.env.PATH}`,
      COMPAT_ARGV: path.join(f.root, "argv.jsonl"), NARRATIONLAYER_PROFILES_FILE: profileFile }, async () => {
      const profile = (await loadProfiles(f.root)).find(profile => profile.id === "compat-eq-default");
      expect(profile).toBeDefined();
      const qwen = qwenConfigFromProfile(profile);
      expect(qwen.eq_highshelf_gain_db).toBe(3);
      expect(qwen.eq_highshelf_hz).toBeUndefined();
      return renderJob("compat-eq-job", dataDir, { qwen: { ...qwen, timeout_ms: 10000,
        narrationlayer_commit: "f7faa86717f697bf79847eb981da2c3fb1279b67" }, external: {} });
    });
    expect(result.manifest.segments).toHaveLength(1);
    const argv = await argvLog(f.root);
    await golden("job-defaults-gain-only", f.canonical({ argv, requests: f.requests }));
  } finally { await f.close(); }
}, 30000);
