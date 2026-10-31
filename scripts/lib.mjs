// Shared helpers for the smoke tests. Not part of the server.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The identity of whatever project this checkout currently is (read from the compiled build). */
export async function loadIdentity() {
  return (await import("../dist/identity.js")).IDENTITY;
}

/** A TCP port nothing is listening on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A private data directory, so a test never reads or writes the operator's real config. */
export function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** PASS/FAIL lines and a failure counter; `finish()` sets the exit code. */
export function checker() {
  let failed = 0;
  return {
    check(label, condition, detail = "") {
      if (!condition) failed += 1;
      console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
    },
    finish(name) {
      console.log(failed === 0 ? `\n${name}: all checks passed` : `\n${name}: ${String(failed)} check(s) FAILED`);
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}
