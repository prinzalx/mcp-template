#!/usr/bin/env node
/**
 * Drives the server the way an MCP client would that spawns it: over stdio.
 *
 * Proves the handshake, the tool list, tool results, input validation, that stdout carries nothing
 * but protocol (even when something calls console.log), that the HTTP listener runs in the same
 * process, and that closing stdin ends the process.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checker, freePort, loadIdentity, sleep, tempDir } from "./lib.mjs";

const { check, finish } = checker();
const identity = await loadIdentity();
const port = await freePort();
const preload = fileURLToPath(new URL("./fixtures/stray-log.mjs", import.meta.url));

const server = spawn(process.execPath, ["--import", preload, "dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    [`${identity.envPrefix}_PORT`]: String(port),
    [`${identity.envPrefix}_DATA_DIR`]: tempDir("mcp-smoke-stdio"),
  },
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

/** Every line the server wrote to stdout, in order. */
const stdoutLines = [];
const queue = [];
const waiters = [];
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== "") {
      stdoutLines.push(line);
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        // Not JSON: recorded in stdoutLines and judged by the purity check below.
      }
      if (message) {
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else queue.push(message);
      }
    }
    index = buffer.indexOf("\n");
  }
});

function waitFor(predicate, timeoutMs = 20_000) {
  const queued = queue.findIndex(predicate);
  if (queued >= 0) return Promise.resolve(queue.splice(queued, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an MCP message")), timeoutMs);
    waiters.push((message) => {
      clearTimeout(timer);
      if (predicate(message)) resolve(message);
      else queue.push(message);
    });
  });
}

let nextId = 1;
async function request(method, params) {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  return waitFor((message) => message.id === id);
}

const exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));

try {
  // A bare `elicitation: {}` is what a client that only says "I can show a form" declares.
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { elicitation: {} },
    clientInfo: { name: "smoke-stdio", version: "0.0.0" },
  });
  check("initialize answers with this project's name", init.result?.serverInfo?.name === identity.name, init.result?.serverInfo?.name ?? "no name");
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const list = await request("tools/list");
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check("tools/list advertises the example tools", ["echo", "server_info", "client_info"].every((n) => names.includes(n)), names.join(", "));
  check("every tool has an object input schema", tools.every((t) => t.inputSchema?.type === "object"));
  check("no tool name carries a server prefix (the client adds its own)", names.every((n) => !n.startsWith("mcp_") && !n.startsWith(identity.name.replace(/-/g, "_"))));

  const echo = await request("tools/call", { name: "echo", arguments: { text: "hello" } });
  check("tools/call echo returns the text", echo.result?.content?.[0]?.text === "hello");
  check("results carry structuredContent.result", echo.result?.structuredContent?.result?.text === "hello");

  const invalid = await request("tools/call", { name: "echo", arguments: {} });
  check("invalid input is an error the model can read", invalid.result?.isError === true || invalid.error !== undefined, JSON.stringify(invalid.result?.content ?? invalid.error).slice(0, 100));

  const client = await request("tools/call", { name: "client_info", arguments: {} });
  const info = client.result?.structuredContent?.result;
  check("client_info sees the declared client", info?.name === "smoke-stdio" && info?.origin === "stdio");
  // Observable end result only. SDK 1.32.x normalises this itself and the kernel keeps a helper as
  // insurance, so this check cannot tell which of the two did it (see docs/HERMES-CONTRACT.md).
  check("a bare elicitation declaration arrives as form mode", info?.elicitation === true && info?.capabilities?.elicitation?.form !== undefined, JSON.stringify(info?.capabilities?.elicitation));
  check("sampling is reported as not declared", info?.sampling === false);

  const where = await request("tools/call", { name: "server_info", arguments: {} });
  check("server_info reports platform and wsl flag", typeof where.result?.structuredContent?.result?.platform === "string" && typeof where.result?.structuredContent?.result?.wsl === "boolean");

  // The same process also answers HTTP: one listener, both transports.
  const state = await (await fetch(`http://127.0.0.1:${String(port)}/api/state`)).json();
  check("the HTTP listener runs in the same process", state.name === identity.name && state.tools.length === tools.length);

  // Give the stray-log fixture time to fire, then judge everything stdout ever carried.
  await sleep(1200);
  const strays = stdoutLines.filter((line) => {
    try {
      return JSON.parse(line).jsonrpc !== "2.0";
    } catch {
      return true;
    }
  });
  check("stdout carries protocol only", strays.length === 0, strays[0]?.slice(0, 60) ?? `${String(stdoutLines.length)} JSON-RPC lines`);
  check("a stray console.log went to stderr instead", stderr.includes("STRAY LINE THAT MUST NOT REACH STDOUT"));
  check("the startup banner is on stderr", stderr.includes(`v`) && stderr.includes("MCP over stdio"));

  // Closing stdin is how a client says goodbye; the HTTP listener must not keep the process alive.
  server.stdin.end();
  const result = await Promise.race([exited, sleep(5000).then(() => null)]);
  check("closing stdin ends the process", result !== null && result.code === 0, result ? `exit ${String(result.code)}` : "still running after 5 s");
} catch (cause) {
  check("test run completed without an exception", false, String(cause instanceof Error ? cause.message : cause));
} finally {
  server.kill();
}

finish("stdio smoke test");
