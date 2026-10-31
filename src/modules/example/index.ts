import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { z } from "zod";

import { IDENTITY } from "../../identity.js";
import { defineTool, type ToolDefinition } from "../../types.js";
import { ok } from "../../utils/result.js";

const started = Date.now();

/** True when this Node runs inside WSL, i.e. a Linux process that cannot see the Windows side. */
function isWsl(): boolean {
  if (platform() !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return existsSync("/run/WSL");
  }
}

/**
 * The three tools every project keeps. Delete `echo` once real tools exist, but keep
 * `server_info` and `client_info`: when a client says "no tools" or "wrong environment", these two
 * answer in one call where the problem is.
 */
export const exampleTools: ToolDefinition[] = [
  defineTool({
    name: "echo",
    module: "example",
    title: "Echo",
    description: "Returns the given text unchanged. Use it to check that the connection works end to end.",
    docs: "Smallest possible tool: one string in, the same string out. Replace it with your own.",
    shape: { text: z.string().describe("The text to repeat") },
    handler: async ({ text }) => ok({ text }, text),
  }),

  defineTool({
    name: "server_info",
    module: "example",
    title: "Server info",
    description:
      "Reports where this server process runs: name, version, platform, whether it is inside WSL, " +
      "data directory and uptime. Use it first when results look empty or wrong for the machine.",
    docs:
      "A server that is started by a WSL-hosted agent runs in Linux and cannot see Windows tools or " +
      "drives. Tools that depend on the host should report this honestly (degraded + an environment " +
      "block) instead of claiming a clean empty result; this tool is the pattern for that block.",
    shape: {},
    handler: async (_args, ctx) =>
      ok({
        name: IDENTITY.name,
        platform: platform(),
        release: release(),
        arch: arch(),
        hostname: hostname(),
        wsl: isWsl(),
        node: process.version,
        pid: process.pid,
        data_dir: ctx.config.settings.dataDir,
        origin: ctx.origin,
        started_at: new Date(started).toISOString(),
        uptime_seconds: Math.round((Date.now() - started) / 1000),
      }),
  }),

  defineTool({
    name: "client_info",
    module: "example",
    title: "Client info",
    description:
      "Reports what the connected MCP client declared at the handshake: its name and version and " +
      "whether it supports sampling and elicitation. Returns null fields when called from the dashboard.",
    docs: "Per-session on purpose: each HTTP session keeps the capabilities of its own client.",
    shape: {},
    handler: async (_args, ctx) => {
      const client = ctx.client();
      return ok({
        connected: client !== null,
        name: client?.name ?? null,
        version: client?.version ?? null,
        sampling: client?.sampling ?? null,
        elicitation: client?.elicitation ?? null,
        capabilities: client?.capabilities ?? null,
        origin: ctx.origin,
      });
    },
  }),
];
