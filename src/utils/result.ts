import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Result helpers. Every answer carries a human summary line in `content` and the data in
 * `structuredContent.result`, with english status words and ISO-8601 UTC timestamps, so the output
 * does not depend on the machine's locale. An empty result is an answer, not an error.
 */

/** Successful result carrying pretty-printed JSON (or `summary`) plus the data itself. */
export function ok(data: unknown, summary?: string): CallToolResult {
  return {
    content: [{ type: "text", text: summary ?? JSON.stringify(data, null, 2) }],
    structuredContent: { result: data },
  };
}

/** Successful result carrying plain text, optionally with data. */
export function text(message: string, data?: unknown): CallToolResult {
  const content = [{ type: "text" as const, text: message }];
  return data === undefined ? { content } : { content, structuredContent: { result: data } };
}

/** Failure result: the MCP layer stays happy, the model sees the problem. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
