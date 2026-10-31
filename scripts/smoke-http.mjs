#!/usr/bin/env node
/**
 * Drives the server the way Hermes does when a config entry says `url:`: MCP over Streamable HTTP.
 *
 * Every check here pins down something that once broke a Hermes setup (see
 * docs/HERMES-CONTRACT.md): sessions that keep their own client capabilities, /mcp answering MCP
 * and never the dashboard, the trailing slash, a headless start without stdin.
 */
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

import { checker, freePort, loadIdentity, sleep, tempDir } from "./lib.mjs";

const { check, finish } = checker();
const identity = await loadIdentity();
const env = (extra = {}) => ({
  ...process.env,
  [`${identity.envPrefix}_DATA_DIR`]: tempDir("mcp-smoke-http"),
  ...extra,
});

const children = [];
function start(args, { port, stdin = "pipe" }) {
  const child = spawn(process.execPath, ["dist/index.js", "--port", String(port), ...args], {
    // stdin must stay open in the normal mode: the server ends when its stdio client closes it,
    // and "ignore" would look like an immediate close.
    stdio: [stdin, "pipe", "pipe"],
    env: env(),
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", () => {});
  children.push(child);
  return { child, stderr: () => stderr, exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))) };
}

/** Polls until the HTTP listener answers, so the test does not depend on a fixed sleep. */
async function waitUp(port) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/state`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(150);
  }
  throw new Error(`server on port ${String(port)} did not come up`);
}

/** One JSON-RPC POST. Notifications are answered with 202 and no body. */
async function rpc(endpoint, payload, sessionId) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  const body = dataLines.length > 0 ? JSON.parse(dataLines[0]) : text.trim().startsWith("{") ? JSON.parse(text) : null;
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    sessionId: res.headers.get("mcp-session-id"),
    body,
    text,
  };
}

let nextId = 1;
const initPayload = (capabilities, name) => ({
  jsonrpc: "2.0",
  id: nextId++,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities, clientInfo: { name, version: "0.0.0" } },
});
const call = (endpoint, sid, name, args = {}) =>
  rpc(endpoint, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, sid);

try {
  // ---------------------------------------------------------------------------------------------
  // Normal mode: stdin attached, like a terminal window on the Windows side.
  // ---------------------------------------------------------------------------------------------
  const port = await freePort();
  const main = start([], { port });
  await waitUp(port);
  const base = `http://127.0.0.1:${String(port)}/mcp`;

  const a = await rpc(base, initPayload({ elicitation: {} }, "http-client-a"));
  check("initialize over HTTP returns a session id", Boolean(a.sessionId), String(a.sessionId).slice(0, 8));
  check("serverInfo carries this project's name", a.body?.result?.serverInfo?.name === identity.name);
  const sidA = a.sessionId;

  const initialized = await rpc(base, { jsonrpc: "2.0", method: "notifications/initialized" }, sidA);
  check("notifications/initialized is accepted (202)", initialized.status === 202, `HTTP ${String(initialized.status)}`);

  const list = await rpc(base, { jsonrpc: "2.0", id: nextId++, method: "tools/list" }, sidA);
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  check("tools/list over HTTP returns the tools", ["echo", "server_info", "client_info"].every((n) => names.includes(n)), names.join(", "));

  const echo = await call(base, sidA, "echo", { text: "over http" });
  check("tools/call echo over HTTP", echo.body?.result?.content?.[0]?.text === "over http");

  const invalid = await call(base, sidA, "echo", {});
  check("invalid input is an error the model can read", invalid.body?.result?.isError === true || invalid.body?.error !== undefined);

  // --- sessions keep their own client capabilities (the "popup never attempted" bug) ----------
  const infoA = (await call(base, sidA, "client_info")).body?.result?.structuredContent?.result;
  check("session A sees its own client, with elicitation in form mode",infoA?.name === "http-client-a" && infoA?.elicitation === true && infoA?.capabilities?.elicitation?.form !== undefined);
  check("origin is http", infoA?.origin === "http");

  const b = await rpc(base, initPayload({ sampling: {} }, "http-client-b"));
  const sidB = b.sessionId;
  await rpc(base, { jsonrpc: "2.0", method: "notifications/initialized" }, sidB);
  const infoB = (await call(base, sidB, "client_info")).body?.result?.structuredContent?.result;
  check("session B declared sampling, not elicitation", infoB?.name === "http-client-b" && infoB?.sampling === true && infoB?.elicitation === false);
  const infoA2 = (await call(base, sidA, "client_info")).body?.result?.structuredContent?.result;
  check("session A is untouched by session B", infoA2?.name === "http-client-a" && infoA2?.sampling === false);
  check("two sessions are two session ids", sidA !== sidB);

  // --- session lifecycle -----------------------------------------------------------------------
  const unknown = await rpc(base, { jsonrpc: "2.0", id: nextId++, method: "tools/list" }, "00000000-0000-0000-0000-000000000000");
  check("an unknown session id answers 404 JSON", unknown.status === 404 && unknown.contentType.includes("json"), `HTTP ${String(unknown.status)}`);

  const deleted = await fetch(base, {
    method: "DELETE",
    headers: { Accept: "application/json, text/event-stream", "mcp-session-id": sidB, "MCP-Protocol-Version": "2025-06-18" },
  });
  check("DELETE ends a session", deleted.status === 200, `HTTP ${String(deleted.status)}`);
  const afterDelete = await rpc(base, { jsonrpc: "2.0", id: nextId++, method: "tools/list" }, sidB);
  check("a deleted session is gone (404)", afterDelete.status === 404, `HTTP ${String(afterDelete.status)}`);
  const stillA = await call(base, sidA, "echo", { text: "still here" });
  check("deleting B does not touch A", stillA.body?.result?.content?.[0]?.text === "still here");

  // --- /mcp belongs to MCP, never to the dashboard ---------------------------------------------
  const slashed = await rpc(`${base}/`, initPayload({}, "http-client-slash"));
  check("a trailing slash (/mcp/) reaches the MCP transport", Boolean(slashed.sessionId) && !slashed.contentType.includes("html"), slashed.contentType.split(";")[0]);

  const bare = await fetch(base, { headers: {} });
  const bareText = await bare.text();
  check("a bare GET /mcp is MCP's 406, not the dashboard", bare.status === 406 && bareText.includes("Not Acceptable") && !bareText.includes("<html"), `HTTP ${String(bare.status)}`);

  // --- dashboard and API on the same listener --------------------------------------------------
  const page = await fetch(`http://127.0.0.1:${String(port)}/`);
  const pageText = await page.text();
  check("GET / serves the dashboard", page.headers.get("content-type")?.includes("text/html") && pageText.includes("<title>"));

  const state = await (await fetch(`http://127.0.0.1:${String(port)}/api/state`)).json();
  check("/api/state reports tools, sessions and the last client", state.tools.length >= 3 && state.sessions >= 1 && state.client !== null, `${String(state.sessions)} session(s)`);

  const ran = await (await fetch(`http://127.0.0.1:${String(port)}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "echo", args: { text: "from the dashboard" } }),
  })).json();
  check("/api/run executes a tool through the same handler", ran.ok === true && ran.output === "from the dashboard");

  const missing = await fetch(`http://127.0.0.1:${String(port)}/api/nope`);
  check("an unknown /api route answers 404 JSON", missing.status === 404 && (missing.headers.get("content-type") ?? "").includes("json"));

  // --- bind address: reachable from WSL by default, narrowable on purpose -----------------------
  const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (external) {
    const reaches = (p) => fetch(`http://${external}:${String(p)}/api/state`).then((r) => r.ok, () => false);
    check("the default bind reaches beyond loopback (a WSL client needs this)", await reaches(port), external);
    const narrowPort = await freePort();
    start(["--host", "127.0.0.1"], { port: narrowPort });
    await waitUp(narrowPort);
    check("--host 127.0.0.1 narrows the bind", !(await reaches(narrowPort)), `not reachable via ${external}`);
  } else {
    console.log("SKIP  bind checks (this host has no non-loopback IPv4 address)");
  }

  // --- a second server on the same port says so clearly ----------------------------------------
  const clash = start([], { port });
  const clashCode = await Promise.race([clash.exited, sleep(8000).then(() => "timeout")]);
  check("a busy port is a clear fatal error, not a crash trace", clashCode === 1 && clash.stderr().includes("already in use"), clash.stderr().split("\n").find((l) => l.includes("fatal")) ?? "");

  // ---------------------------------------------------------------------------------------------
  // Headless mode: no stdin at all, like an autostart entry or a service.
  // ---------------------------------------------------------------------------------------------
  const headlessPort = await freePort();
  const headless = start(["--no-stdio"], { port: headlessPort, stdin: "ignore" });
  await waitUp(headlessPort);
  await sleep(1500);
  const alive = headless.child.exitCode === null;
  check("--no-stdio keeps running without stdin", alive);
  const h = await rpc(`http://127.0.0.1:${String(headlessPort)}/mcp`, initPayload({}, "http-client-headless"));
  check("--no-stdio still serves MCP over HTTP", Boolean(h.sessionId));
  check("the banner says stdio is disabled", headless.stderr().includes("disabled (--no-stdio)"));

  const nothing = start(["--no-stdio", "--no-web"], { port: await freePort(), stdin: "ignore" });
  const nothingCode = await Promise.race([nothing.exited, sleep(8000).then(() => "timeout")]);
  check("--no-web with --no-stdio is refused (no transport left)", nothingCode === 1 && nothing.stderr().includes("no transport"));

  // The normal-mode server is still healthy at the end.
  check("the main server survived the whole run", main.child.exitCode === null);
} catch (cause) {
  check("test run completed without an exception", false, String(cause instanceof Error ? cause.message : cause));
} finally {
  for (const child of children) child.kill();
}

finish("HTTP smoke test");
