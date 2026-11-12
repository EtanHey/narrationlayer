// Invariant I-F: agent-facing surfaces are frozen and the entry points really start.
// tests/mcp-contract.test.ts already pins the tool names and contract == server list == docs/mcp-tools.json;
// this adds the input schemas, CLI verbs, the bin map, a real stdio session and a real build.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { NARRATION_MCP_TOOLS } from "../../src/contract.js";
import { readJson, ROOT } from "../../scripts/dev/boundaries.js";

type Snapshot = { mcpTools: { name: string; inputSchema: object }[]; cliVerbs: string[]; bin: Record<string, string> };
const snapshot = readJson<Snapshot>(path.join(ROOT, "tests/compat/surfaces.snapshot.generated.json"));
const BUN = process.execPath;

function scratchDir(label: string): string {
  mkdirSync(path.join(ROOT, "dist"), { recursive: true }); // dist/ is gitignored
  return mkdtempSync(path.join(ROOT, "dist", `.surfaces-${label}-`));
}

test("MCP tool names and input schemas match the frozen snapshot", () => {
  expect(NARRATION_MCP_TOOLS.map(({ name, inputSchema }) => ({ name, inputSchema })) as object[]).toEqual(snapshot.mcpTools);
});

test("CLI verbs in --help and in the dispatch switch match the frozen list", () => {
  const help = spawnSync(BUN, ["src/cli.ts", "--help"], { cwd: ROOT, encoding: "utf8" });
  expect(help.status).toBe(0);
  expect([...help.stdout.matchAll(/^\s+narrationlayer ([a-z0-9-]+)/gm)].map((m) => m[1])).toEqual(snapshot.cliVerbs);
  const source = readFileSync(path.join(ROOT, "src/cli.ts"), "utf8");
  expect([...source.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]).sort()).toEqual([...snapshot.cliVerbs].sort());
});

test("package.json bin map matches the frozen snapshot", () => {
  expect(readJson<{ bin: unknown }>(path.join(ROOT, "package.json")).bin).toEqual(snapshot.bin);
});

test("the MCP server process completes initialize and tools/list over stdio", async () => {
  const dataDir = scratchDir("mcp");
  try {
    const proc = Bun.spawn([BUN, "src/mcp-server.ts"], {
      cwd: ROOT,
      env: { ...process.env, NARRATIONLAYER_DATA_DIR: dataDir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (msg: object) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "surfaces-test", version: "0" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const replies = out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(replies.find((r) => r.id === 1)?.result?.serverInfo?.name).toBe("narrationlayer-mcp");
    expect(replies.find((r) => r.id === 2)?.result?.tools?.map((t: { name: string }) => t.name)).toEqual(snapshot.mcpTools.map((t) => t.name));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("bun build src/cli.ts succeeds", () => {
  const outdir = scratchDir("build");
  try {
    const build = spawnSync(BUN, ["build", "src/cli.ts", "--outdir", outdir, "--target", "bun"], { cwd: ROOT, encoding: "utf8" });
    expect(build.stderr).not.toContain("error");
    expect(build.status).toBe(0);
    expect(existsSync(path.join(outdir, "cli.js"))).toBe(true);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
