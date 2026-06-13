export interface McpToolContract {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
}

export const NARRATION_MCP_TOOLS: McpToolContract[] = [
  {
    name: "create_narration_job",
    description: "Create a queued narration job from an inline job or job JSON path.",
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
    name: "render_narration_job",
    description: "Render a queued narration job and return final status plus manifest.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
      required: ["job_id"],
    },
  },
  {
    name: "get_narration_status",
    description: "Get stable status for one narration job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
      required: ["job_id"],
    },
  },
  {
    name: "get_narration_result",
    description: "Get the stored job and render manifest for one narration job.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
      required: ["job_id"],
    },
  },
  {
    name: "list_narration_jobs",
    description: "List stored narration job IDs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
    },
  },
];
