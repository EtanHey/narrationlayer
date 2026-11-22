import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sandboxAvailable, sandboxCommand, sandboxProfile } from "../../src/engine/conformance/sandbox.js";
const root = resolve(import.meta.dir, "../..");
const scratch = resolve(root, "docs.local/s0c");
mkdirSync(scratch, { recursive: true });
const entry = resolve(root, "src/engine/conformance/entry.ts");
// The hosted macOS job cannot silently pass using only the tripwire.
test("hosted macOS requires containment", async () => {
  if (process.platform !== "darwin") return;
  expect(sandboxAvailable()).toBe(true);
  const p = Bun.spawn([process.execPath, entry, "--require-containment", "--binding", resolve(root, "src/engine/conformance/null-binding.ts")], {
    env: { ...process.env, NL_CONFORMANCE_REQUIRE_CONTAINMENT: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(err).toBe(""); expect(code).toBe(1); expect(JSON.parse(out).containment).toBe("macos-sandbox");
});
const macTest = process.platform === "darwin" ? test : test.skip;
for (const route of ["tcp", "udp", "unix", "dns", "bun-spawn", "node-spawn", "execSync", "worker-spawn"]) {
  macTest(`containment: untrapped ${route} denied; unsandboxed control succeeds`, async () => {
    const dir = mkdtempSync(resolve(scratch, "os-")), marker = resolve(dir, "marker");
    // Short socket name avoids Darwin's 104-byte sockaddr_un limit.
    const unix = resolve(root, "docs.local", `s${process.pid}${route.slice(0,3)}.sock`);
    let tcp = 0, packets = 0, sockets = 0;
    const sink = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.end(); }, data() {} } });
    const target = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { tcp++; s.end(); }, data() {} } });
    const local = Bun.listen({ unix, socket: { open() { sockets++; }, data(s) { s.end(); } } });
    const udp = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data(s, data, port, address) {
      packets++;
      // Minimal authoritative NXDOMAIN reply, entirely on loopback.
      const reply = Buffer.from(data); reply[2] = 0x81; reply[3] = 0x83; s.send(reply, port, address);
    } } });
    const childCode = `try{require('fs').writeFileSync(${JSON.stringify(marker)},'escaped')}catch{}`;
    const cmd = JSON.stringify([process.execPath, "-e", childCode]);
    const routes: Record<string, string> = {
      tcp: `await new Promise((ok,no)=>{const s=require('net').connect(${target.port},'127.0.0.1',()=>{s.end();ok()});s.on('error',no)})`,
      unix: `await new Promise((ok,no)=>{const s=require('net').connect(${JSON.stringify(unix)},()=>{s.write('fixture');s.end();ok()});s.on('error',no)})`,
      udp: `const s=await Bun.udpSocket({hostname:'127.0.0.1',port:0});try{s.send('fixture',${udp.port},'127.0.0.1')}finally{s.close()}`,
      dns: `const r=new (require('dns').promises.Resolver)({timeout:100,tries:1});r.setServers(['127.0.0.1:${udp.port}']);try{await r.resolve4('fixture.invalid')}catch(e){if(e.code!=='ENOTFOUND')throw e}`,
      "bun-spawn": `const p=Bun.spawn(${cmd});if(await p.exited)throw Error('spawn failed')`,
      "node-spawn": `await new Promise((ok,no)=>{const p=require('child_process').spawn(...[${cmd}[0],${cmd}.slice(1)]);p.on('error',no);p.on('exit',c=>c?no(Error('exit')):ok())})`,
      execSync: `require('child_process').execSync(${JSON.stringify([process.execPath, '-e', childCode].map(v => "'"+v.replaceAll("'", "'\"'\"'")+"'").join(' '))})`,
      "worker-spawn": `await new Promise((ok,no)=>{const w=new Worker('data:text/javascript;base64,'+btoa(${JSON.stringify(`try { const p=Bun.spawn(${cmd});await p.exited;postMessage('ok') } catch(e){postMessage(e.code+':'+e.message)}`)}));w.onmessage=e=>{w.terminate();e.data==='ok'?ok():no(Error(e.data))};w.onerror=no})`,
    };
    const source = resolve(dir, "probe.ts");
    writeFileSync(source, `try{${routes[route]};console.log('allowed')}catch(e){console.log(e.code+':'+e.message);process.exitCode=7}`);
    async function run(sandbox: boolean) {
      const command = [process.execPath, source];
      const p = Bun.spawn(sandbox ? sandboxCommand(command, sink.port) : command, { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { out, err, code };
    }
    try {
      const denied = await run(true);
      console.log(route, denied.out.trim()); expect(denied.code).toBe(7); expect(denied.out).not.toContain("allowed");
      if (route.includes("spawn")) expect(denied.out).toContain("EPERM");
      expect(tcp + packets + sockets).toBe(0); expect(existsSync(marker)).toBe(false);
      const control = await run(false);
      expect(control).toEqual({ out: "allowed\n", err: "", code: 0 });
      if (route === "tcp") expect(tcp).toBe(1);
      else if (route === "unix") expect(sockets).toBe(1);
      else if (route === "dns" || route === "udp") expect(packets).toBeGreaterThan(0);
      else expect(existsSync(marker)).toBe(true);
    } finally { sink.stop(true); target.stop(true); local.stop(true); rmSync(unix, { force: true }); udp.close(); rmSync(dir, { recursive: true }); }
  });
}
test("required containment fails closed when the resolver cannot find sandbox-exec", async () => {
  const dir = mkdtempSync(resolve(scratch, "missing-")), preload = resolve(dir, "missing.ts");
  writeFileSync(preload, `const fs=require('node:fs');const exists=fs.existsSync;fs.existsSync=p=>p==='/usr/bin/sandbox-exec'?false:exists(p)`);
  try {
    for (const extra of [["--require-containment"], []]) {
      const p = Bun.spawn([process.execPath, "--preload", preload, entry, "--binding", resolve(root, "src/engine/conformance/null-binding.ts"), ...extra], {
        env: { ...process.env, NL_CONFORMANCE_REQUIRE_CONTAINMENT: extra.length ? "0" : "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(1); expect(out).toBe(""); expect(err).toContain("required macOS containment unavailable");
    }
  } finally { rmSync(dir, { recursive: true }); }
});
for (const route of ["proxy", "unix", "env-assign", "env-delete", "no-proxy", "file-string", "write-string", "file-string-own", "write-string-own"]) {
  macTest(`full entry contains ${route}`, async () => {
    const dir = mkdtempSync(resolve(scratch, "entry-"));
    const unix = resolve(root, "docs.local", `f${process.pid}${route.slice(0,3)}.sock`);
    let arrivals = 0;
    const socket = { open(s: { end(data: string): void }) { arrivals++; s.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); }, data() {} };
    const tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket });
    const local = Bun.listen({ unix, socket });
    const url = JSON.stringify(`http://127.0.0.1:${tcp.port}`);
    const edits = `for(const env of [process.env,Bun.env])for(const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']){try{${route === "env-delete" ? 'delete env[k]' : 'env[k]='+url}}catch{}};try{process.env.NO_PROXY='*'}catch{}`;
    const boxed = route.endsWith("-own") ? `Object.assign(new String('s3://fixture/key'),{n:0,toString(){return this.n++?'s3://fixture/key':'fixture-local'}})` : `new String('s3://fixture/key')`;
    const options = `{endpoint:${url},accessKeyId:'fixture',secretAccessKey:'fixture'}`;
    const remoteFile = route.startsWith("file") ? `Bun.file(${boxed},${options}).text()` : `Bun.write(${boxed},'fixture',${options})`;
    const action = route === "proxy" ? `await Bun.fetch(${url},{proxy:${url}})` : route === "unix" ? `await Bun.fetch(${url},{unix:${JSON.stringify(unix)}})` : route.includes("string") ? `${edits};await ${remoteFile}` : `${edits};await Bun.fetch(${url})`;
    const file = resolve(dir, "binding.ts");
    writeFileSync(file, `export default {name:'escape',create(){let p;return {send(){p=(async()=>{${action}})().catch(()=>{})},events:(async function*(){})(),async shutdown(){await p}}}}`);
    try {
      const p = Bun.spawn([process.execPath, entry, "--require-containment", "--binding", file], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(arrivals).toBe(0); expect(err).toBe(""); expect(JSON.parse(out).containment).toBe("macos-sandbox");
      // Kernel-denied calls caught by a binding need not be tripwire-red.
      if (route.includes("string")) expect(out).toContain("remote scheme");
    } finally { tcp.stop(true); local.stop(true); rmSync(unix, { force: true }); rmSync(dir, { recursive: true }); }
  });
}
macTest("containment permits parent's port but refuses a second loopback port, including after same-image exec", async () => {
  let sinkArrivals = 0, outsideArrivals = 0;
  const sink = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { sinkArrivals++; s.end(); }, data() {} } });
  const outside = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { outsideArrivals++; s.end(); }, data() {} } });
  const ipv6 = Bun.listen({ hostname: "::1", port: sink.port, socket: { open(s) { outsideArrivals++; s.end(); }, data() {} } });
  const dir = mkdtempSync(resolve(scratch, "exec-"));
  const check = `const net=require('net');
    async function connect(port,host='127.0.0.1'){return new Promise((ok,no)=>{const s=net.connect(port,host,()=>{s.end();ok()});s.on('error',no)})}
    await connect(${sink.port});
    try{await connect(${outside.port});throw Error('escaped')}catch(e){if(e.code!=='ECONNREFUSED')throw e}
    try{await connect(${sink.port},'::1');throw Error('IPv6 escaped')}catch(e){if(e.code!=='ECONNREFUSED')throw e}
    try{Bun.spawn([process.execPath,'-e','']) ;throw Error('spawn escaped')}catch(e){if(e.code!=='EPERM')throw e}
    console.log('port-specific; spawn denied')`;
  try {
    for (const replacement of [false, ...("execve" in process ? [true] : [])]) {
      const file = resolve(dir, "exec.ts");
      writeFileSync(file, replacement ? `process.execve(process.execPath,[process.execPath,'-e',${JSON.stringify(check)}],process.env)` : check);
      const p = Bun.spawn(sandboxCommand([process.execPath, file], sink.port), { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect({ out, err, code }).toEqual({ out: "port-specific; spawn denied\n", err: "", code: 0 });
      expect(outsideArrivals).toBe(0);
    }
    expect(sinkArrivals).toBe("execve" in process ? 2 : 1);
    if ("execve" in process) {
      const p = Bun.spawn(sandboxCommand([process.execPath, "-e", `try{process.execve('/usr/bin/true',['true'],process.env)}catch(e){console.log(e.code);process.exit(7)}`], sink.port), { stdout: "pipe", stderr: "pipe" });
      const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(code).toBe(7); expect(out).toContain("EPERM");
    }
  } finally { sink.stop(true); outside.stop(true); ipv6.stop(true); rmSync(dir, { recursive: true }); }
});
macTest("child reports clean=3 and trapped exit=1 on dedicated fd3", async () => {
  const dir = mkdtempSync(resolve(scratch, "exit-")), file = resolve(dir, "binding.ts");
  try {
    for (const [action, code] of [["", 3], ["process.exit(0)", 1]] as const) {
      writeFileSync(file, `export default {name:'exit',create(){return {send(){${action}},events:(async function*(){})(),async shutdown(){}}}}`);
      const p = Bun.spawn(sandboxCommand([process.execPath, "--preload", resolve(root, "src/engine/conformance/preload.ts"), entry, "--child", "--binding", file], 1), {
        env: { ...process.env, NL_CONFORMANCE_CHILD: "1", NL_CONFORMANCE_CONTAINMENT: "macos-sandbox" }, stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const pipe = p.stdio[3];
      if (!pipe) throw Error("missing report pipe");
      const [report, , , exit] = await Promise.all([typeof pipe === "number" ? Bun.file(pipe).text() : new Response(pipe).text(), new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(exit).toBe(code); expect(JSON.parse(report).containment).toBe("macos-sandbox");
    }
  } finally { rmSync(dir, { recursive: true }); }
});
test("platform snapshots differ only in their explicit containment value", () => {
  const tripwire = JSON.parse(readFileSync(resolve(import.meta.dir, "report.snapshot.json"), "utf8"));
  const sandbox = JSON.parse(readFileSync(resolve(import.meta.dir, "report.macos-sandbox.snapshot.json"), "utf8"));
  expect(tripwire.containment).toBe("in-process-tripwire"); expect(sandbox.containment).toBe("macos-sandbox");
  expect({ ...tripwire, containment: "macos-sandbox" }).toEqual(sandbox);
});
const services = ["com.apple.dnssd.service", "com.apple.coreservices.launchservicesd", "com.apple.coreservices.appleevents"];
for (const route of [...services, "file-write", "signal"]) macTest(`containment: untrapped ${route} denied with successful control`, async () => {
  const dir = mkdtempSync(resolve(scratch, "boundary-")), file = resolve(dir, "probe.ts"), marker = resolve(dir, "marker");
  // Own a live target; signal 0 only tests permission, never delivers a signal.
  const target = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  const lookup = `const {dlopen,ptr}=require('bun:ffi');
    const k=dlopen('/usr/lib/libSystem.B.dylib',{task_self_trap:{args:[],returns:'u32'},task_get_special_port:{args:['u32','i32','ptr'],returns:'i32'},bootstrap_look_up:{args:['u32','ptr','ptr'],returns:'i32'}});
    const bp=new Uint32Array(1),out=new Uint32Array(1);if(k.symbols.task_get_special_port(k.symbols.task_self_trap(),4,ptr(bp)))throw Error('bootstrap port unavailable');
    const status=k.symbols.bootstrap_look_up(bp[0],ptr(Buffer.concat([Buffer.from(${JSON.stringify(route)}),Buffer.from([0])])),ptr(out));
    console.log('lookup='+status);if(status!==0)process.exit(7);if(!out[0])throw Error('missing send right');`;
  const body = route === "signal" ? `process.kill(${target.pid},0)` : route === "file-write" ? `require('fs').writeFileSync(${JSON.stringify(marker)},'fixture')` : lookup;
  writeFileSync(file, `try{${body};console.log('allowed')}catch(e){console.log(e.code);process.exitCode=7}`);
  try {
    for (const contained of [true, false]) {
      const command = [process.execPath, file];
      const p = Bun.spawn(contained ? sandboxCommand(command, 1) : command, { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      console.log(route, contained ? "sandbox" : "control", out.trim());
      expect(err).toBe(""); expect(code).toBe(contained ? 7 : 0);
      expect(out).toContain(route.startsWith("com.apple.") ? `lookup=${contained ? 1100 : 0}` : contained ? "EPERM" : "allowed");
      expect(existsSync(marker)).toBe(route === "file-write" && !contained);
    }
  } finally { target.kill(); await target.exited; rmSync(dir, { recursive: true }); }
});
macTest("native addon loading is a spawn tripwire before calling dlopen", async () => {
  const dir = mkdtempSync(resolve(scratch, "native-")), file = resolve(dir, "binding.ts");
  writeFileSync(file, `export default {name:'native',create(){return {send(){try{process.dlopen({exports:{}},'/usr/lib/libSystem.B.dylib')}catch{}},events:(async function*(){})(),async shutdown(){}}}}`);
  try {
    const p = Bun.spawn([process.execPath, entry, "--binding", file], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(1); expect(err).toBe(""); expect(JSON.parse(out).rows.find((r: { id: string }) => r.id === "CONF-04")).toMatchObject({ result: "fail", diagnostic: "forbidden APIs: process.dlopen" });
  } finally { rmSync(dir, { recursive: true }); }
});
