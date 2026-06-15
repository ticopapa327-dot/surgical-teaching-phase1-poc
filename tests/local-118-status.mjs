import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildStatus, parseArgs, stepStatus } = require("../scripts/local-118-status.cjs");

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

async function writeReport(dir, id, overrides = {}) {
  const report = {
    schema: "ust-local-118-validation-v1",
    id,
    ok: true,
    dryRun: false,
    startedAt: "2026-06-14T08:00:00.000Z",
    finishedAt: "2026-06-14T08:05:00.000Z",
    host: {
      hostname: "Ticopapa-nb",
      platform: "win32"
    },
    network: {
      preferredAddress: "192.168.1.118",
      addresses: [{ name: "以太网 2", address: "192.168.1.118", interfaceIndex: 14 }]
    },
    resources: {
      before: {
        ok: true,
        capturedAt: "2026-06-14T08:00:01.000Z",
        cpu: { loadPercent: 10 },
        memory: { freeGiB: 16 }
      },
      after: {
        ok: true,
        capturedAt: "2026-06-14T08:05:01.000Z",
        cpu: { loadPercent: 20 },
        memory: { freeGiB: 15 }
      }
    },
    steps: [
      { id: "build", ok: true, status: 0 },
      { id: "script-tests", ok: true, status: 0 },
      { id: "ui-smoke", ok: true, status: 0 },
      { id: "signaling-contract", ok: true, status: 0 }
    ],
    ...overrides
  };
  const jsonPath = path.join(dir, `${id}.json`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(jsonPath, json, "utf8");
  await writeFile(path.join(dir, `${id}.sha256`), `${sha256(json)}  ${id}.json\n`, "utf8");
  return { jsonPath, report };
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ust-local-118-status-"));
try {
  const quickArgs = parseArgs(["--profile", "quick", "--no-write"]);
  assert.equal(quickArgs.profile, "quick");
  assert.equal(path.basename(quickArgs.outputPath), "status-quick.json");
  const fullArgs = parseArgs(["--profile", "full", "--no-write"]);
  assert.equal(path.basename(fullArgs.outputPath), "status.json");
  assert.throws(() => parseArgs(["--profile", "strict"]), /--profile must be full or quick/);

  const full = await writeReport(tempDir, "2026-06-14T08-05-00-000Z");
  const fullStatus = buildStatus({
    profile: "full",
    reportDir: tempDir,
    maxAgeMinutes: 0,
    preferredAddress: "192.168.1.118",
    cpuMaxPercent: 80
  });
  assert.equal(fullStatus.ok, true);
  assert.equal(fullStatus.latestReport.id, "2026-06-14T08-05-00-000Z");
  assert.equal(fullStatus.latestReport.steps.ok, true);
  assert.equal(fullStatus.latestReport.address.ok, true);
  assert.equal(fullStatus.latestReport.resources.ok, true);

  const quickOnly = {
    ...full.report,
    id: "2026-06-14T08-06-00-000Z",
    finishedAt: "2026-06-14T08:06:00.000Z",
    steps: [{ id: "script-tests", ok: true, status: 0 }]
  };
  await writeReport(tempDir, quickOnly.id, quickOnly);
  const fullIgnoresQuick = buildStatus({
    profile: "full",
    reportDir: tempDir,
    maxAgeMinutes: 0,
    preferredAddress: "192.168.1.118",
    cpuMaxPercent: 80
  });
  assert.equal(fullIgnoresQuick.ok, true);
  assert.equal(fullIgnoresQuick.latestReport.id, "2026-06-14T08-05-00-000Z");
  const quickStatus = buildStatus({
    profile: "quick",
    reportDir: tempDir,
    maxAgeMinutes: 0,
    preferredAddress: "192.168.1.118",
    cpuMaxPercent: 80
  });
  assert.equal(quickStatus.ok, true);
  assert.equal(quickStatus.latestReport.id, "2026-06-14T08-06-00-000Z");

  assert.equal(stepStatus({ steps: [{ id: "script-tests", ok: true, planned: true }] }, "quick").ok, false);

  await writeReport(tempDir, "2026-06-14T08-07-00-000Z", {
    finishedAt: "2026-06-14T08:07:00.000Z",
    resources: {
      before: full.report.resources.before,
      after: {
        ok: true,
        capturedAt: "2026-06-14T08:07:01.000Z",
        cpu: { loadPercent: 91 },
        memory: { freeGiB: 15 }
      }
    }
  });
  const cpuStatus = buildStatus({
    profile: "full",
    reportDir: tempDir,
    maxAgeMinutes: 0,
    preferredAddress: "192.168.1.118",
    cpuMaxPercent: 80
  });
  assert.equal(cpuStatus.ok, false);
  assert(cpuStatus.failures.some((failure) => failure.includes("CPU load 91% exceeds 80%")));

  console.log("local 118 status test passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
