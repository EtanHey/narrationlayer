import { expect, test } from "bun:test";

import { NARRATION_MCP_TOOLS } from "../src/contract.js";
import { listMcpTools } from "../src/mcp-server.js";

test("MCP server tool list matches the shared contract exactly", () => {
  expect(listMcpTools()).toEqual(NARRATION_MCP_TOOLS);
});

test("documented MCP tool contract matches the shared contract exactly", async () => {
  const documented = JSON.parse(await Bun.file("docs/mcp-tools.json").text());
  expect(documented).toEqual(NARRATION_MCP_TOOLS);
});

test("shared MCP contract includes agent render and result lifecycle tools", () => {
  expect(NARRATION_MCP_TOOLS.map((tool) => tool.name)).toEqual([
    "create_narration_job",
    "render_narration_job",
    "get_narration_status",
    "get_narration_result",
    "list_narration_jobs",
  ]);
});

test("human MCP contract doc includes every shared tool name and description", async () => {
  const markdown = await Bun.file("docs/mcp-contract.md").text();
  for (const tool of NARRATION_MCP_TOOLS) {
    expect(markdown).toContain(tool.name);
    expect(markdown).toContain(tool.description);
  }
});
