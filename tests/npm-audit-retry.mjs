import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runAuditRetry(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/npm-audit-retry.cjs", "--audit-level=high"], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const tempDir = await mkdtemp(path.join(tmpdir(), "ust-audit-retry-"));
try {
  const stateFile = path.join(tempDir, "attempts.txt");
  const fakeNpm = path.join(tempDir, "fake-npm.cjs");
  await writeFile(
    fakeNpm,
    `
const { readFileSync, writeFileSync } = require("node:fs");
const stateFile = process.env.FAKE_AUDIT_STATE_FILE;
let attempts = 0;
try {
  attempts = Number(readFileSync(stateFile, "utf8")) || 0;
} catch {}
writeFileSync(stateFile, String(attempts + 1));
if (attempts === 0) {
  console.error("ECONNRESET while contacting npm audit endpoint");
  process.exit(1);
}
console.log("found 0 vulnerabilities");
process.exit(0);
`,
    "utf8"
  );

  const result = await runAuditRetry({
    npm_execpath: fakeNpm,
    FAKE_AUDIT_STATE_FILE: stateFile,
    NPM_AUDIT_ATTEMPTS: "2",
    NPM_AUDIT_RETRY_DELAY_MS: "0"
  });

  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /found 0 vulnerabilities/);
  assert.match(result.stderr, /retrying 2\/2/);
  assert.equal(await readFile(stateFile, "utf8"), "2");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("npm audit retry test passed");
