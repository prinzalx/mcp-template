#!/usr/bin/env node
/**
 * TRANSPORT KERNEL — do not edit in a project derived from this template.
 *
 * Everything in this file exists because a Hermes setup once failed without it (see
 * docs/HERMES-CONTRACT.md for the history). A project adds tools under src/modules/ and changes
 * src/identity.ts; it does not change how the server talks. If something here really has to change,
 * change it in the template and record why in the contract.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { ARGS, envVar, loadConfig } from "./config.js";
import { IDENTITY } from "./identity.js";
import { ALL_TOOLS, TOOLS_BY_NAME } from "./modules/index.js";
import type { ClientInfo, Origin, ToolContext, ToolDefinition } from "./types.js";
import { createActivity } from "./utils/activity.js";
import { fail } from "./utils/result.js";

// Over stdio, stdout IS the protocol: one stray line there corrupts the session and the client
// reports a parse error or a dead server. Anything a tool prints with console.log goes to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

/** Everything diagnostic goes to stderr; this is the only logging function in the kernel. */
function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Read from package.json so a release bump has exactly one place to be updated. The file sits
// next to dist/ in every install, including a global npm one.
const VERSION = (() => {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    return String((JSON.parse(raw) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const HELP = `${IDENTITY.name} — ${IDENTITY.description}

usage: node dist/index.js [options]

  --port <n>     HTTP port for /mcp, /api and the dashboard (default ${String(IDENTITY.defaultPort)}, env ${IDENTITY.envPrefix}_PORT)
  --host <addr>  bind address (default 0.0.0.0 so a WSL client can reach it, env ${IDENTITY.envPrefix}_HOST)
  --no-web       no HTTP listener at all: stdio only (env ${IDENTITY.envPrefix}_NO_WEB=1)
  --no-stdio     HTTP only; do not read stdin. For a Windows autostart/service, where stdin is closed
                 and the stdio transport would end the process at once (env ${IDENTITY.envPrefix}_NO_STDIO=1)
  --config <p>   path to the JSON config file (env ${IDENTITY.envPrefix}_CONFIG)
  --data-dir <p> directory for the config and persisted data (env ${IDENTITY.envPrefix}_DATA_DIR)
  --help         show this text
`;

// The runtime every per-session MCP server and the dashboard share.
const config = loadConfig();
const activity = createActivity();

/** The most recently attached MCP client, for the dashboard card. */
let lastClient: ClientInfo | null = null;

/**
 * A client that declares a bare `elicitation: {}` means the original form mode; `elicitInput`
 * insists on the `form` sub-flag being spelled out. winadmin added this helper when a bare
 * declaration made the popup look unsupported.
 *
 * SDK 1.32.x already does the same while parsing the handshake, so with that SDK this is a no-op.
 * It stays as insurance (both reference projects carry it, and a client library or SDK downgrade
 * could bring the problem back). The smoke tests check the observable result, not this function.
 */
function normalizeElicitationCaps(server: McpServer): void {
  const elicitation = server.server.getClientCapabilities()?.elicitation as Record<string, unknown> | undefined;
  if (elicitation && elicitation.form === undefined && elicitation.url === undefined) {
    elicitation.form = {};
  }
}

/**
 * Runs a tool with input validation and error capture.
 *
 * A handler that throws is turned into a failed result rather than an MCP protocol error, so the
 * client sees the message and the session survives.
 */
async function invoke(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    log(`  err  ${tool.name} (${ctx.origin}) invalid input`);
    return fail(`Invalid input for ${tool.name} — ${message}`);
  }
  const started = Date.now();
  try {
    const result = await tool.handler(parsed.data as Record<string, unknown>, ctx);
    const ms = Date.now() - started;
    log(`  ${result.isError ? "err " : "ok  "} ${tool.name} (${ctx.origin}) ${String(ms)} ms`);
    activity.add({
      at: new Date().toISOString(),
      tool: tool.name,
      ok: result.isError !== true,
      duration_ms: ms,
      origin: ctx.origin,
      summary: result.content.map((c) => ("text" in c ? c.text : "")).join(" ").slice(0, 300),
    });
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(`  err  ${tool.name} threw: ${message}`);
    activity.add({
      at: new Date().toISOString(),
      tool: tool.name,
      ok: false,
      duration_ms: Date.now() - started,
      origin: ctx.origin,
      summary: message,
    });
    return fail(`${tool.name} threw: ${message}`);
  }
}

/**
 * Builds a fresh MCP server with every tool registered. A server is built per session — over
 * stdio once, over HTTP per connection — because what the client declared at `initialize`
 * (sampling, elicitation) belongs to exactly one client.
 */
function buildMcpServer(origin: Exclude<Origin, "web">): McpServer {
  const server = new McpServer({ name: IDENTITY.name, version: VERSION }, { instructions: IDENTITY.instructions });

  // The client capabilities are only known after the handshake, so they are read in
  // `oninitialized`, not at construction time.
  let client: ClientInfo | null = null;

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input.shape as never },
      ((args: Record<string, unknown>, extra: { requestId?: string | number }) =>
        invoke(tool, args ?? {}, {
          config,
          activity,
          origin,
          server,
          requestId: extra?.requestId,
          client: () => client,
        })) as never,
    );
  }

  server.server.oninitialized = () => {
    normalizeElicitationCaps(server);
    const caps = server.server.getClientCapabilities();
    const version = server.server.getClientVersion();
    client = {
      name: version?.name ?? "unknown",
      version: version?.version ?? "",
      sampling: Boolean(caps?.sampling),
      elicitation: Boolean(caps?.elicitation),
      capabilities: (caps ?? {}) as Record<string, unknown>,
    };
    lastClient = client;
    log(
      `  client connected (${origin}): ${client.name} ${client.version}` +
        ` — sampling ${String(client.sampling)}, elicitation ${String(client.elicitation)}`,
    );
  };

  return server;
}

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP
// ---------------------------------------------------------------------------

interface McpHttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

const httpSessions = new Map<string, McpHttpSession>();

/**
 * MCP over Streamable HTTP, with real sessions: one server and transport per `mcp-session-id`.
 *
 * Stateless-per-request would answer every `tools/call` with a server that never saw the client's
 * `initialize`, so the client capabilities — and with them sampling and the approval popup — would
 * always look absent.
 */
async function handleMcpHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A session that no client touched for a while is assumed gone; swept on every request.
  const idleMs = config.settings.sessionIdleMinutes * 60 * 1000;
  for (const [id, session] of httpSessions) {
    if (Date.now() - session.lastSeen > idleMs) {
      httpSessions.delete(id);
      await session.transport.close().catch(() => undefined);
      await session.server.close().catch(() => undefined);
    }
  }

  const wanted = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(wanted) ? wanted[0] : wanted;

  const session = sessionId ? httpSessions.get(sessionId) : undefined;
  if (sessionId && !session) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown MCP session" }));
    return;
  }

  if (!session) {
    const server = buildMcpServer("http");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    // The session must outlive the request that created it, so nothing is closed on `res.close`.
    // `delete` before `close` is the recursion guard: closing the server closes the transport,
    // which calls this handler again.
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && httpSessions.has(id)) {
        httpSessions.delete(id);
        void server.close();
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) {
      httpSessions.set(transport.sessionId, { server, transport, lastSeen: Date.now() });
    } else {
      // A failed handshake (a bare GET, a non-initialize POST): nothing to keep.
      await transport.close();
      await server.close();
    }
    return;
  }

  session.lastSeen = Date.now();
  if (req.method === "DELETE") {
    await session.transport.handleRequest(req, res);
    httpSessions.delete(sessionId ?? "");
    await session.server.close();
    return;
  }
  await session.transport.handleRequest(req, res);
}

// ---------------------------------------------------------------------------
// Dashboard and its JSON API (same listener)
// ---------------------------------------------------------------------------

/** The dashboard calls tools through the same `invoke`, with no MCP session behind it. */
const webCtx: ToolContext = {
  config,
  activity,
  origin: "web",
  server: null,
  requestId: undefined,
  client: () => null,
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === "/api/state") {
    return send(200, {
      name: IDENTITY.name,
      title: IDENTITY.title,
      version: VERSION,
      config_path: config.path,
      data_dir: config.settings.dataDir,
      sessions: httpSessions.size,
      client: lastClient,
      tools: ALL_TOOLS.map((t) => ({
        name: t.name,
        module: t.module,
        title: t.title,
        description: t.description,
        docs: t.docs ?? "",
        schema: Object.keys(t.input.shape),
      })),
      activity: activity.recent(25),
    });
  }

  if (url.pathname === "/api/run" && req.method === "POST") {
    const body = await readJson(req);
    const tool = TOOLS_BY_NAME.get(String(body.tool ?? ""));
    if (!tool) return send(404, { error: `Unknown tool "${String(body.tool)}"` });
    const result = await invoke(tool, (body.args as Record<string, unknown>) ?? {}, webCtx);
    return send(200, {
      ok: result.isError !== true,
      output: result.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
    });
  }

  return send(404, { error: `No API route for ${url.pathname}` });
}

function serveHtml(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(fileURLToPath(new URL("./webui.html", import.meta.url)), "utf8"));
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function parsePort(): number {
  const raw = ARGS.get("port") ?? envVar("PORT") ?? IDENTITY.defaultPort;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port "${String(raw)}" — use --port <1-65535> or ${IDENTITY.envPrefix}_PORT`);
  }
  return port;
}

async function main(): Promise<void> {
  if (ARGS.get("help") === true) {
    // The one legitimate stdout write: the process exits right after, before any protocol runs.
    process.stdout.write(HELP);
    process.exit(0);
  }

  const webDisabled = ARGS.get("no-web") === true || envVar("NO_WEB") === "1";
  const stdioDisabled = ARGS.get("no-stdio") === true || envVar("NO_STDIO") === "1";
  if (webDisabled && stdioDisabled) {
    throw new Error("--no-web and --no-stdio together leave no transport to serve");
  }

  const port = parsePort();
  // Bound to every interface by default, because the client usually sits in WSL and reaches this
  // process through the virtual network adapter; --host / <PREFIX>_HOST narrows it down.
  const hostArg = ARGS.get("host");
  const bindHost = typeof hostArg === "string" && hostArg !== "" ? hostArg : (envVar("HOST") ?? "0.0.0.0");

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Tolerate a trailing slash: some clients (and url: entries typed by hand) request "/mcp/".
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    try {
      if (path.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      // /mcp belongs to the MCP transport: a bare curl gets its JSON 406, never the dashboard HTML.
      if (path === "/mcp") {
        await handleMcpHttp(req, res);
        return;
      }
      if (req.method === "GET") {
        serveHtml(res);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch (cause) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(cause instanceof Error ? cause.message : cause));
    }
  });

  log(`\n  ${IDENTITY.title}`);
  log(`  version         v${VERSION}`);
  log(`  data directory  ${config.settings.dataDir}`);

  if (webDisabled) {
    log("  http listener   disabled (--no-web)");
  } else {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", (cause: NodeJS.ErrnoException) => {
        reject(
          cause.code === "EADDRINUSE"
            ? new Error(`port ${String(port)} is already in use — pick another with --port or ${IDENTITY.envPrefix}_PORT`)
            : cause,
        );
      });
      httpServer.listen(port, bindHost, () => resolve());
    });
    log(`  dashboard       http://${bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost}:${String(port)}`);
    log(`  MCP over HTTP   http://${bindHost === "0.0.0.0" ? "<this-host>" : bindHost}:${String(port)}/mcp   (bound to ${bindHost})`);
  }
  log(stdioDisabled ? "  MCP over stdio  disabled (--no-stdio)" : "  MCP over stdio  this terminal stays attached to the agent");
  log("");

  const shutdown = (): void => {
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!stdioDisabled) {
    // stdio is the default MCP transport; the HTTP listener keeps running in the same process.
    const server = buildMcpServer("stdio");
    // When the MCP client closes stdin, the HTTP listener must not keep the process alive.
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    await server.connect(new StdioServerTransport());
  }
}

main().catch((cause: unknown) => {
  log(`fatal: ${String(cause instanceof Error ? cause.message : cause)}`);
  process.exit(1);
});
