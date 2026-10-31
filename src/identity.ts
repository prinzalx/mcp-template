/**
 * The ONLY file that carries this project's identity.
 *
 * `npm run init -- --name acme-mcp --prefix ACME --port 8790` rewrites it (and package.json, the
 * docs and the skill). Nothing else in src/ may hard-code the name, the env prefix or the port.
 */
export const IDENTITY = {
  /** Package name, MCP `serverInfo.name`, and the key in Hermes' `mcp_servers:`. */
  name: "mcp-template",
  /** Human-readable title for the dashboard. */
  title: "MCP Template",
  /** One sentence; also what `--help` prints. */
  description: "MCP server template that works with Hermes Agent from the first run",
  /** Env vars are `<PREFIX>_PORT`, `<PREFIX>_HOST`, `<PREFIX>_NO_WEB`, `<PREFIX>_NO_STDIO`, `<PREFIX>_CONFIG`, `<PREFIX>_DATA_DIR`. */
  envPrefix: "MCPT",
  /** One port per project on this machine; see the table in docs/HERMES-CONTRACT.md. */
  defaultPort: 8789,
  /** What the model reads at the handshake. Keep it to what the tools do and what they never do. */
  instructions:
    "Template server. echo returns its input, server_info reports where this process runs, " +
    "client_info reports what the connected client declared at the handshake.",
} as const;
