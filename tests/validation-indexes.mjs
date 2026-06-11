import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredStrictStepIds = [
  "117-probe",
  "117-signal",
  "117-media",
  "117-audio",
  "117-media-diagnostics",
  "117-audio-diagnostics",
  "137-probe",
  "137-signal",
  "137-media",
  "137-audio",
  "137-media-diagnostics",
  "137-audio-diagnostics",
  "117-137-conference"
];

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

async function writeJsonWithChecksum(filePath, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, json, "utf8");
  await writeFile(filePath.replace(/\.json$/i, ".sha256"), `${sha256(json)}  ${path.basename(filePath)}\n`, "utf8");
}

async function writeCrossReport(reportDir, id, { ok = true, withArtifact = true, strict = false, steps = null } = {}) {
  const artifactDir = path.join(reportDir, `${id}-artifacts`);
  const artifactPath = path.join(artifactDir, "snapshot.json");
  const manifestPath = path.join(artifactDir, "artifact-manifest.json");
  let artifactArchive = null;

  if (withArtifact) {
    await mkdir(artifactDir, { recursive: true });
    const artifactJson = `${JSON.stringify({ id, kind: "snapshot" }, null, 2)}\n`;
    await writeFile(artifactPath, artifactJson, "utf8");
    const manifest = {
      artifactsDir: artifactDir,
      createdAt: "2026-06-11T00:00:01.000Z",
      sourceMtimeNotBefore: "2026-06-11T00:00:00.000Z",
      fileCount: 1,
      files: [
        {
          sourcePath: "test-results/example/snapshot.json",
          targetPath: artifactPath,
          bytes: Buffer.byteLength(artifactJson),
          sha256: sha256(artifactJson)
        }
      ]
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    artifactArchive = {
      artifactsDir: artifactDir,
      manifestPath: manifestPath,
      fileCount: 1
    };
  }

  const report = {
    ok,
    startedAt: `2026-06-11T00:00:${id.endsWith("fail") ? "02" : "01"}.000Z`,
    finishedAt: `2026-06-11T00:00:${id.endsWith("fail") ? "03" : "02"}.000Z`,
    config: strict
      ? {
          strictRemoteCoverage: true,
          requireWindows117: true,
          requireKylin137: true,
          requireConference: true,
          skipWindows117: false,
          skipKylin137: false
        }
      : {},
    healthClean: true,
    healthAfter: {
      ok: true,
      endpoints: 0,
      sessions: 0,
      pendingCalls: 0
    },
    artifactArchive,
    steps:
      steps ||
      (strict
        ? requiredStrictStepIds.map((stepId) => ({
            id: stepId,
            status: ok ? "passed" : "failed",
            attemptCount: 1,
            maxAttempts: 1
          }))
        : [
            {
              id: ok ? "117-signal" : "137-signal",
              status: ok ? "passed" : "failed",
              attemptCount: 1,
              maxAttempts: 1
            }
          ])
  };
  const reportPath = path.join(reportDir, `${id}.json`);
  await writeJsonWithChecksum(reportPath, report);
  return { report, reportPath };
}

async function writeContinuousLedger(
  reportDir,
  id,
  crossReportPath,
  { ok = true, crossScript = "test:remote:cross:strict" } = {}
) {
  const ledger = {
    id,
    ok,
    startedAt: "2026-06-11T00:01:00.000Z",
    finishedAt: "2026-06-11T00:02:00.000Z",
    stopReason: "iteration limit reached",
    config: {
      reportDir,
      crossScript,
      iterations: 1,
      durationMs: 0,
      intervalSeconds: 1,
      stopOnFailure: false
    },
    cycles: [
      {
        iteration: 1,
        ok,
        startedAt: "2026-06-11T00:01:00.000Z",
        finishedAt: "2026-06-11T00:02:00.000Z",
        durationMs: 60000,
        cross: {
          status: ok ? "passed" : "failed"
        },
        index: {
          status: "passed"
        },
        crossReport: {
          reportPath: crossReportPath,
          ok
        }
      }
    ]
  };
  const ledgerPath = path.join(reportDir, `${id}.json`);
  await writeJsonWithChecksum(ledgerPath, ledger);
  return { ledger, ledgerPath };
}

function runNode(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--json", "--no-write"], {
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

const tempDir = await mkdtemp(path.join(os.tmpdir(), "ust-validation-indexes-"));

try {
  const reportDir = path.join(tempDir, "reports-ok");
  await mkdir(reportDir, { recursive: true });
  const pass = await writeCrossReport(reportDir, "2026-06-11T00-00-01-000Z");
  await writeCrossReport(reportDir, "2026-06-11T00-00-02-000Z-fail", { ok: false });
  await writeFile(path.join(reportDir, "status.json"), `${JSON.stringify({ ok: true }, null, 2)}\n`, "utf8");
  await writeContinuousLedger(reportDir, "continuous-2026-06-11T00-01-00-000Z", pass.reportPath);

  const crossIndex = await runNode("scripts/validation-report-index.cjs", {
    UST_VALIDATION_REPORT_DIR: reportDir
  });
  assert.equal(crossIndex.code, 0, `${crossIndex.stdout}\n${crossIndex.stderr}`);
  const crossIndexJson = JSON.parse(crossIndex.stdout);
  assert.equal(crossIndexJson.totalReports, 2);
  assert.equal(crossIndexJson.passingReports, 1);
  assert.equal(crossIndexJson.failingReports, 1);
  assert.equal(crossIndexJson.evidenceFailures, 0);
  assert.equal(crossIndexJson.reports.some((report) => report.id.startsWith("continuous-")), false);

  const continuousIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: reportDir
  });
  assert.equal(continuousIndex.code, 0, `${continuousIndex.stdout}\n${continuousIndex.stderr}`);
  const continuousIndexJson = JSON.parse(continuousIndex.stdout);
  assert.equal(continuousIndexJson.totalLedgers, 1);
  assert.equal(continuousIndexJson.passingLedgers, 1);
  assert.equal(continuousIndexJson.evidenceFailures, 0);
  assert.equal(continuousIndexJson.ledgers[0].cycles[0].crossReport.reportOk, true);
  assert.equal(continuousIndexJson.ledgers[0].cycles[0].crossReport.artifacts.ok, true);

  const strictStatusDir = path.join(tempDir, "status-strict-ok");
  await mkdir(strictStatusDir, { recursive: true });
  const strictPass = await writeCrossReport(strictStatusDir, "2026-06-11T00-06-00-000Z", { strict: true });
  await writeContinuousLedger(strictStatusDir, "continuous-2026-06-11T00-06-30-000Z", strictPass.reportPath);
  const strictStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: strictStatusDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(strictStatus.code, 0, `${strictStatus.stdout}\n${strictStatus.stderr}`);
  const strictStatusJson = JSON.parse(strictStatus.stdout);
  assert.equal(strictStatusJson.ok, true);
  assert.equal(strictStatusJson.latestStrictLedger.latestCycle.crossStatus, "passed");
  assert.equal(strictStatusJson.latestStrictReport.strictCoverage.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.steps.ok, true);
  assert.equal(strictStatusJson.latestStrictReport.artifacts.ok, true);

  const noStrictLedgerDir = path.join(tempDir, "status-no-strict-ledger");
  await mkdir(noStrictLedgerDir, { recursive: true });
  const noStrictReport = await writeCrossReport(noStrictLedgerDir, "2026-06-11T00-07-00-000Z", { strict: true });
  await writeContinuousLedger(
    noStrictLedgerDir,
    "continuous-2026-06-11T00-07-30-000Z",
    noStrictReport.reportPath,
    { crossScript: "test:remote:cross" }
  );
  const noStrictStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: noStrictLedgerDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(noStrictStatus.code, 1);
  const noStrictStatusJson = JSON.parse(noStrictStatus.stdout);
  assert.equal(noStrictStatusJson.failures.includes("no strict continuous ledger found"), true);

  const missingStrictStepDir = path.join(tempDir, "status-missing-strict-step");
  await mkdir(missingStrictStepDir, { recursive: true });
  const missingStepReport = await writeCrossReport(missingStrictStepDir, "2026-06-11T00-08-00-000Z", {
    strict: true,
    steps: requiredStrictStepIds
      .filter((stepId) => stepId !== "117-137-conference")
      .map((stepId) => ({
        id: stepId,
        status: "passed",
        attemptCount: 1,
        maxAttempts: 1
      }))
  });
  await writeContinuousLedger(
    missingStrictStepDir,
    "continuous-2026-06-11T00-08-30-000Z",
    missingStepReport.reportPath
  );
  const missingStepStatus = await runNode("scripts/validation-status.cjs", {
    UST_VALIDATION_REPORT_DIR: missingStrictStepDir,
    UST_VALIDATION_STATUS_MAX_AGE_MINUTES: "0"
  });
  assert.equal(missingStepStatus.code, 1);
  const missingStepStatusJson = JSON.parse(missingStepStatus.stdout);
  assert.equal(missingStepStatusJson.latestStrictReport.steps.missing.includes("117-137-conference"), true);

  const tamperedDir = path.join(tempDir, "reports-tampered");
  await mkdir(tamperedDir, { recursive: true });
  const tampered = await writeCrossReport(tamperedDir, "2026-06-11T00-03-00-000Z");
  const tamperedJson = JSON.parse(await readFile(tampered.reportPath, "utf8"));
  tamperedJson.healthAfter.endpoints = 1;
  await writeFile(tampered.reportPath, `${JSON.stringify(tamperedJson, null, 2)}\n`, "utf8");

  const tamperedIndex = await runNode("scripts/validation-report-index.cjs", {
    UST_VALIDATION_REPORT_DIR: tamperedDir
  });
  assert.equal(tamperedIndex.code, 1);
  const tamperedIndexJson = JSON.parse(tamperedIndex.stdout);
  assert.equal(tamperedIndexJson.evidenceFailures, 1);
  assert.equal(tamperedIndexJson.reports[0].checksum.ok, false);

  const missingCrossDir = path.join(tempDir, "continuous-missing-cross");
  await mkdir(missingCrossDir, { recursive: true });
  await writeContinuousLedger(
    missingCrossDir,
    "continuous-2026-06-11T00-04-00-000Z",
    path.join(missingCrossDir, "missing-cross-report.json")
  );

  const missingCrossIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: missingCrossDir
  });
  assert.equal(missingCrossIndex.code, 1);
  const missingCrossIndexJson = JSON.parse(missingCrossIndex.stdout);
  assert.equal(missingCrossIndexJson.evidenceFailures, 1);
  assert.equal(missingCrossIndexJson.ledgers[0].cycles[0].crossReport.error, "cross report missing");

  const tamperedArtifactDir = path.join(tempDir, "continuous-tampered-artifact");
  await mkdir(tamperedArtifactDir, { recursive: true });
  const artifactTampered = await writeCrossReport(tamperedArtifactDir, "2026-06-11T00-05-00-000Z");
  const artifactPath = path.join(tamperedArtifactDir, "2026-06-11T00-05-00-000Z-artifacts", "snapshot.json");
  await writeFile(artifactPath, `${JSON.stringify({ id: "changed", kind: "snapshot" }, null, 2)}\n`, "utf8");
  await writeContinuousLedger(
    tamperedArtifactDir,
    "continuous-2026-06-11T00-05-30-000Z",
    artifactTampered.reportPath
  );

  const tamperedArtifactIndex = await runNode("scripts/continuous-validation-index.cjs", {
    UST_VALIDATION_REPORT_DIR: tamperedArtifactDir
  });
  assert.equal(tamperedArtifactIndex.code, 1);
  const tamperedArtifactIndexJson = JSON.parse(tamperedArtifactIndex.stdout);
  assert.equal(tamperedArtifactIndexJson.evidenceFailures, 1);
  assert.equal(tamperedArtifactIndexJson.ledgers[0].cycles[0].crossReport.artifacts.hashMismatches, 1);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log("validation indexes test passed");
