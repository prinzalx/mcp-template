import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { IDENTITY } from "./identity.js";

/**
 * Reads `--flag value` and bare `--flag` from the command line. Command line wins over the
 * environment, because an explicit invocation is the stronger signal.
 */
export function parseArgs(argv: readonly string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return flags;
}

export const ARGS = parseArgs(process.argv.slice(2));

/** `<PREFIX>_<NAME>` from the environment, e.g. `envVar("PORT")` reads `<PREFIX>_PORT`. */
export function envVar(name: string): string | undefined {
  const value = process.env[`${IDENTITY.envPrefix}_${name}`];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Server settings. Every value has a working default, so a missing config file is not an error:
 * the server runs with the defaults and writes them out on first save.
 *
 * Add project-specific settings here, give each a default in `loadConfig`, and read it from
 * `ctx.config.settings` in a tool.
 */
export interface Settings {
  /** Directory for the config and whatever the tools persist. */
  dataDir: string;
  /** A Streamable-HTTP session that no client touched for this long is assumed gone. */
  sessionIdleMinutes: number;
}

export interface ConfigStore {
  readonly settings: Settings;
  readonly path: string;
  save(): void;
}

function dataDirDefault(): string {
  const cli = ARGS.get("data-dir");
  if (typeof cli === "string" && cli !== "") {
    return cli;
  }
  const env = envVar("DATA_DIR");
  if (env) {
    return env;
  }
  const base = process.env.APPDATA ?? join(homedir(), `.${IDENTITY.name}`);
  return join(base, IDENTITY.name);
}

function configPathDefault(): string {
  const cli = ARGS.get("config");
  if (typeof cli === "string" && cli !== "") {
    return cli;
  }
  const env = envVar("CONFIG");
  if (env) {
    return env;
  }
  return join(dataDirDefault(), "config.json");
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadConfig(): ConfigStore {
  const path = configPathDefault();

  const settings: Settings = {
    dataDir: dataDirDefault(),
    sessionIdleMinutes: 30,
  };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }

  if (raw && typeof raw === "object") {
    const file = raw as Partial<Settings>;
    // An explicit --data-dir / env value is the stronger signal and is not overridden by the file.
    const explicitDir = ARGS.get("data-dir") !== undefined || envVar("DATA_DIR") !== undefined;
    if (!explicitDir && typeof file.dataDir === "string" && file.dataDir !== "") settings.dataDir = file.dataDir;
    settings.sessionIdleMinutes = num(file.sessionIdleMinutes, settings.sessionIdleMinutes);
  }

  try {
    mkdirSync(settings.dataDir, { recursive: true });
  } catch {
    // The data directory may already exist or be created lazily by the first save.
  }

  return {
    settings,
    path,
    save() {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      } catch {
        // A read-only profile must not break the server.
      }
    },
  };
}
