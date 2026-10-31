# Hermes Contract

What has to be true for an MCP server to work with Hermes Agent **from the first run**. It is
extracted from the code and the git history of `winadmin-mcp` and `winsecure-mcp`, where every
rule below cost at least one failed attempt. The template's `src/index.ts` already satisfies all of
it; this document says why, so nobody "simplifies" a rule away.

**Target setup:** Hermes runs in WSL, the server runs on Windows, Hermes connects by `url:`.
(A server that does not need the Windows side can be spawned by stdio instead; see rule 1.)

## Ports

One port per project on a machine. `npm run init` puts the new project's port in here; add the other
projects on your machine if they are missing.

| Port | Project |
|------|---------|
| 8787 | winadmin-mcp |
| 8788 | winsecure-mcp |
| 8789 | mcp-template |

## The rules

Each rule names where it came from and which test pins it. `npm test` runs both smoke tests; the
rule is only as good as its test, so the weak spots are listed under "Not verified" below.

### 1. One process, both transports

`node dist/index.js` is a long-lived process: **stdio always** (the default MCP transport) plus **one
HTTP listener** that carries `/mcp`, `/api/*` and the dashboard. There is no separate "HTTP mode".

*Why:* A client that spawns the server by stdio runs it in its own environment. For a WSL-hosted
agent that is Linux, which finds no `powershell.exe`, no `winget.exe`, no drive roots; winsecure's
inventory came back empty until Hermes connected to the Windows-side process by `url:`. winsecure's
first version had a separate `--http` mode and was rebuilt "1:1 on the winadmin model"
(commit `9abda11`).
*Pinned by:* smoke-stdio ("the HTTP listener runs in the same process"), smoke-http.

### 2. `/mcp` belongs to MCP, never to the dashboard

A bare `curl` to `/mcp` gets the transport's JSON `406 Not Acceptable`, not HTML. A trailing slash
(`/mcp/`) reaches the transport too. Route `/mcp` before the dashboard's catch-all `GET`.

*Why:* winsecure's first version fell back to the dashboard on `/mcp`; `bd06c80` added the trailing
slash because `url:` entries typed by hand end up with one.
*Pinned by:* smoke-http ("a bare GET /mcp is MCP's 406", "a trailing slash reaches the MCP transport").

### 3. Real HTTP sessions: one server per `mcp-session-id`

Build one `McpServer` + `StreamableHTTPServerTransport` per session, keep them in a map, answer an
unknown session id with `404` JSON, end a session on `DELETE`, sweep idle sessions
(`sessionIdleMinutes`, default 30).

*Why:* winadmin built a fresh server for every HTTP request, so `tools/call` was served by an
instance that never saw `initialize`: the client's capabilities looked absent and the approval
popup was never attempted (`90b1199`).
*Pinned by:* smoke-http (two sessions with different capabilities stay independent; 404 after
`DELETE`; 404 for an unknown id).

### 4. stdout is the protocol, nothing else

Over stdio, every byte on stdout must be JSON-RPC. All logging goes to **stderr**. The kernel also
redirects `console.log/info/debug` to stderr, so a stray print in a tool cannot corrupt the session.
Child processes must be captured (`stdio: "pipe"`, `execFile` with a buffer), never `"inherit"`.

*Why:* winadmin's "quiet the stdio log" (`624f513`): one call report per line on stderr, a line
announcing which client connected, and one `list_changed` notification per change instead of one
per tool.
*Pinned by:* smoke-stdio ("stdout carries protocol only", "a stray console.log went to stderr").
A native module or a child with inherited stdio bypasses the console guard; the test cannot see that.

### 5. Bind `0.0.0.0` by default, narrow on purpose

The listener binds `0.0.0.0` so a client in WSL reaches it through the `vEthernet (WSL)` adapter.
`--host` / `<PREFIX>_HOST` narrows it. Open the port in the Windows firewall for the **WSL subnet
only**, never for every interface:

```
netsh advfirewall firewall add rule name="mcp-template" dir=in action=allow protocol=TCP localport=8789 remoteip=<WSL subnet>
```

The WSL address and subnet are specific to the host and can change (check
`Get-NetIPAddress -InterfaceAlias "vEthernet (WSL)"` on Windows). If the connection is refused after a
Windows reboot, look here first. With WSL's mirrored networking mode, `127.0.0.1` reaches Windows
services directly (Microsoft's documented behaviour; not checked on this host).
*Pinned by:* smoke-http (default bind reaches a non-loopback address; `--host 127.0.0.1` does not).

### 6. Tool results: summary line plus structured data, never a throw

Return `ok(data, summary?)`, `text(msg, data?)` or `fail(msg)` from `utils/result.ts`. A handler that
throws becomes a `fail`, so the client sees the message and the session survives. Use english status
words and ISO-8601 UTC timestamps so output does not depend on the machine's locale. **An empty
result is an answer, not an error.**

### 7. Tool names: snake_case, without the server name

The client adds its own prefix. In Hermes the tools of `winsecure` appear as
`mcp__winsecure__<tool>`; other clients use `mcp_winsecure_<tool>`. In both projects the prefix matches
the **key under `mcp_servers:`**, not `serverInfo.name` (`winsecure-mcp`), so pick the key with that in
mind (inferred from the two projects, not checked in Hermes' source). Skills and docs refer to the
name behind the prefix.
*Pinned by:* smoke-stdio (no tool name starts with `mcp_` or the server name).

### 8. Be honest about the environment

A tool that depends on the host must report where it actually ran. winsecure's `scan_inventory`
returns `degraded: true`, names every source that contributed nothing and carries an `environment`
block (`platform`, `powershell_found`, `winget_found`) instead of claiming a clean "0 programs".
The template's `server_info` is the pattern: `platform`, `wsl`, `node`, `data_dir`, `origin`.

### 9. Long work answers inside a budget

A tool that can run long returns a partial answer after a time budget and continues in the
background, and says so in the answer (winsecure: `nvdCallBudgetMs` = 20 s, "well under a typical MCP
client transport timeout", plus `completeness.status` / `warming_up` in the result). Hermes' actual
timeout was not checked; keep calls short rather than relying on a number.

### 10. The skill declares `platforms: [windows, linux]`

*Why:* a WSL-hosted agent that connects to the Windows-side server was blocked with "not supported on
this platform" until the skill declared both (`8b1c1c1`). The template's skill already does.

### 11. `list_changed` and restarts

Hermes picks up tool-list changes live. A **server restart** is different: the connection has to be
re-enabled with `manage_connections enable`, and then its tools come back. So if *every* tool is
suddenly unknown, look for a restart, not for a switched-off tool.

### 12. Popups (elicitation) only show in `hermes --tui`

In the plain CLI Hermes does not render elicitation. A gated call then has to fall back to
something else (winadmin parks it for the web dashboard). Over HTTP the answer must travel on the
stream of the call that asks: pass `relatedRequestId` (`ctx.requestId`).

```ts
// Inside a tool handler. Only ask when the client declared it; on any failure fall back.
if (ctx.server && ctx.client()?.elicitation) {
  try {
    const answer = await ctx.server.server.elicitInput(
      {
        mode: "form",
        message: `Run ${name}?`,
        requestedSchema: { type: "object", properties: { approved: { type: "boolean", title: "Approve", default: true } } },
      },
      ctx.requestId === undefined ? { timeout } : { timeout, relatedRequestId: ctx.requestId },
    );
    if (answer.action !== "accept" || answer.content?.approved === false) return fail("not executed");
  } catch {
    // a client that claims elicitation but cannot answer one must not lose the call
  }
}
```

Sampling (`ctx.server.server.createMessage(...)`) works the same way and needs the same
`ctx.client()?.sampling` guard. winsecure's sampling path was only proven against a mock client.

## Registration in Hermes

```yaml
# ~/.hermes/config.yaml  (inside WSL)
mcp_servers:
  mcpt:
    url: http://<windows-host>:8789/mcp
    enabled: true
```

Then, inside Hermes: `manage_connections install`, and after every server restart
`manage_connections enable`. `scripts/hermes-check.sh` (run in WSL) tests the connection the way
Hermes needs it and prints this entry with the right host.

The older stdio form (`command: "node"`, `args: ["<checkout>/dist/index.js"]`) is still shown in
`winadmin-mcp/docs/hermes.md`. On a WSL-hosted Hermes it starts the server inside WSL; use it only when
the server does not need Windows.

## Security

There is **no authentication** on `/mcp` or `/api/*`, and `/api/run` executes any tool. With the
`0.0.0.0` default, anything that can reach the port can call the tools. Mitigations, in this order:
the firewall rule with `remoteip` (rule 5), `--host` when the client is local, and for a tool that
changes things an approval step (winadmin's gate). Whether Hermes can send an auth header on a `url:`
entry was not checked; if it can, a bearer check belongs into the kernel and into this contract.

## Where the two source projects disagree

The template follows the newer transport (winsecure) and keeps winadmin's session cleanup.

| Topic | winadmin-mcp | winsecure-mcp | Template |
|---|---|---|---|
| Bind address | `http.listen(port)` with no host: all interfaces, although the banner prints `127.0.0.1` and `docs/development.md` says "bound to local only". No `--host`. | `--host`, default `0.0.0.0` | winsecure's, with a banner that tells the truth |
| `/mcp/` (trailing slash) | not handled | handled | handled |
| Hermes config in the docs | stdio entry (`docs/hermes.md`) | `url:` entry | `url:` |
| Per-session cleanup | config subscription is disposed on close | n/a | no subscription to leak |
| Elicitation | yes | no | helper + snippet (rule 12) |

## Beyond the two projects (template additions)

Everything else is taken from the two projects. These are new, each small:

- `console.log` / `console.info` / `console.debug` redirect to stderr (rule 4).
- `--no-stdio` (`<PREFIX>_NO_STDIO=1`): HTTP only. A Windows autostart entry or service has no stdin;
  the stdio transport would see it close and end the process at once. Default behaviour is unchanged.
- `client_info` and `server_info` diagnostic tools; `ToolContext` carries `server`, `requestId`,
  `client()` so a tool can ask the client something back without touching the kernel.
- `defineTool()` for typed handlers; `npm run init` for the rename; `scripts/hermes-check.sh`.
- A clear fatal message when the port is taken (three projects now share one machine).

## When it does not work

| Symptom | Look at |
|---|---|
| `hermes-check.sh` fails the first check | Server not running; wrong host; firewall rule (rule 5); WSL subnet changed after a reboot |
| `hermes-check.sh` passes, Hermes sees nothing | `manage_connections install` / `enable` (rule 11); config key and `url:` |
| Tools return empty or "degraded" | `server_info`: `wsl: true` means the server was spawned inside WSL; connect by `url:` (rule 1) |
| Every tool suddenly unknown | The server was restarted: `manage_connections enable` (rule 11) |
| Parse errors over stdio | Something wrote to stdout (rule 4): a child with inherited stdio, a native module |
| `curl /mcp` returns HTML | A route was added before `/mcp` (rule 2) |
| A gated tool never shows a popup | Run `hermes --tui` (rule 12) |
| Skill "not supported on this platform" | `platforms: [windows, linux]` in the frontmatter (rule 10) |
| `EADDRINUSE` | Another project owns the port; see the table above |

## Definition of done for a project built on this template

1. `npm run typecheck && npm run build && npm test` pass, on the platform the tools need.
2. `src/index.ts`, `src/config.ts` and `src/utils/` are unchanged, or the change is justified in this
   file under the rule it touches.
3. The port is in the table above.
4. On the Hermes host (WSL): `scripts/hermes-check.sh` passes, the config entry is in place, and the
   tools show up in Hermes under `mcp__<key>__<tool>`.
5. If step 4 cannot be done by whoever built it, say so: the project is "not tested against Hermes",
   and the exact commands for whoever can are handed over. Do not report it as finished.

## Not verified

The following were **not** checked, because no Hermes and no Windows were available when this was
written; each is inferred from the two source projects:

- A live connection from Hermes (the registration steps, `manage_connections`, tool prefix, the
  `hermes --tui` popup behaviour). `hermes-check.sh` was only run against `127.0.0.1`.
- Windows-specific behaviour (PowerShell, firewall rule, autostart with `--no-stdio`).
- WSL networking (host detection via the default gateway, subnet changes, mirrored mode).
- Hermes' client timeout and whether it can send headers on a `url:` entry.
- That SDK 1.32.x's own handling of a bare `elicitation: {}` makes the kernel's
  `normalizeElicitationCaps` a no-op; the helper stays as insurance and no test distinguishes the two.
