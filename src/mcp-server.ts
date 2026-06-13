#!/usr/bin/env bun

import process from "node:process";
import { readFile } from "node:fs/promises";

import { NARRATION_MCP_TOOLS, type McpToolContract } from "./contract.js";
import {
  createJobFromPayload,
  getJobResult,
  getStatusSummary,
  listJobIds,
  renderJob,
} from "./service.js";

type McpRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

type McpResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
};

export function listMcpTools(): McpToolContract[] {
  return JSON.parse(JSON.stringify(NARRATION_MCP_TOOLS)) as McpToolContract[];
}

function writeResponse(response: McpResponse) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function asError(id: string | number | null | undefined, message: string, code = -32000): McpResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
}

function wrapResult(id: string | number | null | undefined, result: Record<string, unknown>): McpResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

async function handleToolsList(id: string | number | null | undefined) {
  writeResponse(
    wrapResult(id, {
      tools: listMcpTools(),
    }),
  );
}

function textResult(payload: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function getJobId(args: Record<string, unknown>): string {
  const jobId = typeof args.job_id === "string" ? args.job_id.trim() : "";
  if (!jobId) {
    throw new Error("Missing required argument: job_id");
  }
  return jobId;
}

export async function handleMcpToolCall(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (tool === "create_narration_job") {
    const jobArg = args.job as unknown;
    const jobPathArg = typeof args.job_path === "string" ? args.job_path : undefined;
    let payload = jobArg;
    if (!payload && jobPathArg) {
      const raw = await readFile(jobPathArg, "utf8");
      payload = JSON.parse(raw) as unknown;
    }
    if (!payload) {
      throw new Error("Missing 'job' or 'job_path'");
    }
    return textResult(await createJobFromPayload(payload));
  }

  if (tool === "render_narration_job") {
    const jobId = getJobId(args);
    return textResult(await renderJob(jobId));
  }

  if (tool === "get_narration_status") {
    const jobId = getJobId(args);
    return textResult(await getStatusSummary(jobId));
  }

  if (tool === "get_narration_result") {
    const jobId = getJobId(args);
    return textResult(await getJobResult(jobId));
  }

  if (tool === "list_narration_jobs") {
    return textResult({ jobs: await listJobIds() });
  }

  throw new Error(`Unknown tool: ${tool}`);
}

async function handleToolsCall(
  id: string | number | null | undefined,
  payload: { name?: string; arguments?: Record<string, unknown> } = {},
) {
  const tool = payload.name;
  const args = payload.arguments ?? {};
  try {
    if (!tool) {
      throw new Error("Missing tool name");
    }
    writeResponse(wrapResult(id, await handleMcpToolCall(tool, args)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeResponse(asError(id, message));
  }
}

async function handleRequest(raw: string) {
  let request: McpRequest;
  try {
    request = JSON.parse(raw) as McpRequest;
  } catch (error) {
    writeResponse(asError(null, "Invalid JSON"));
    return;
  }

  if (!request || request.jsonrpc !== "2.0" || !request.method) {
    writeResponse(asError(request?.id, "Invalid MCP request"));
    return;
  }

  if (request.method === "initialize") {
    writeResponse(
      wrapResult(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "narrationlayer-mcp",
          version: "0.0.1",
        },
      }),
    );
    return;
  }

  if (request.method === "tools/list") {
    await handleToolsList(request.id);
    return;
  }

  if (request.method === "tools/call") {
    await handleToolsCall(request.id, request.params);
    return;
  }

  if (request.method === "notifications/initialized") {
    return;
  }

  writeResponse(asError(request.id, `Unsupported method: ${request.method}`));
}

export async function main() {
  const decoder = new TextDecoder();
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      void handleRequest(trimmed);
    }
  });

  process.stdin.on("end", () => {
    if (buffer.trim()) {
      void handleRequest(buffer.trim());
    }
  });
}

if (import.meta.main) {
  void main();
}
