import process from "node:process";
import { readFile } from "node:fs/promises";

import {
  getAllJobIds,
  getJob,
  getManifest,
  getStatus,
  initializeJob,
  pathsForJob,
} from "./job-store.js";
import { parseNarrationJob } from "./schema.js";

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

const TOOLS = [
  {
    name: "create_narration_job",
    description: "Create a new narration job from either an inline payload or a path to job.json.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "object" },
        job_path: { type: "string" },
      },
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: "get_narration_status",
    description: "Get status.json for one job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "get_narration_result",
    description: "Get render manifest for one job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
  },
  {
    name: "list_narration_jobs",
    description: "List all job IDs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    },
  },
];

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
      tools: TOOLS,
    }),
  );
}

async function handleToolsCall(
  id: string | number | null | undefined,
  payload: { name?: string; arguments?: Record<string, unknown> } = {},
) {
  const tool = payload.name;
  const args = payload.arguments ?? {};
  try {
    if (tool === "create_narration_job") {
      const jobArg = args.job as unknown;
      const jobPathArg = typeof args.job_path === "string" ? args.job_path : undefined;
      let payload = jobArg;
      if (!payload && jobPathArg) {
        const raw = await readFile(jobPathArg, "utf8");
        payload = JSON.parse(raw);
      }
      if (!payload) {
        throw new Error("Missing 'job' or 'job_path'");
      }
      const job = parseNarrationJob(payload);
      const { job: savedJob } = await initializeJob(job);
      const paths = pathsForJob(savedJob.job_id);
      writeResponse(
        wrapResult(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  job_id: savedJob.job_id,
                  job_path: paths.jobPath,
                  status_path: paths.statusPath,
                  manifest_path: paths.manifestPath,
                },
                null,
                2,
              ),
            },
          ],
        }),
      );
      return;
    }

    if (tool === "get_narration_status") {
      const jobId = String(args.job_id ?? "");
      if (!jobId) {
        throw new Error("Missing required argument: job_id");
      }
      const status = await getStatus(jobId);
      const manifest = await getManifest(jobId);
      writeResponse(
        wrapResult(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status, manifest_exists: Boolean(manifest) }, null, 2),
            },
          ],
        }),
      );
      return;
    }

    if (tool === "get_narration_result") {
      const jobId = String(args.job_id ?? "");
      if (!jobId) {
        throw new Error("Missing required argument: job_id");
      }
      const manifest = await getManifest(jobId);
      const job = await getJob(jobId);
      writeResponse(
        wrapResult(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ job, manifest }, null, 2),
            },
          ],
        }),
      );
      return;
    }

    if (tool === "list_narration_jobs") {
      const jobs = await getAllJobIds();
      writeResponse(
        wrapResult(id, {
          content: [{ type: "text", text: JSON.stringify({ jobs }, null, 2) }],
        }),
      );
      return;
    }

    throw new Error(`Unknown tool: ${tool}`);
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
    buffer += decoder.decode(chunk, { stream: true });
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
