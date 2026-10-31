# MCP Template

An MCP server skeleton that works with Hermes Agent from the first run. It carries the transport
layer that `winadmin-mcp` and `winsecure-mcp` needed several attempts to get right: stdio plus
Streamable HTTP in one process, real sessions, a clean stdout, a bind address a WSL client can
reach, and smoke tests that pin each of those down.

You add tools. You do not touch the transport.

## Start a new project

```
cp -r mcp-template acme-mcp && cd acme-mcp        # or use this repo as a GitHub template
npm run init -- --name acme-mcp --port 8790        # renames everything that carries the identity
npm ci && npm run build && npm test                # all green before you write a line of domain code
```

`init` rewrites `src/identity.ts`, `package.json`, the docs, the skill and the check script. Options
(`--prefix`, `--key`, `--title`, `--description`) are listed with `npm run init -- --help`.
Your port is then already in the port table of [docs/HERMES-CONTRACT.md](docs/HERMES-CONTRACT.md); add
any other project on the machine that is missing from it.

## What is yours, what is not

| Path | Edit it? |
|---|---|
| `src/modules/**` | **Yes.** Your tools live here. |
| `src/identity.ts` | Yes: `instructions` and `description`. The rest is set by `init`. |
| `src/config.ts` | Add settings (`Settings` + a default in `loadConfig`). Leave the rest. |
| `src/webui.html` | Yes, if you want more in the dashboard. |
| `skills/<name>/SKILL.md` | Yes: fill in the TODOs. |
| `src/index.ts`, `src/utils/` | **No.** This is the transport kernel. See the contract before changing it. |
| `scripts/smoke-*.mjs` | Add checks for your tools; do not remove the existing ones. |

## Adding a tool

1. Create `src/modules/<area>/index.ts` and export an array of tools built with `defineTool`:

   ```ts
   import { z } from "zod";
   import { defineTool, type ToolDefinition } from "../../types.js";
   import { ok, fail } from "../../utils/result.js";

   export const diskTools: ToolDefinition[] = [
     defineTool({
       name: "disk_free",                       // snake_case, no server name in it
       module: "disk",
       title: "Free disk space",
       description: "Free and total space of one drive. Use it when a write failed or a drive looks full.",
       shape: { drive: z.string().describe('Drive letter, e.g. "C"') },
       handler: async ({ drive }, ctx) => {
         // return ok(data, "one-line summary") or fail("what went wrong")
         return ok({ drive, free_gb: 0 });
       },
     }),
   ];
   ```

2. Spread it into `ALL_TOOLS` in `src/modules/index.ts`.
3. Add a check for it to `scripts/smoke-stdio.mjs`, then `npm run build && npm test`.

The tool list, the dashboard and `/api/state` all draw from `ALL_TOOLS`; nothing else needs to know.
Rules for results (summary line plus data, no throws, english status words, ISO-8601 UTC): contract rule 6.

## Running it

```
node dist/index.js                 # stdio + HTTP on the port from identity.ts
node dist/index.js --port 8790     # another port
node dist/index.js --host 127.0.0.1   # not reachable from WSL: loopback only
node dist/index.js --no-stdio      # HTTP only (autostart / service: no stdin)
node dist/index.js --no-web        # stdio only, no listener
```

Dashboard: `http://127.0.0.1:<port>`. MCP over HTTP: `http://<host>:<port>/mcp`.
Settings can also come from env vars (`MCPT_PORT`, `MCPT_HOST`, `MCPT_NO_WEB`, `MCPT_NO_STDIO`,
`MCPT_CONFIG`, `MCPT_DATA_DIR`) or the JSON config file in the data directory. A command-line flag
wins over the environment.

## Connecting Hermes

Run the server on Windows, then in WSL:

```
scripts/hermes-check.sh <windows-host> 8789 mcpt
```

It checks the connection the way Hermes needs it and prints the `~/.hermes/config.yaml` entry.
Registration steps, the firewall rule and what to do when something fails are in
[docs/HERMES-CONTRACT.md](docs/HERMES-CONTRACT.md). Copy `skills/mcp-template` to
`~/.hermes/skills/` for the skill.

## Security

No authentication, and the default bind is `0.0.0.0` so WSL can reach it. Read the "Security" section
of the contract before putting a tool behind it that changes anything.

## Layout

```
src/
  index.ts            transport kernel: stdio + Streamable HTTP, sessions, dashboard API   (do not edit)
  identity.ts         name, env prefix, port, instructions                                  (set by init)
  config.ts           CLI flags, env vars, JSON config file
  types.ts            ToolDefinition, ToolContext, defineTool()
  modules/            your tools; example/ holds echo, server_info, client_info
  utils/              result helpers, activity ring buffer
  webui.html          the dashboard (no build step)
scripts/
  init.mjs            turns a fresh copy into a named project
  smoke-stdio.mjs     real MCP session over stdio, stdout purity, shutdown
  smoke-http.mjs      real MCP sessions over HTTP, 404/406 behaviour, bind, headless mode
  hermes-check.sh     run in WSL against the Windows-side server
docs/
  HERMES-CONTRACT.md  the rules, why they exist, what is not verified
  NEW-PROJECT-PROMPT.md   the prompt to hand an agent that builds a project on this
skills/<name>/SKILL.md    Hermes skill skeleton (keeps platforms: [windows, linux])
```
