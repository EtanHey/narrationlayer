import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical, runConformance, validateRegistry, registry } from "./runner.js";
// One process-wide watchdog, including binding import; never part of the report.
{
  const deadline = setTimeout(() => { process.stderr.write("conformance run limit exceeded\n"); process.exit(1); }, 30000);
  try {
    const args = process.argv.slice(2);
    const modulePath = args[args.indexOf("--binding") + 1];
    if (!args.includes("--binding") || !modulePath || modulePath.startsWith("--") || args.some((a, i) => a.startsWith("--") && !["--binding", "--exit", "--reverse"].includes(a))) throw new Error("invalid arguments");
    validateRegistry(registry);
    const { default: binding } = await import(pathToFileURL(resolve(modulePath)).href);
    if (!binding || typeof binding.name !== "string" || typeof binding.create !== "function") throw new Error("invalid binding");
    const report = await runConformance(binding, { reverse: args.includes("--reverse") });
    process.stdout.write(canonical(report));
    process.exitCode = report.rows.some(r => r.result === "fail") || (args.includes("--exit") && report.inactive_engine > 0) ? 1 : 0;
  } catch { process.stderr.write("conformance invocation failed\n"); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
