---
name: mcp-template
description: TODO — one sentence on what the user asks for that this server answers, in the words the user would use. Hermes matches on this text to offer the skill, so name the situations ("what is vulnerable here?", "why did the service stop?"), not the tools.
version: 0.1.0
platforms: [windows, linux]
metadata:
  hermes:
    category: TODO
    tags: [mcp]
---

# MCP Template

Teaches Hermes the routine for this server: look first, then claim. It assumes a running
`mcpt` MCP server. Every tool named here appears under a name the client builds itself, so the
prefix differs per client (Hermes uses `mcp__mcpt__`, others use `mcp_mcpt_`); match on the tool
name behind the prefix.

`platforms: [windows, linux]` in the frontmatter is deliberate and must stay. A WSL-hosted agent
connects by `url:` to the Windows-side process; with `platforms: [windows]` alone Hermes blocks the
skill with "not supported on this platform" (winsecure-mcp, commit 8b1c1c1).

## When to use it

- TODO: the questions this server answers, as the user would phrase them.

## First step, always

Call `server_info`. If `wsl` is `true` and the tools depend on Windows, the server was spawned
inside WSL instead of being reached by `url:` — say so instead of reporting an empty result as a
finding.

## The routine

1. TODO: which tool first, what to read out of its answer.
2. TODO: which tool next.
3. Say what you looked at and what you found. Do not claim what no tool returned.

## What this server never does

- TODO: state the limits (for example "never changes the system, it only writes its own files").
