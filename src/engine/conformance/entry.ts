// All imports and effects stay inside the guard: importing this file is harmless.
if (import.meta.main) {
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { canonical, runConformance, validateRegistry, registry } = await import("./runner.js");
  const { trapState } = await import("./wall-guard.js");
  const root = resolve(import.meta.dir, "../../..");
  const args = process.argv.slice(2), index = args.indexOf("--binding"), modulePath = args[index + 1];
  const child = args.includes("--child"), reverse = args.includes("--reverse");
  try {
    if (index < 0 || !modulePath || modulePath.startsWith("-") || args.filter(a => a === "--binding").length !== 1 || args.some((a, i) => i !== index + 1 && !["--binding", "--exit", "--reverse", "--child"].includes(a))) throw new Error("invalid arguments");
    if (child && process.env.NL_CONFORMANCE_CHILD !== "1") throw new Error("internal mode");
    validateRegistry(registry);
    if (child) {
      if (!trapState.installed) throw new Error("traps absent");
      const { default: binding } = await import(pathToFileURL(resolve(root, modulePath)).href);
      if (!binding || typeof binding.name !== "string" || typeof binding.create !== "function") throw new Error("invalid binding");
      const report = await runConformance(binding, { reverse });
      process.stdout.write(canonical(report));
      process.on("exit", () => { if (trapState.violations.length || trapState.failures.length || report.rows.some(r => r.result === "fail" && r.id !== "CONF-01")) process.exitCode = 1; });
      process.exitCode = report.rows.some(r => r.result === "fail" && r.id !== "CONF-01") || trapState.violations.length || trapState.failures.length ? 1 : 0;
    } else {
      // Parent alone spawns; the binding never loads here. Both children start with traps.
      const run = async (reversed: boolean) => {
        const proc = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "preload.ts"), import.meta.path, "--child", "--binding", modulePath, ...(reversed ? ["--reverse"] : [])], { cwd: root, env: { ...process.env, NL_CONFORMANCE_CHILD: "1" }, stdout: "pipe", stderr: "pipe" });
        const deadline = setTimeout(() => proc.kill(), 30000);
        try { const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]); return { stdout, stderr, code }; }
        finally { clearTimeout(deadline); }
      };
      const first = await run(reverse), second = await run(!reverse);
      const report: Awaited<ReturnType<typeof runConformance>> = JSON.parse(first.stdout);
      const row = report.rows.find(r => r.id === "CONF-01");
      if (!row) throw new Error("missing CONF-01");
      row.result = first.stdout === second.stdout && first.code === 0 && second.code === 0 && "diagnostic" in row && row.diagnostic === "two-process comparison required" ? "pass" : "fail";
      Reflect.deleteProperty(row, "diagnostic");
      process.stdout.write(canonical(report));
      process.exitCode = first.code || second.code || report.rows.some(r => r.result === "fail") || (args.includes("--exit") && report.inactive_engine > 0) ? 1 : 0;
    }
  } catch { process.stderr.write("conformance invocation failed\n"); process.exitCode = 1; }
}
export {};
