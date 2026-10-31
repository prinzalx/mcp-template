import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ConfigStore } from "./config.js";
import type { Activity } from "./utils/activity.js";

/** Where a call came from: the stdio session, an HTTP MCP session, or the dashboard. */
export type Origin = "stdio" | "http" | "web";

/** What the connected client declared at the handshake. */
export interface ClientInfo {
  name: string;
  version: string;
  sampling: boolean;
  elicitation: boolean;
  /** The raw capabilities object, after the elicitation normalisation. */
  capabilities: Record<string, unknown>;
}

/**
 * What a tool handler receives besides its arguments.
 *
 * `server` and `requestId` exist for tools that ask the client something back (elicitation or
 * sampling). Over HTTP the answer has to travel on the stream of the very call that asks, so pass
 * `{ relatedRequestId: ctx.requestId }` as the options of `elicitInput` / `createMessage`; see
 * docs/HERMES-CONTRACT.md. Both are `null`/`undefined` for a dashboard call (`origin: "web"`).
 */
export interface ToolContext {
  config: ConfigStore;
  activity: Activity;
  origin: Origin;
  server: McpServer | null;
  requestId: string | number | undefined;
  /** The capabilities this session's client declared; `null` for a dashboard call. */
  client(): ClientInfo | null;
}

export interface ToolDefinition {
  /** snake_case, WITHOUT the server name: the client adds its own prefix (`mcp__<server>__<tool>` in Hermes). */
  name: string;
  /** Grouping in the dashboard. */
  module: string;
  title: string;
  /** What the model always sees. Say what the tool does and when to use it. */
  description: string;
  /** The tool's input as an object schema. */
  input: z.ZodObject<z.ZodRawShape>;
  /** Longer explanation for humans; kept out of `description`, which the model always sees. */
  docs?: string;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>;
}

/**
 * Declares a tool with a typed handler.
 *
 * ```ts
 * defineTool({
 *   name: "echo", module: "example", title: "Echo", description: "…",
 *   shape: { text: z.string().describe("What to repeat") },
 *   handler: async ({ text }) => ok({ text }),
 * });
 * ```
 */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  module: string;
  title: string;
  description: string;
  docs?: string;
  shape: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>;
}): ToolDefinition {
  return {
    name: def.name,
    module: def.module,
    title: def.title,
    description: def.description,
    ...(def.docs === undefined ? {} : { docs: def.docs }),
    input: z.object(def.shape) as unknown as z.ZodObject<z.ZodRawShape>,
    handler: def.handler as unknown as ToolDefinition["handler"],
  };
}
