# Prompt for an agent that builds a project on this template

Copy the block, fill in the four `<…>` values, hand it over. The contract does the heavy lifting; the
prompt only has to point at it and define "done".

```
Build a new MCP server on the template at <path to the template checkout>.

Project: <name>-mcp — <one sentence: what it does and what it must never do>.
Port: <free port; check the table in docs/HERMES-CONTRACT.md>.
Tools it needs: <list, or "propose them and wait for my ok">.

How to work:
1. Copy the template, run `npm run init -- --name <name>-mcp --port <port>`, then
   `npm ci && npm run build && npm test`. Everything must be green BEFORE you write any domain code.
2. Read docs/HERMES-CONTRACT.md completely. It lists what a Hermes setup needs and why.
3. Only add things: tools under src/modules/, settings in src/config.ts, the fields in
   src/identity.ts, checks in scripts/smoke-*.mjs, the TODOs in the skill.
   Do NOT edit src/index.ts or src/utils/. If you believe one of them must change, stop, say why,
   and wait. Do not "improve" the transport.
4. Every tool: snake_case name without the server name, results via ok()/text()/fail(), english
   status words, ISO-8601 UTC, empty result = answer not error (contract rule 6). If a tool depends
   on the host, report the environment honestly (rule 8).
5. Add a check for each tool to scripts/smoke-stdio.mjs.

Done means (contract, "Definition of done"):
- typecheck, build and `npm test` pass;
- the transport files are unchanged;
- the port is in the contract table;
- on the Hermes host, scripts/hermes-check.sh passes and the tools appear in Hermes.
If you cannot reach Hermes yourself, say so explicitly, hand me the exact commands for the Hermes
host, and report the project as "not tested against Hermes". Do not report it as finished.
```
