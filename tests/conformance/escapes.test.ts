import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { trapped, reviewedSafe, verifyInventory } from "../../src/engine/conformance/inventory.js";
const root = resolve(import.meta.dir, "../..");
const entry = process.env.CONFORMANCE_ENTRY ?? resolve(root, "src/engine/conformance/entry.ts");
const scratch = resolve(root, "docs.local/s0b/escapes");
mkdirSync(scratch, { recursive: true });
async function run(source: string, extra: string[] = [], cwd?: string, relative = false) {
  const dir = mkdtempSync(resolve(scratch, "case-"));
  const file = resolve(dir, "binding.ts");
  writeFileSync(file, source.replaceAll("$MARKER", JSON.stringify(resolve(dir, "marker"))));
  try {
    const proc = Bun.spawn([process.execPath, entry, "--binding", relative ? "binding.ts" : file, ...extra], {
      cwd: relative ? dir : cwd ?? root, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr, report: JSON.parse(stdout), marker: existsSync(resolve(dir, "marker")) };
  } finally { rmSync(dir, { recursive: true }); }
}
const binding = (body: string) => `export default {name:'escape',create(){let work=Promise.resolve();return {send(){work=(async()=>{${body}})().catch(()=>{})},events:(async function*(){})(),async shutdown(){await work}}}}`;
const network: [string, string][] = [
  ["Bun.fetch", "await Bun.fetch('$URL')"],
  ["bun named fetch", "const {fetch}=await import('bun');await fetch('$URL')"],
  ["S3Client", "await new Bun.S3Client({endpoint:'$URL',bucket:'fixture',accessKeyId:'fixture',secretAccessKey:'fixture'}).file('x').text()"],
  ["Bun.s3", "await Bun.s3.file('x').text()"],
  ["ws callable default", "new (require('ws'))('$WS').on('error',()=>{})"],
  ["ws named constructor", "new (require('ws').WebSocket)('$WS').on('error',()=>{})"],
  ["undici.request", "await require('undici').request('$URL')"],
  ["undici.fetch", "await require('undici').fetch('$URL')"],
  ["_http_client.ClientRequest", "new (require('_http_client').ClientRequest)('$URL').on('error',()=>{}).end()"],
  ["Bun.SQL", "await new Bun.SQL('postgres://fixture:fixture@127.0.0.1:$PORT/fixture').connect()"],
  ["Bun.sql", "await Bun.sql`select 1`"],
  ["Bun.RedisClient", "await new Bun.RedisClient('redis://127.0.0.1:$PORT').connect()"],
  ["Bun.redis", "await Bun.redis.connect()"],
  ["Bun.udpSocket", "const s=await Bun.udpSocket({});s.send('127.0.0.1',$UDP,'fixture');s.close()"],
  ["Bun.dns.lookup", "await Bun.dns.lookup('localhost')"],
  ["node:dns", "require('node:dns').lookup('localhost',()=>{})"],
  ["node:dns/promises", "await require('node:dns/promises').lookup('localhost')"],
  ["http2", "require('node:http2').connect('$URL')"],
  ["unprefixed net", "require('net').connect({host:'127.0.0.1',port:$PORT})"],
  ["dynamic net import", "const n=await import('node:net');n.connect({host:'127.0.0.1',port:$PORT})"],
  ["_tls_wrap", "new (require('_tls_wrap').TLSSocket)()"],
  ["_http_agent", "new (require('_http_agent').Agent)().createConnection({host:'127.0.0.1',port:$PORT})"],
  ["globalAgent constructor", "new (require('http').globalAgent.constructor)().createConnection({host:'127.0.0.1',port:$PORT})"],
  ["Agent prototype", "const a=require('http').globalAgent;a.constructor.prototype.createConnection.call(a,{host:'127.0.0.1',port:$PORT})"],
  ["external Bun.fetch", "await Bun.fetch('http://conformance-fixture.invalid/fixture')"],
];
for (const [api, body] of network) test(`escape ${api}: CONF-03 red; no direct TCP/UDP effect`, async () => {
  let tcp = 0, packets = 0;
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { tcp++; socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); }, data() {}, error() {},
  } });
  const url = `http://127.0.0.1:${listener.port}/`;
  const udp = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data() { packets++; } } });
  try {
    const source = binding(body.replaceAll("$URL", url).replaceAll("$WS", url.replace("http:", "ws:")).replaceAll("$PORT", String(listener.port)).replaceAll("$UDP", String(udp.port)));
    const result = await run(source);
    expect(tcp).toBe(0); expect(packets).toBe(0);
    expect(result.code).toBe(1); expect(result.marker).toBe(false);
    expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-03").result).toBe("fail");
    if (api.includes("fetch") && !api.startsWith("undici")) expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-03").diagnostic).toBe("connection reached the parent's proxy listener");
  } finally { listener.stop(true); udp.close(); }
});
const clocks = [
  "await new Promise(r=>AbortSignal.timeout(5).addEventListener('abort',r))",
  "performance.mark('fixture').startTime", "performance.measure('fixture').duration", "performance.eventLoopUtilization()",
  "Object.getPrototypeOf(performance).now.call(performance)",
  "Reflect.get(Object.getPrototypeOf(performance),'timeOrigin',performance)",
  "require('node:os').uptime()", "Bun.randomUUIDv7()",
  "require('node:vm').runInNewContext('Date.now()')", "require('node:vm').runInThisContext('Date.now()')",
  "require('node:vm').compileFunction('return Date.now()')()", "new (require('node:vm').Script)('Date.now()').runInNewContext()",
];
if (Reflect.get(globalThis, "Temporal")) clocks.push("Temporal.Now.instant()");
for (const body of clocks) test(`escape ${body}: CONF-02 red`, async () => {
  const result = await run(binding(body));
  expect(result.code).toBe(1); expect(result.marker).toBe(false);
  expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-02").result).toBe("fail");
});
if ("execve" in process) test("execve cannot replace the child or create its marker", async () => {
  const result = await run(binding("process.execve(process.execPath,[process.execPath,'-e','require(\"fs\").writeFileSync('+JSON.stringify($MARKER)+',\"escaped\")'])"));
  expect(result.code).toBe(1); expect(result.marker).toBe(false);
  expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-04").result).toBe("fail");
});
test("reallyExit fake stdout cannot forge a report on the dedicated pipe", async () => {
  const fake = readFileSync(resolve(import.meta.dir, "report.snapshot.json"), "utf8");
  const result = await run(`process.stdout.write(${JSON.stringify(fake)});process.reallyExit(0);${binding("")}`);
  expect(result.code).toBe(1); expect(result.stderr).toContain(fake.trim());
  expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-01").diagnostic).toContain("process.reallyExit");
});
test("stdout logs and stderr are forwarded without corrupting the report", async () => {
  const result = await run(`console.log('fixture stdout');console.error('fixture stderr');${binding("")}`);
  expect(result.code).toBe(0); expect(result.stderr).toContain("fixture stdout"); expect(result.stderr).toContain("fixture stderr");
});
test("exit calls, late rejection, and dead children name their cause", async () => {
  for (const [body, message] of [["process.exit(0)", "process.exit"], ["queueMicrotask(()=>{Promise.reject(new Error('fixture'))})", "unhandledRejection"], ["process.kill(process.pid,'SIGKILL')", "child report unavailable"]]) {
    const result = await run(binding(body));
    expect(result.code).toBe(1);
    expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-01").diagnostic).toContain(message);
  }
});
test("a relative binding path belongs to the caller's cwd", async () => { expect((await run(binding(""), [], undefined, true)).code).toBe(0); });
test("inventory rejects a removed TRAPPED row and a new runtime key", () => {
  expect(() => verifyInventory([], ["net"], { ...trapped, modules: {} }, reviewedSafe)).toThrow("modules.net");
  Object.defineProperty(Bun, "conformanceUnknown", { value() {}, configurable: true });
  try { expect(() => verifyInventory()).toThrow("bun.conformanceUnknown"); }
  finally { Reflect.deleteProperty(Bun, "conformanceUnknown"); }
});
for (const body of [
  "const {spawnSync}=await import('bun');spawnSync([process.execPath,'-e','require(\"fs\").writeFileSync('+JSON.stringify($MARKER)+',\"escaped\")'])",
  "require('child_process').spawnSync(process.execPath,['-e','require(\"fs\").writeFileSync('+JSON.stringify($MARKER)+',\"escaped\")'])",
  "require('cluster').fork()", "new Worker('data:text/javascript,')",
]) test(`escape spawn alias ${body}: CONF-04 red; no marker`, async () => {
  const result = await run(binding(body));
  expect(result.code).toBe(1); expect(result.marker).toBe(false);
  expect(result.report.rows.find((r: { id: string }) => r.id === "CONF-04").result).toBe("fail");
});
test("internal child mode never exits zero, even for null binding", async () => {
  const proc = Bun.spawn([process.execPath, "--preload", resolve(root, "src/engine/conformance/preload.ts"), entry,
    "--child", "--binding", resolve(root, "src/engine/conformance/null-binding.ts")], {
    env: { ...process.env, NL_CONFORMANCE_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
  });
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).not.toBe(0);
});
