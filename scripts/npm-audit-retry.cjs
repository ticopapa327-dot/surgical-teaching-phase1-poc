const { spawnSync } = require("node:child_process");

const auditArgs = ["audit", ...process.argv.slice(2)];
const maxAttempts = Math.max(1, Number(process.env.NPM_AUDIT_ATTEMPTS || 3));
const retryDelayMs = Math.max(0, Number(process.env.NPM_AUDIT_RETRY_DELAY_MS || 1500));

const transientPatterns = [
  /audit endpoint returned an error/i,
  /client network socket disconnected/i,
  /secure TLS connection/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /5\d\d/
];

function sleep(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientFailure(result) {
  if (result.error) return true;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return transientPatterns.some((pattern) => pattern.test(output));
}

function cleanOutput(value) {
  return (value || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "undefined")
    .join("\n")
    .trim();
}

function writeResultOutput(result) {
  const stdout = cleanOutput(result.stdout);
  const stderr = cleanOutput(result.stderr);
  if (stdout) process.stdout.write(`${stdout}\n`);
  if (stderr) process.stderr.write(`${stderr}\n`);
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...auditArgs], { encoding: "utf8" })
    : spawnSync("npm", auditArgs, { encoding: "utf8", shell: process.platform === "win32" });

  if (result.status === 0) {
    writeResultOutput(result);
    process.exit(0);
  }

  const shouldRetry = attempt < maxAttempts && isTransientFailure(result);
  if (!shouldRetry) {
    writeResultOutput(result);
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }

  console.warn(`npm audit failed due to a transient network error; retrying ${attempt + 1}/${maxAttempts}...`);
  sleep(retryDelayMs);
}
