import { expect, test } from "bun:test";
import { Qwen3DaemonError, synthesizeQwen3 } from "../src/backends/qwen3-daemon.js";
import { fixture } from "./compat/harness.js";

async function setup() {
  const f = await fixture();
  const request = (overrides: Partial<Parameters<typeof synthesizeQwen3>[0]> = {}) => synthesizeQwen3({
    url: `${f.url}/synthesize`, authToken: "synthetic-token", timeoutMs: 5000,
    body: { text: "Synthetic speech.", reference_wav: "reference.wav", reference_text: "Synthetic reference." },
    ...overrides,
  });
  return { f, request };
}

async function failureOf(promise: Promise<unknown>) {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(Qwen3DaemonError);
    if (error instanceof Qwen3DaemonError) return error.failure;
    throw error;
  }
  throw new Error("Expected daemon failure");
}

test("daemon client sends the supplied URL, bearer and body; names generation and audio time separately", async () => {
  const { f, request } = await setup();
  try {
    const result = await request();
    expect(Buffer.from(result.audioBase64, "base64")).toEqual(f.wav);
    expect(result.elapsedGenerationMs).toBe(7);
    expect(result.audioDurationMs).toBe(200);
    expect(f.requests).toEqual([{
      method: "POST", url: `${f.url}/synthesize`,
      headers: { "content-type": "application/json", authorization: "Bearer synthetic-token" },
      body: { text: "Synthetic speech.", reference_wav: "reference.wav", reference_text: "Synthetic reference." },
    }]);
  } finally { await f.close(); }
});

test.each(["http", "malformed"] as const)("daemon client classifies %s without caller policy", async (mode) => {
  const { f, request } = await setup();
  try {
    f.setMode(mode);
    expect(await failureOf(request())).toEqual(mode === "http"
      ? { kind: "http", status: 500, body: "synthetic failure", statusText: "Internal Server Error" }
      : { kind: "missing-audio", payload: {} });
  } finally { await f.close(); }
});

test.each(["timeout", "abort"] as const)("daemon client preserves the %s cause", async (kind) => {
  const { f, request } = await setup();
  try {
    f.setMode("timeout");
    const controller = new AbortController();
    const pending = failureOf(request({ timeoutMs: kind === "timeout" ? 20 : 5000, signal: controller.signal }));
    if (kind === "abort") controller.abort();
    const failure = await pending;
    expect(failure.kind).toBe(kind);
    if (!("cause" in failure)) throw new Error("Missing transport cause");
    expect(failure.cause).toBeInstanceOf(Error);
    if (!(failure.cause instanceof Error)) throw new Error("Missing abort error");
    expect(failure.cause.name).toBe("AbortError");
  } finally { await f.close(); }
});

test("daemon client accepts injected fetch and preserves malformed JSON, network, and null causes", async () => {
  const { f, request } = await setup();
  try {
    const cause = new Error("synthetic network failure");
    expect(await failureOf(request({ fetchImpl: async () => { throw cause; } }))).toEqual({ kind: "network", cause });
    for (const body of ["not json", "null"]) {
      const failure = await failureOf(request({ fetchImpl: async () => new Response(body) }));
      expect(failure.kind).toBe("malformed-json");
      if (!("cause" in failure)) throw new Error("Missing malformed body cause");
      expect(failure.cause).toBeInstanceOf(body === "null" ? TypeError : SyntaxError);
    }
  } finally { await f.close(); }
});

test("daemon client clears timeout after headers, as both legacy callers did", async () => {
  const { f, request } = await setup();
  try {
    const result = await request({ timeoutMs: 1, fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        setTimeout(() => {
          expect(init?.signal?.aborted).toBe(false);
          stream.enqueue(new TextEncoder().encode('{"audio_b64":"YQ=="}'));
          stream.close();
        }, 20);
      },
    })) });
    expect(result.audioBase64).toBe("YQ==");
  } finally { await f.close(); }
});

test("daemon client honors explicit abort while reading the response body", async () => {
  const { f, request } = await setup();
  try {
    const controller = new AbortController();
    const failure = await failureOf(request({ signal: controller.signal, fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), { once: true });
        setTimeout(() => controller.abort(), 10);
      },
    })) }));
    expect(failure.kind).toBe("abort");
    if (!("cause" in failure)) throw new Error("Missing abort cause");
    expect(failure.cause).toBe(controller.signal.reason);
  } finally { await f.close(); }
});
