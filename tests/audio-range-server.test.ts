import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

// A browser populates `audio.seekable` (and therefore allows word-click seeking /
// scrubbing) only when the audio server honors HTTP Range requests. This test
// pins that contract with a reference range-capable server: a request with a
// Range header must get 206 + Content-Range + Accept-Ranges and the requested
// slice; a request without one gets the whole body but still advertises ranges.
//
// This is the deterministic, RAM-light half of the seek verification. The
// browser-level half (assert audio.seekable.length > 0 in a real browser) is
// staged in tests/realbrowser/seek-realbrowser.mjs to run only when the box's
// ML stack is idle.

const BODY = Buffer.from("0123456789ABCDEFGHIJ"); // 20 bytes of known audio bytes
let dataDir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

function rangeCapableHandler(req: Request): Response {
  const total = BODY.length;
  const range = req.headers.get("range");
  if (!range) {
    return new Response(BODY, {
      status: 200,
      headers: { "Accept-Ranges": "bytes", "Content-Length": String(total) },
    });
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match && match[1] ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : total - 1;
  const slice = BODY.subarray(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(slice.length),
    },
  });
}

beforeAll(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "nl-range-"));
  writeFileSync(path.join(dataDir, "seg.bin"), BODY);
  server = Bun.serve({ port: 0, fetch: rangeCapableHandler });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

test("range request yields 206 + Content-Range + the requested slice", async () => {
  const res = await fetch(`${base}/seg.bin`, {
    headers: { Range: "bytes=0-3" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("accept-ranges")).toBe("bytes");
  expect(res.headers.get("content-range")).toBe("bytes 0-3/20");
  expect(await res.text()).toBe("0123"); // exactly the 4 requested bytes
});

test("a later range (seek) returns the right slice, not the start", async () => {
  const res = await fetch(`${base}/seg.bin`, {
    headers: { Range: "bytes=10-14" },
  });
  expect(res.status).toBe(206);
  expect(res.headers.get("content-range")).toBe("bytes 10-14/20");
  expect(await res.text()).toBe("ABCDE");
});

test("no Range header returns the full body but still advertises ranges", async () => {
  const res = await fetch(`${base}/seg.bin`);
  expect(res.status).toBe(200);
  expect(res.headers.get("accept-ranges")).toBe("bytes"); // tells the browser it can seek
  expect((await res.text()).length).toBe(20);
});
