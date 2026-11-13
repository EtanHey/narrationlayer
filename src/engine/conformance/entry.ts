// Importing the packaged command has no effects.
if (import.meta.main) {
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { writeFileSync } = await import("node:fs");
  const { canonical, runConformance, validateRegistry, registry } = await import("./runner.js");
  const { default: nullBinding } = await import("./null-binding.js");
  const { trapState, trapsPresent } = await import("./wall-guard.js");
  type Report = Awaited<ReturnType<typeof runConformance>>;
  const CLEAN_CHILD = 3;
  const args = process.argv.slice(2);
  const index = args.indexOf("--binding"), modulePath = args[index + 1];
  const child = args.includes("--child"), reverse = args.includes("--reverse");
  const root = resolve(import.meta.dir, "../../..");
  const diagnostic = (report: Report, id: string, message: string) => {
    const row = report.rows.find(r => r.id === id);
    if (row) { row.result = "fail"; Object.assign(row, { diagnostic: message }); }
  };
  try {
    const known = ["--binding", "--exit", "--reverse", "--child"];
    const badArgument = args.some((a, i) => i !== index + 1 && !known.includes(a));
    const oneBinding = args.filter(a => a === "--binding").length === 1;
    if (index < 0 || !modulePath || modulePath.startsWith("-") || !oneBinding || badArgument) throw new Error("invalid arguments");
    if (child && process.env.NL_CONFORMANCE_CHILD !== "1") throw new Error("internal mode");
    validateRegistry(registry);
    if (child) {
      let report: Report;
      try {
        if (!trapsPresent()) throw new Error("traps absent");
        const { default: binding } = await import(pathToFileURL(modulePath).href);
        if (!binding || typeof binding.name !== "string" || typeof binding.create !== "function") throw new Error("invalid binding");
        report = await runConformance(binding, { reverse });
      } catch {
        report = await runConformance(nullBinding);
        diagnostic(report, "CONF-01", "binding import or conformance invocation failed");
        process.exitCode = 1;
      }
      // Publish at exit, after detached rejections have been delivered. Logs use
      // stdout/stderr; only this dedicated pipe carries a report to the parent.
      const invocationFailed = process.exitCode === 1 && !trapState.violations.length;
      process.on("exit", () => {
        const exits = trapState.violations.filter(v => v.kind === "exit");
        if (exits.length) diagnostic(report, "CONF-01", `forbidden APIs: ${[...new Set(exits.map(v => v.api))].sort().join(", ")}`);
        const fatal = exits.length || invocationFailed;
        process.exitCode = fatal ? 1 : CLEAN_CHILD;
        try { writeFileSync(3, canonical(report)); }
        catch { process.stderr.write("conformance report pipe unavailable\n"); process.exitCode = 1; }
      });
      process.exitCode = CLEAN_CHILD;
    } else {
      const absoluteBinding = resolve(process.cwd(), modulePath);
      let connections = 0;
      // Parent alone uses real I/O: two children, one loopback proxy listener.
      const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
        open(socket) { connections++; socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); },
        data() {}, error() {},
      } });
      try {
        const proxy = `http://127.0.0.1:${listener.port}`;
        const env = { ...process.env, NL_CONFORMANCE_CHILD: "1", NO_PROXY: "", no_proxy: "",
          HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
          http_proxy: proxy, https_proxy: proxy, all_proxy: proxy };
        const run = async (reversed: boolean) => {
          const command = [process.execPath, "--preload", resolve(import.meta.dir, "preload.ts"), import.meta.path,
            "--child", "--binding", absoluteBinding, ...(reversed ? ["--reverse"] : [])];
          const timeout = Number(process.env.NL_CONFORMANCE_WATCHDOG_MS ?? 1500);
          if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1500) throw new Error("invalid watchdog");
          const proc = Bun.spawn(command, { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const expired = new Promise<null>(resolve => {
            deadline = setTimeout(() => { proc.kill(9); resolve(null); }, timeout);
          });
          const pipe = proc.stdio[3];
          try {
            if (!pipe) throw new Error("report pipe missing");
            const readReport = typeof pipe === "number" ? Bun.file(pipe).text() : new Response(pipe).text();
            const completed = await Promise.race([Promise.all([
              readReport, new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
            ]), expired]);
            if (!completed) return { bytes: "", report: undefined, code: -1,
              error: "child watchdog expired before report/log streams completed" };
            const [bytes, stdout, stderr, code] = completed;
            process.stderr.write(stdout + stderr);
            let report: Report | undefined;
            let error = "child report unavailable";
            try {
              const parsed = JSON.parse(bytes);
              const expected = [...registry].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
              const metadata = ["id", "side", "stage", "owner_slice"] as const;
              const validRows = Array.isArray(parsed.rows) && parsed.rows.length === expected.length &&
                expected.every((row, i) => {
                  const got = parsed.rows[i];
                  return got && got.active === row.active && metadata.every(key => got[key] === row[key]) &&
                    (row.active ? ["pass", "fail"].includes(got.result) : got.result === "inactive") &&
                    Number.isInteger(got.assertions) && got.assertions >= 0;
                });
              if (parsed.schema !== "nl.conformance/1" || parsed.containment !== "in-process-tripwire") error = "child report schema mismatch";
              else if (!validRows) error = "child report registry mismatch (ids, order, metadata or activation)";
              else report = parsed;
            } catch { /* Missing/invalid reports become a named failure below. */ }
            return { bytes, report, code, error };
          } finally {
            clearTimeout(deadline);
            // Bun owns stdio[3] and closes it when the subprocess is collected.
            // Closing the raw fd here lets that finalizer close a reused fd.
          }
        };
        const first = await run(reverse), second = await run(!reverse);
        const report = first.report ?? second.report ?? await runConformance(nullBinding);
        if (!first.report && !second.report) {
          report.binding = "unavailable";
          for (const row of report.rows.filter(r => r.result !== "inactive")) {
            row.assertions = 0;
            diagnostic(report, row.id, "child report unavailable");
          }
        }
        const parseable = Boolean(first.report && second.report);
        const clean = first.code === CLEAN_CHILD && second.code === CLEAN_CHILD;
        const equal = first.bytes === second.bytes;
        const row = report.rows.find(r => r.id === "CONF-01");
        if (!row) throw new Error("missing CONF-01");
        row.result = parseable && clean && equal ? "pass" : "fail";
        if (row.result === "pass") Reflect.deleteProperty(row, "diagnostic");
        else if (!parseable) diagnostic(report, "CONF-01", `${first.report ? second.error : first.error}; child exited ${first.code}, ${second.code}`);
        else if (!clean && !("diagnostic" in row && String(row.diagnostic).startsWith("forbidden APIs:"))) diagnostic(report, "CONF-01", `child did not complete cleanly; child exited ${first.code}, ${second.code}`);
        else if (!equal) diagnostic(report, "CONF-01", "independent child reports differ");
        if (connections) diagnostic(report, "CONF-03", "connection reached the parent's proxy listener");
        writeFileSync(1, canonical(report));
        const failedCase = report.rows.some(r => r.result === "fail");
        const incomplete = args.includes("--exit") && report.inactive_engine > 0;
        process.exitCode = failedCase || incomplete ? 1 : 0;
      } finally { listener.stop(true); }
      // Stream reads can remain pending after a deadline. The listener is closed;
      // terminate the owned CLI after publishing the bounded verdict.
      process.exit(process.exitCode ?? 1);
    }
  } catch { process.stderr.write("conformance invocation failed\n"); process.exitCode = 1; }
}
export {};
