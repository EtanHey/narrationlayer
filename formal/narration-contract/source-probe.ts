import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const [source, dataDir] = process.argv.slice(2);
const store: typeof import("../../src/job-store.ts") = await import(fileURLToPath(new URL(source)));
const job = "public-fixture";
const paths = store.pathsForJob(job, dataDir);
await mkdir(paths.jobDir, { recursive: true });
const observations: { done: boolean; failed: boolean }[] = [];
for (const publish of [store.markFailed, store.markDone, store.markFailed]) {
  await publish(job, dataDir);
  observations.push({ done: await store.fileExists(paths.donePath), failed: await store.fileExists(paths.failedPath) });
}
await Bun.write(join(dataDir, "observations.json"), JSON.stringify(observations));
