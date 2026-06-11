const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULTS = {
  reportDir: path.join("validation-results", "cross-machine-validation"),
  outputPath: path.join("validation-results", "cross-machine-validation", "status.json"),
  expectedCrossScript: "test:remote:cross:strict",
  maxAgeMinutes: 720
};

const REQUIRED_STRICT_STEPS = [
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

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function parseNonNegativeNumber(value, fallback, name) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return number;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/validation-status.cjs [options]",
    "",
    "Options:",
    "  --json                         Print status as JSON",
    "  --no-write                     Do not write status.json",
    "  --max-age-minutes <minutes>    Fail when latest strict ledger is older than this; 0 disables",
    "  --cross-script <npm-script>    Expected continuous ledger cross script",
    "  --help                         Show this help",
    "",
    "Environment:",
    "  UST_VALIDATION_REPORT_DIR             Default validation report directory",
    "  UST_VALIDATION_STATUS_PATH            Default status JSON output path",
    "  UST_VALIDATION_STATUS_CROSS_SCRIPT    Expected strict cross script",
    "  UST_VALIDATION_STATUS_MAX_AGE_MINUTES Default freshness limit"
  ].join("\n");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    noWrite: argv.includes("--no-write"),
    help: argv.includes("--help") || argv.includes("-h"),
    reportDir: env("UST_VALIDATION_REPORT_DIR", DEFAULTS.reportDir),
    outputPath: env("UST_VALIDATION_STATUS_PATH", DEFAULTS.outputPath),
    expectedCrossScript:
      readArg(argv, "--cross-script") ||
      env("UST_VALIDATION_STATUS_CROSS_SCRIPT", DEFAULTS.expectedCrossScript),
    maxAgeMinutes: parseNonNegativeNumber(
      readArg(argv, "--max-age-minutes") || env("UST_VALIDATION_STATUS_MAX_AGE_MINUTES", DEFAULTS.maxAgeMinutes),
      DEFAULTS.maxAgeMinutes,
      "--max-age-minutes"
    )
  };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readChecksum(jsonPath) {
  const checksumPath = jsonPath.replace(/\.json$/i, ".sha256");
  if (!fs.existsSync(checksumPath)) {
    return {
      ok: false,
      checksumPath,
      expected: "",
      actual: fs.existsSync(jsonPath) ? sha256File(jsonPath) : "",
      error: "checksum file missing"
    };
  }
  const expected = fs.readFileSync(checksumPath, "utf8").split(/\s+/)[0].trim().toLowerCase();
  const actual = sha256File(jsonPath);
  return {
    ok: expected === actual,
    checksumPath,
    expected,
    actual,
    error: expected === actual ? "" : "checksum mismatch"
  };
}

function resolveReportPath(reportDir, reportPath) {
  if (!reportPath) return "";
  const direct = path.resolve(reportPath);
  if (fs.existsSync(direct)) return direct;
  return path.resolve(reportDir, path.basename(reportPath));
}

function inspectArtifactArchive(report, reportPath) {
  const archive = report.artifactArchive || {};
  const manifestPath = archive.manifestPath || "";
  if (!report.artifactArchive) {
    return {
      ok: false,
      legacy: true,
      manifestPath: "",
      fileCount: 0,
      verifiedFiles: 0,
      missingFiles: 0,
      hashMismatches: 0,
      error: "strict status requires artifact archive"
    };
  }

  const resolvedManifestPath = manifestPath ? path.resolve(path.dirname(reportPath), "..", "..", manifestPath) : "";
  const directManifestPath = manifestPath ? path.resolve(manifestPath) : "";
  const candidateManifestPath = fs.existsSync(directManifestPath) ? directManifestPath : resolvedManifestPath;
  if (!manifestPath || !fs.existsSync(candidateManifestPath)) {
    return {
      ok: false,
      legacy: false,
      manifestPath,
      fileCount: Number(archive.fileCount || 0),
      verifiedFiles: 0,
      missingFiles: Number(archive.fileCount || 0),
      hashMismatches: 0,
      error: "artifact manifest missing"
    };
  }

  const manifest = readJson(candidateManifestPath);
  let missingFiles = 0;
  let hashMismatches = 0;
  let verifiedFiles = 0;
  for (const file of manifest.files || []) {
    const targetPath = path.resolve(file.targetPath);
    if (!fs.existsSync(targetPath)) {
      missingFiles += 1;
      continue;
    }
    const actual = sha256File(targetPath);
    if (actual !== file.sha256) {
      hashMismatches += 1;
      continue;
    }
    verifiedFiles += 1;
  }

  return {
    ok: missingFiles === 0 && hashMismatches === 0 && verifiedFiles === Number(manifest.fileCount || 0),
    legacy: false,
    manifestPath,
    fileCount: Number(manifest.fileCount || 0),
    verifiedFiles,
    missingFiles,
    hashMismatches,
    error: missingFiles || hashMismatches ? "artifact verification failed" : ""
  };
}

function resolveArtifactManifestPath(report, reportPath) {
  const manifestPath = report?.artifactArchive?.manifestPath || "";
  if (!manifestPath) return "";
  const directManifestPath = path.resolve(manifestPath);
  if (fs.existsSync(directManifestPath)) return directManifestPath;
  const relativeManifestPath = path.resolve(path.dirname(reportPath), "..", "..", manifestPath);
  return fs.existsSync(relativeManifestPath) ? relativeManifestPath : "";
}

function readJsonArtifact(manifest, sourceDirName) {
  const file = (manifest.files || [])
    .filter((item) => String(item.sourcePath || item.targetPath || "").includes(sourceDirName))
    .filter((item) => String(item.targetPath || "").toLowerCase().endsWith(".json"))
    .sort((a, b) => String(b.targetPath || "").localeCompare(String(a.targetPath || "")))[0];
  if (!file?.targetPath) return null;
  const targetPath = path.resolve(file.targetPath);
  if (!fs.existsSync(targetPath)) return null;
  try {
    return readJson(targetPath);
  } catch {
    return null;
  }
}

function remoteResourcesStatus(report, reportPath) {
  const manifestPath = resolveArtifactManifestPath(report, reportPath);
  if (!manifestPath) {
    return {
      ok: false,
      windows117Ok: false,
      kylin137Ok: false,
      error: "artifact manifest missing"
    };
  }
  const manifest = readJson(manifestPath);
  const windowsProbe = readJsonArtifact(manifest, "remote-windows-probe");
  const kylinProbe = readJsonArtifact(manifest, "remote-kylin-probe");
  const windowsResources = windowsProbe?.checks?.remote?.checks?.resources || null;
  const kylinResources = kylinProbe?.checks?.resources || null;
  const windows117Ok = Boolean(windowsResources?.capturedAt && windowsResources?.memory && windowsResources?.processes);
  const kylin137Ok = Boolean(kylinResources?.capturedAt && kylinResources?.memory && kylinResources?.processes);
  return {
    ok: windows117Ok && kylin137Ok,
    windows117Ok,
    kylin137Ok,
    windowsCapturedAt: windowsResources?.capturedAt || "",
    kylinCapturedAt: kylinResources?.capturedAt || "",
    windowsMemoryFreeGiB: windowsResources?.memory?.freeGiB ?? null,
    kylinMemoryAvailableGiB: kylinResources?.memory?.availableGiB ?? null
  };
}

function collectLedgers(reportDir, expectedCrossScript) {
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return [];
  return fs
    .readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("continuous-") && entry.name.endsWith(".json"))
    .map((entry) => path.join(reportDir, entry.name))
    .map((ledgerPath) => ({ ledgerPath, ledger: readJson(ledgerPath), checksum: readChecksum(ledgerPath) }))
    .filter((item) => item.ledger?.config?.crossScript === expectedCrossScript)
    .sort((a, b) => String(b.ledger.startedAt || "").localeCompare(String(a.ledger.startedAt || "")));
}

function latestCycle(ledger) {
  const cycles = Array.isArray(ledger.cycles) ? ledger.cycles : [];
  return cycles[cycles.length - 1] || null;
}

function stepStatus(report) {
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const missing = REQUIRED_STRICT_STEPS.filter((id) => !byId.has(id));
  const failed = steps.filter((step) => step.status === "failed").map((step) => step.id);
  const skipped = steps.filter((step) => step.status === "skipped").map((step) => step.id);
  const requiredNotPassed = REQUIRED_STRICT_STEPS.filter((id) => byId.get(id)?.status !== "passed");
  return {
    ok: missing.length === 0 && failed.length === 0 && skipped.length === 0 && requiredNotPassed.length === 0,
    required: REQUIRED_STRICT_STEPS,
    missing,
    failed,
    skipped,
    requiredNotPassed,
    count: steps.length
  };
}

function strictCoverage(report) {
  const config = report.config || {};
  const ok =
    config.strictRemoteCoverage === true &&
    config.requireWindows117 === true &&
    config.requireKylin137 === true &&
    config.requireConference === true &&
    config.skipWindows117 === false &&
    config.skipKylin137 === false;
  return {
    ok,
    strictRemoteCoverage: config.strictRemoteCoverage === true,
    requireWindows117: config.requireWindows117 === true,
    requireKylin137: config.requireKylin137 === true,
    requireConference: config.requireConference === true,
    skipWindows117: config.skipWindows117 === true,
    skipKylin137: config.skipKylin137 === true
  };
}

function localResourcesStatus(report) {
  const resources = report.systemResources || {};
  const before = resources.before || null;
  const after = resources.after || null;
  const beforeOk = Boolean(before?.capturedAt && before?.memory && before?.system?.ok === true);
  const afterOk = Boolean(after?.capturedAt && after?.memory && after?.system?.ok === true);
  return {
    ok: beforeOk && afterOk,
    beforeOk,
    afterOk,
    beforeCapturedAt: before?.capturedAt || "",
    afterCapturedAt: after?.capturedAt || "",
    beforeMemoryFreeGiB: before?.system?.memory?.freeGiB ?? before?.memory?.freeGiB ?? null,
    afterMemoryFreeGiB: after?.system?.memory?.freeGiB ?? after?.memory?.freeGiB ?? null
  };
}

function ageStatus(finishedAt, maxAgeMinutes) {
  if (!maxAgeMinutes) {
    return { ok: true, disabled: true, ageMinutes: null, maxAgeMinutes };
  }
  const finishedMs = Date.parse(finishedAt || "");
  if (!Number.isFinite(finishedMs)) {
    return { ok: false, disabled: false, ageMinutes: null, maxAgeMinutes, error: "latest strict ledger has no valid finishedAt" };
  }
  const ageMinutes = Math.max(0, (Date.now() - finishedMs) / 60000);
  return {
    ok: ageMinutes <= maxAgeMinutes,
    disabled: false,
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    maxAgeMinutes,
    error: ageMinutes <= maxAgeMinutes ? "" : "latest strict ledger is stale"
  };
}

function buildStatus(options) {
  const ledgers = collectLedgers(options.reportDir, options.expectedCrossScript);
  const latest = ledgers[0] || null;
  if (!latest) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      reportDir: options.reportDir,
      expectedCrossScript: options.expectedCrossScript,
      failures: ["no strict continuous ledger found"],
      latestStrictLedger: null,
      latestStrictReport: null
    };
  }

  const cycle = latestCycle(latest.ledger);
  const reportPath = resolveReportPath(options.reportDir, cycle?.crossReport?.reportPath || "");
  const reportExists = Boolean(reportPath && fs.existsSync(reportPath));
  const report = reportExists ? readJson(reportPath) : null;
  const reportChecksum = reportExists ? readChecksum(reportPath) : null;
  const artifacts = report ? inspectArtifactArchive(report, reportPath) : null;
  const steps = report ? stepStatus(report) : null;
  const coverage = report ? strictCoverage(report) : null;
  const localResources = report ? localResourcesStatus(report) : null;
  const remoteResources = report ? remoteResourcesStatus(report, reportPath) : null;
  const age = ageStatus(latest.ledger.finishedAt, options.maxAgeMinutes);
  const healthAfter = report?.healthAfter || {};

  const failures = [];
  if (!latest.checksum.ok) failures.push(latest.checksum.error);
  if (!latest.ledger.ok) failures.push("latest strict ledger result is not ok");
  if (!cycle) failures.push("latest strict ledger has no cycle");
  if (cycle && !cycle.ok) failures.push("latest strict cycle is not ok");
  if (cycle && cycle.cross?.status !== "passed") failures.push("strict cross command did not pass");
  if (cycle && cycle.index?.status !== "passed") failures.push("validation index command did not pass");
  if (!reportExists) failures.push("strict cross report missing");
  if (reportChecksum && !reportChecksum.ok) failures.push(reportChecksum.error);
  if (report && !report.ok) failures.push("strict cross report result is not ok");
  if (report && !report.healthClean) failures.push("strict cross report health is not clean");
  if (report && (Number(healthAfter.endpoints) !== 0 || Number(healthAfter.sessions) !== 0 || Number(healthAfter.pendingCalls) !== 0)) {
    failures.push("strict cross report health counters are not zero");
  }
  if (artifacts && !artifacts.ok) failures.push(artifacts.error);
  if (steps && !steps.ok) failures.push("strict cross report did not pass every required step");
  if (coverage && !coverage.ok) failures.push("strict cross report did not require full remote coverage");
  if (localResources && !localResources.ok) failures.push("strict cross report local resources missing");
  if (remoteResources && !remoteResources.ok) failures.push("strict cross report remote resources missing");
  if (!age.ok) failures.push(age.error);

  return {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    expectedCrossScript: options.expectedCrossScript,
    failures,
    freshness: age,
    latestStrictLedger: {
      id: path.basename(latest.ledgerPath, ".json"),
      ledgerPath: latest.ledgerPath,
      startedAt: latest.ledger.startedAt || "",
      finishedAt: latest.ledger.finishedAt || "",
      ok: Boolean(latest.ledger.ok),
      checksum: latest.checksum,
      cycleCount: Array.isArray(latest.ledger.cycles) ? latest.ledger.cycles.length : 0,
      latestCycle: cycle
        ? {
            iteration: cycle.iteration,
            ok: Boolean(cycle.ok),
            crossStatus: cycle.cross?.status || "",
            indexStatus: cycle.index?.status || "",
            crossReportPath: cycle.crossReport?.reportPath || ""
          }
        : null
    },
    latestStrictReport: reportExists
      ? {
          id: path.basename(reportPath, ".json"),
          reportPath,
          startedAt: report.startedAt || "",
          finishedAt: report.finishedAt || "",
          ok: Boolean(report.ok),
          healthClean: Boolean(report.healthClean),
          healthAfter: {
            endpoints: healthAfter.endpoints,
            sessions: healthAfter.sessions,
            pendingCalls: healthAfter.pendingCalls
          },
          checksum: reportChecksum,
          artifacts,
          strictCoverage: coverage,
          localResources,
          remoteResources,
          steps
        }
      : null
  };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const status = buildStatus(options);
  const outputJson = `${JSON.stringify(status, null, 2)}\n`;
  if (!options.noWrite) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, outputJson, "utf8");
  }

  if (options.json) {
    process.stdout.write(outputJson);
  } else {
    console.log(
      JSON.stringify(
        {
          ok: status.ok,
          outputPath: options.noWrite ? "" : options.outputPath,
          latestStrictLedger: status.latestStrictLedger?.id || "",
          latestStrictReport: status.latestStrictReport?.id || "",
          failures: status.failures
        },
        null,
        2
      )
    );
  }

  if (!status.ok) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Validation status failed: ${error.message}`);
  process.exit(1);
}
