import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical, runConformance, validateRegistry, registry } from "./runner.js";
// Dedicated command module: nothing imports it (enforced under tests/conformance).
{
  const realExit = process.exit;
  let detachedFailure = false;
  process.on("unhandledRejection", () => { detachedFailure = true; process.exitCode = 1; process.stderr.write("conformance detached task failed\n"); });
  const deadline = setTimeout(() => { process.stderr.write("conformance run limit exceeded\n"); realExit(1); }, 30000);
  process.exit = () => { throw new Error("binding called process.exit"); };
  try {
    const args = process.argv.slice(2), bindingIndex = args.indexOf("--binding");
    const modulePath = args[bindingIndex + 1];
    if (bindingIndex < 0 || !modulePath || modulePath.startsWith("-") || args.filter(a => a === "--binding").length !== 1 || args.some((a, i) => i !== bindingIndex + 1 && !["--binding", "--exit", "--reverse"].includes(a))) throw new Error("invalid arguments");
    validateRegistry(registry);
    const { default: binding } = await import(pathToFileURL(resolve(modulePath)).href);
    if (!binding || typeof binding.name !== "string" || typeof binding.create !== "function") throw new Error("invalid binding");
    const report = await runConformance(binding, { reverse: args.includes("--reverse") });
    process.stdout.write(canonical(report));
    process.exitCode = detachedFailure || report.rows.some(r => r.result === "fail") || (args.includes("--exit") && report.inactive_engine > 0) ? 1 : 0;
  } catch { process.stderr.write("conformance invocation failed\n"); process.exitCode = 1; }
  finally { process.exit = realExit; clearTimeout(deadline); }
}
