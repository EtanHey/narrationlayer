import { expect, test } from "bun:test";
import { createArtifactStore, ArtifactStoreError, type ArtifactIdentity } from "../../../src/engine/artifacts/store";
import { createPublication, type PublicationContext } from "../../../src/engine/publication/publication";
import { pcmAudio } from "../../../src/engine/conformance/fake-backend";
const signal = new AbortController().signal, bytes = new Uint8Array([3, 7]);
const id: ArtifactIdentity = { owner_epoch: 1, session_id: "canary-session-cedar", attempt_id: "attempt", piece_id: "piece-0" };
const setup = () => { const port = new Map<string, Uint8Array>(); return { port, store: createArtifactStore(port, 1) }; };
test("D1: unique opaque handles, epochs and collision refusal", async () => {
  const { port, store } = setup(); port.set("memory:1:1", bytes);
  await expect(store.put(bytes, id, signal)).rejects.toMatchObject({ code: "collision" });
  expect(port.get("memory:1:1")).toBe(bytes);
  const a = await store.put(bytes, id, signal), other = createArtifactStore(port, 2);
  const b = await other.put(bytes, { ...id, owner_epoch: 2 }, signal);
  expect(a.handle).not.toBe(b.handle); expect(a.lease_id).not.toBe(b.lease_id);
  store.release(a.lease_id); expect((await store.put(bytes, id, signal)).handle).not.toBe(a.handle);
  await expect(store.put(bytes, { ...id, owner_epoch: 2 }, signal)).rejects.toMatchObject({ code: "owner" });
});
test("D2: session custody lists live leases in piece order and copies identity", async () => {
  const { store } = setup(), identity = { ...id };
  const a = await store.put(bytes, identity, signal); identity.session_id = "changed";
  await store.put(bytes, { ...id, session_id: "other" }, signal);
  const b = await store.put(bytes, { ...id, piece_id: "piece-1" }, signal);
  const list = store.leases(id.session_id); expect(list.map(x => x.piece_id)).toEqual(["piece-0", "piece-1"]);
  list[0].handle = "changed"; expect(store.leases(id.session_id)[0].handle).toBe(a.handle);
  store.release(a.lease_id); expect(store.leases(id.session_id).map(x => x.lease_id)).toEqual([b.lease_id]);
  expect(store.leases("other")).toHaveLength(1);
});
test("D3: only a live matching lease can delete bytes", async () => {
  const { port, store } = setup(), a = await store.put(bytes, id, signal);
  expect(store.release("unknown")).toEqual({ kind: "expired" }); expect(port.size).toBe(1);
  expect(store.release(a.lease_id)).toEqual({ kind: "released" }); expect(port.size).toBe(0);
  const b = await store.put(bytes, id, signal);
  expect(store.release(a.lease_id)).toEqual({ kind: "expired" }); expect(port.has(b.handle)).toBe(true);
});
test("D4: resolve copies on both sides and checks handle and lease", async () => {
  const { store } = setup(), input = bytes.slice(), a = await store.put(input, id, signal); input.fill(0);
  const result = store.resolve(a.handle, a.lease_id); expect(result.kind).toBe("resolved");
  if (result.kind === "resolved") { expect(result.bytes).toEqual(bytes); result.bytes.fill(0); }
  expect(store.resolve(a.handle, a.lease_id)).toEqual({ kind: "resolved", bytes });
  const b = await store.put(new Uint8Array([9]), id, signal);
  expect(store.resolve(b.handle, a.lease_id)).toEqual({ kind: "expired" });
  expect(store.resolve("wrong", a.lease_id)).toEqual({ kind: "expired" });
  expect(store.resolve(a.handle, "wrong")).toEqual({ kind: "expired" });
  store.release(a.lease_id); expect(store.resolve(a.handle, a.lease_id)).toEqual({ kind: "expired" });
});
test("D5: aborts and storage failures leave no bytes or lease", async () => {
  for (const stage of ["before", "has", "before-set", "after-set", "throw"]) {
    const map = new Map<string, Uint8Array>(), abort = new AbortController();
    const store = createArtifactStore({ has(h) { if (stage === "has") abort.abort(); return map.has(h); }, get: h => map.get(h), delete: h => map.delete(h),
      set(h, b) { if (stage === "before-set") abort.abort(); map.set(h, b); if (stage === "after-set") abort.abort(); if (stage === "throw") throw Error("canary-text-moss"); } }, 1);
    if (stage === "before") abort.abort("canary-text-moss");
    await expect(createPublication(store).piece(pcmAudio(4), context, abort.signal)).rejects.toThrow();
    expect(map.size).toBe(0); expect(store.leases(id.session_id)).toHaveLength(0);
  }
});
const context: PublicationContext = { ...id, index: 0, prefix: [], synthesis_ms: 1, spoken_text: "Invented moss", words: [], segments: 1, rate: "1", engine: { family: "edge", voice: "synthetic", profile_revision: "1" } };
test("D5 publication: abort after put and throw after put return the lease", async () => {
  for (const fail of ["abort", "throw"]) {
    const { port, store } = setup(), abort = new AbortController();
    const publication = createPublication({ ...store, async put(...args) { const a = await store.put(...args); if (fail === "abort") abort.abort(); return a; } });
    const c = { ...context }; if (fail === "throw") Object.defineProperty(c, "segments", { get() { throw Error("synthetic failure"); } });
    await expect(publication.piece(pcmAudio(4), c, abort.signal)).rejects.toThrow();
    expect(port.size).toBe(0); expect(store.leases(id.session_id)).toHaveLength(0);
  }
});
test("D6: seal refuses later puts only for that attempt; abort leaves it open", async () => {
  const { port, store } = setup(), a = await store.put(bytes, id, signal), abort = new AbortController(); abort.abort();
  await expect(store.commit(id, abort.signal)).rejects.toMatchObject({ code: "aborted" });
  await store.put(bytes, id, signal);
  const during = new AbortController(), sealing = store.commit(id, during.signal); during.abort(); await sealing;
  await expect(store.put(bytes, id, signal)).rejects.toMatchObject({ code: "sealed" });
  await store.put(bytes, { ...id, attempt_id: "next" }, signal); expect(port.has(a.handle)).toBe(true);
});
test("D7: shutdown keeps leases and allows their release, refuses new puts", async () => {
  const { port, store } = setup(), a = await store.put(bytes, id, signal); store.shutdown(); store.shutdown();
  expect(port.has(a.handle)).toBe(true); expect(store.leases(id.session_id)).toHaveLength(1);
  await expect(store.put(bytes, id, signal)).rejects.toMatchObject({ code: "shutdown" });
  expect(store.resolve(a.handle, a.lease_id).kind).toBe("resolved"); store.release(a.lease_id); expect(port.size).toBe(0);
});
test("privacy: handles, lease ids and errors contain no session or text canary", async () => {
  const canary = { ...context, spoken_text: "canary-text-moss" };
  const { store } = setup(), a = await store.put(bytes, canary, signal); await store.commit(id, signal);
  expect(JSON.stringify(store.leases(id.session_id))).not.toContain("canary-text-moss");
  let error: unknown; try { await store.put(bytes, id, signal); } catch (e) { error = e; }
  for (const value of [a.handle, a.lease_id, String(error), JSON.stringify(error), JSON.stringify(store.release("canary-text-moss"))]) {
    expect(value).not.toContain(id.session_id); expect(value).not.toContain("canary-text-moss");
  }
});
test("ART-01: 20000 seeded operation sequences agree with custody model", async () => {
  let seed = 0x195af031;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const start = performance.now();
  for (let sequence = 0; sequence < 20000; sequence++) {
    const { port, store } = setup(), model = new Map<string, string>();
    let closed = false, sealed = false;
    for (let step = 0; step < 12; step++) {
      const op = random() % 6;
      if (op < 2) { // put or abandoned put
        const abort = new AbortController(); if (op === 1) abort.abort();
        let result: Awaited<ReturnType<typeof store.put>> | undefined;
        try { result = await store.put(bytes, id, abort.signal); } catch (e) { if (!(e instanceof ArtifactStoreError)) throw e; }
        if (!!result !== (!closed && !sealed && op === 0)) throw Error("put model mismatch");
        if (result) model.set(result.lease_id, result.handle);
      } else if (op === 2) {
        const lease = random() % 2 ? [...model.keys()][0] ?? "missing" : "missing", handle = model.get(lease);
        const result = store.release(lease); if ((result.kind === "released") !== !!handle) throw Error("release model mismatch"); model.delete(lease);
      } else if (op === 3) { await store.commit(id, signal); sealed = true;
      } else if (op === 4) { store.shutdown(); closed = true;
      } else { const a = await store.put(bytes, { ...id, attempt_id: `abandon-${step}` }, signal).catch(() => undefined); if (a) store.release(a.lease_id); }
      if (port.size !== model.size || store.leases(id.session_id).length !== model.size) throw Error("custody size mismatch");
      for (const [lease, handle] of model) if (!port.has(handle) || store.resolve(handle, lease).kind !== "resolved") throw Error("live lease lost bytes");
    }
  }
  const elapsed = performance.now() - start; console.log(`ART-01: 20000 sequences in ${elapsed.toFixed(1)} ms`);
});

test("port failures: release retains custody and resolve sanitizes diagnostics", async () => {
  const map = new Map<string, Uint8Array>(); let broken = false;
  const store = createArtifactStore({ has: h => map.has(h), set: (h, b) => map.set(h, b),
    get(h) { if (broken) throw Error("canary-text-moss"); return map.get(h); },
    delete(h) { if (broken) throw Error("canary-text-moss"); return map.delete(h); } }, 1);
  const a = await store.put(bytes, id, signal); broken = true;
  expect(store.release(a.lease_id)).toEqual({ kind: "failed" }); expect(store.leases(id.session_id)).toHaveLength(1);
  expect(store.resolve(a.handle, a.lease_id)).toEqual({ kind: "failed" });
  broken = false; expect(store.release(a.lease_id)).toEqual({ kind: "released" }); expect(map.size).toBe(0);
});

test("D5 store: abort after set rolls back before a lease is issued", async () => {
  const map = new Map<string, Uint8Array>(), abort = new AbortController();
  const store = createArtifactStore({ has: h => map.has(h), get: h => map.get(h), delete: h => map.delete(h),
    set(h, b) { map.set(h, b); abort.abort(); } }, 1);
  await expect(store.put(bytes, id, abort.signal)).rejects.toMatchObject({ code: "aborted" });
  expect(map.size).toBe(0); expect(store.leases(id.session_id)).toHaveLength(0);
});
