#!/usr/bin/env node
/**
 * Turns a fresh copy of the template into a named project.
 *
 *   npm run init -- --name acme-mcp --port 8790
 *   npm run init -- --name acme-mcp --port 8790 --prefix ACME --key acme --title "Acme MCP" \
 *                   --description "What it does in one sentence"
 *
 * It rewrites the identity in exactly the places that carry it: src/identity.ts, package.json,
 * package-lock.json, the docs, the skill and the Hermes check script. Nothing under src/ other than
 * identity.ts mentions the name, the env prefix or the port, so nothing else needs touching.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(root, rel), "utf8");
const write = (rel, content) => writeFileSync(join(root, rel), content, "utf8");

// Ports already taken by the projects this was built from; a new project must not reuse them.
const TAKEN_PORTS = new Map([
  [8787, "winadmin-mcp"],
  [8788, "winsecure-mcp"],
]);

function parseFlags(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return flags;
}

function die(message) {
  console.error(`init: ${message}`);
  process.exit(1);
}

const flags = parseFlags(process.argv.slice(2));
if (flags.get("help") === true || flags.size === 0) {
  console.log(`usage: npm run init -- --name <slug> --port <n> [options]

  --name <slug>        package and server name, lowercase, e.g. acme-mcp          (required)
  --port <n>           HTTP port, one per project on this machine                 (required)
  --prefix <PREFIX>    env var prefix, e.g. ACME -> ACME_PORT   (default: derived from the name)
  --key <key>          the key under mcp_servers: in Hermes' config.yaml  (default: name without "-mcp")
  --title "<text>"     title shown in the dashboard                (default: derived from the name)
  --description "<t>"  one sentence                                (default: keeps the template's)
  --force              run again on a project that was already initialised`);
  process.exit(flags.size === 0 ? 1 : 0);
}

const name = String(flags.get("name") ?? "");
const port = Number(flags.get("port"));
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) die('--name must be lowercase letters, digits and hyphens, e.g. "acme-mcp"');
if (!Number.isInteger(port) || port < 1024 || port > 65535) die("--port must be a number between 1024 and 65535");
if (TAKEN_PORTS.has(port)) die(`port ${String(port)} belongs to ${TAKEN_PORTS.get(port)}; pick another`);

const short = name.replace(/-mcp$/, "");
const key = String(flags.get("key") ?? short);
const prefix = String(flags.get("prefix") ?? short.replace(/[^a-z0-9]/g, "").toUpperCase().slice(0, 6));
const title = String(flags.get("title") ?? short.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") + " MCP");
if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) die('--prefix must be uppercase letters and digits, e.g. "ACME"');
if (!/^[a-z][a-z0-9_-]*$/.test(key)) die("--key must be lowercase letters, digits, hyphen or underscore");

// What the checkout currently is, read from the one file that knows.
const identitySource = read("src/identity.ts");
const grab = (field) => new RegExp(`\\n  ${field}: (?:"([^"]*)"|(\\d+))`).exec(identitySource);
const current = {
  name: grab("name")?.[1],
  title: grab("title")?.[1],
  envPrefix: grab("envPrefix")?.[1],
  port: grab("defaultPort")?.[2],
};
if (Object.values(current).some((v) => v === undefined)) die("could not read the current identity from src/identity.ts");
if (current.name !== "mcp-template" && flags.get("force") !== true) {
  die(`this checkout is already "${current.name}". Pass --force to rename it again.`);
}
const description = String(flags.get("description") ?? /\n  description: "([^"]*)"/.exec(identitySource)?.[1] ?? "");

// 1. src/identity.ts — the single source of the identity.
const quoted = (value) => JSON.stringify(value);
write(
  "src/identity.ts",
  identitySource
    .replace(/(\n  name: )"[^"]*"/, `$1${quoted(name)}`)
    .replace(/(\n  title: )"[^"]*"/, `$1${quoted(title)}`)
    .replace(/(\n  description: )"[^"]*"/, `$1${quoted(description)}`)
    .replace(/(\n  envPrefix: )"[^"]*"/, `$1${quoted(prefix)}`)
    .replace(/(\n  defaultPort: )\d+/, `$1${String(port)}`),
);

// 2. package.json and package-lock.json
const pkg = JSON.parse(read("package.json"));
pkg.name = name;
pkg.description = description;
pkg.bin = { [name]: "dist/index.js" };
write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

if (existsSync(join(root, "package-lock.json"))) {
  const lock = JSON.parse(read("package-lock.json"));
  lock.name = name;
  if (lock.packages?.[""]) {
    lock.packages[""].name = name;
    lock.packages[""].bin = pkg.bin;
  }
  write("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}

// 3. The skill directory carries the name, so it is renamed before its contents are rewritten.
const skillDir = `skills/${current.name}`;
if (existsSync(join(root, skillDir)) && skillDir !== `skills/${name}`) renameSync(join(root, skillDir), join(root, `skills/${name}`));

// 4. Text files: docs, skill, check script. Tokens are replaced as plain strings.
const textFiles = ["README.md", "docs/HERMES-CONTRACT.md", "docs/NEW-PROJECT-PROMPT.md", `skills/${name}/SKILL.md`, "scripts/hermes-check.sh"];
const replacements = [
  [new RegExp(current.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), name],
  [new RegExp(current.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), title],
  [new RegExp(current.envPrefix, "g"), prefix],
  [new RegExp(`\\b${current.port}\\b`, "g"), String(port)],
  // The lowercase form of the old prefix is the Hermes config key in the docs (mcp_servers: <key>:).
  [new RegExp(current.envPrefix.toLowerCase(), "g"), key],
];
for (const file of textFiles) {
  if (!existsSync(join(root, file))) continue;
  let content = read(file);
  for (const [pattern, value] of replacements) content = content.replace(pattern, value);
  write(file, content);
}

console.log(`initialised "${name}"
  title        ${title}
  env prefix   ${prefix}_  (${prefix}_PORT, ${prefix}_HOST, ${prefix}_DATA_DIR, …)
  port         ${String(port)}
  hermes key   ${key}  (mcp_servers: ${key}:  ->  tools appear as mcp__${key}__<tool>)

next:
  1. edit "instructions" and "description" in src/identity.ts
  2. npm ci && npm run build && npm test
  3. add your tools under src/modules/ (see README.md, "Adding a tool")
  4. check the port table in docs/HERMES-CONTRACT.md: your port is already in it; add any other
     project on this machine that is missing`);
