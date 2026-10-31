import type { ToolDefinition } from "../types.js";
import { exampleTools } from "./example/index.js";

/**
 * Every tool this server offers. Add a module folder, export its tools, spread them in here.
 * The MCP tool list, the dashboard and `/api/state` all draw from this one list.
 */
export const ALL_TOOLS: ToolDefinition[] = [...exampleTools];

export const TOOLS_BY_NAME = new Map<string, ToolDefinition>(ALL_TOOLS.map((tool) => [tool.name, tool]));

// A duplicate name would silently shadow a tool in the map; fail at startup instead.
if (TOOLS_BY_NAME.size !== ALL_TOOLS.length) {
  throw new Error("Duplicate tool name in ALL_TOOLS");
}
