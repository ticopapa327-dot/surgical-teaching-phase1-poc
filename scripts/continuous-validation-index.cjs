const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULTS = {
  reportDir: path.join("validation-results", "cross-machine-validation"),
  outputPath: path.join("validation-results", "cross-machine-validation", "continuous-index.md")
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function usage() {
  return [
    "Usage:",
    "  node scripts/continuous-validation-index.cjs [--json] [--no-write]",
    "",
    "Options:",
    "  --json       Print the continuous validation index as JSON",
    "  --no-write   Do not write the Markdown index file",
    "  --help       Show this help",
    "",
    "Environment:",
    "  UST_VALIDATION_REPORT_DIR              Default validation report directory",
    "  UST_CONTINUOUS_VALIDATION_INDEX_PATH   Default Markdown index output path"
  ].join("\n");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    noWrite: argv.includes("--no-write"),
    help: argv.includes("--help") || argv.includes("-h"),
    reportDir: env("UST_VALIDATION_REPORT_DIR", DEFAULTS.reportDir),
    outputPath: env("UST_CONTINUOUS_VALIDATION_INDEX_PATH", DEFAULTS.outputPath)
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

function inspectArtifactArchive(report, reportPath) {
  const archive = report.artifactArchive || {};
  const manifestPath = archive.manifestPath || "";
  if (!report.artifactArchive) {
    return {
      ok: true,
      legacy: true,
      manifestPath: "",
      fileCount: 0,
      verifiedFiles: 0,
      missingFiles: 0,
      hashMismatches: 0,
      error: "legacy report without artifact archive"
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

function resolveReportPath(reportDir, reportPath) {
  if (!reportPath) return "";
  const direct = path.resolve(reportPath);
  if (fs.existsSync(direct)) return direct;
  return path.resolve(reportDir, path.basename(reportPath));
}

function inspectCrossReport(reportDir, reportPath) {
  const resolvedPath = resolveReportPath(reportDir, reportPath);
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      reportPath: reportPath || "",
      resolvedPath,
      checksum: null,
      reportOk: false,
      failedSteps: [],
      error: "cross report missing"
    };
  }

  const report = readJson(resolvedPath);
  const checksum = readChecksum(resolvedPath);
  const artifacts = inspectArtifactArchive(report, resolvedPath);
  return {
    ok: checksum.ok && artifacts.ok,
    reportPath: reportPath || resolvedPath,
    resolvedPath,
    checksum,
    artifacts,
    reportOk: Boolean(report.ok),
    failedSteps: (report.steps || []).filter((step) => step.status === "failed").map((step) => step.id),
    error: checksum.ok ? artifacts.error : checksum.error
  };
}

function summarizeLedger(ledgerPath, reportDir) {
  const ledger = readJson(ledgerPath);
  const checksum = readChecksum(ledgerPath);
  const cycles = (ledger.cycles || []).map((cycle) => {
    const crossReport = inspectCrossReport(reportDir, cycle.crossReport?.reportPath || "");
    const commandOk = cycle.cross?.status === "passed" && cycle.index?.status === "passed";
    const resultOk = Boolean(cycle.ok) && commandOk && crossReport.reportOk;
    const evidenceOk = crossReport.ok;
    return {
      iteration: cycle.iteration,
      ok: Boolean(cycle.ok),
      commandOk,
      resultOk,
      evidenceOk,
      crossStatus: cycle.cross?.status || "",
      indexStatus: cycle.index?.status || "",
      crossReport,
      startedAt: cycle.startedAt || "",
      finishedAt: cycle.finishedAt || "",
      durationMs: cycle.durationMs || 0
    };
  });
  const failedCycles = cycles.filter((cycle) => !cycle.resultOk).map((cycle) => cycle.iteration);
  const evidenceFailedCycles = cycles.filter((cycle) => !cycle.evidenceOk).map((cycle) => cycle.iteration);
  const evidenceOk = checksum.ok && evidenceFailedCycles.length === 0;

  return {
    id: path.basename(ledgerPath, ".json"),
    ledgerPath,
    startedAt: ledger.startedAt || "",
    finishedAt: ledger.finishedAt || "",
    stopReason: ledger.stopReason || "",
    ok: Boolean(ledger.ok),
    checksum,
    cycleCount: cycles.length,
    failedCycles,
    evidenceFailedCycles,
    evidenceOk,
    resultOk: Boolean(ledger.ok) && evidenceOk,
    cycles
  };
}

function collectLedgers(reportDir) {
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return [];
  return fs
    .readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("continuous-") && entry.name.endsWith(".json"))
    .map((entry) => path.join(reportDir, entry.name))
    .map((ledgerPath) => summarizeLedger(ledgerPath, reportDir))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function renderMarkdown(index) {
  const latest = index.ledgers[0];
  const lines = [
    "# UST Continuous Validation Index",
    "",
    `- Generated: ${index.generatedAt}`,
    `- Report directory: ${index.reportDir}`,
    `- Total ledgers: ${index.totalLedgers}`,
    `- Passing ledgers: ${index.passingLedgers}`,
    `- Failing ledgers: ${index.failingLedgers}`,
    `- Evidence failures: ${index.evidenceFailures}`,
    latest ? `- Latest ledger: ${latest.id} (${latest.ok ? "PASS" : "FAIL"})` : "- Latest ledger: none",
    "",
    "## Ledgers",
    "",
    "| Started | Result | Evidence | Cycles | Failed cycles | Ledger |",
    "|---|---:|---:|---:|---|---|"
  ];

  for (const ledger of index.ledgers) {
    lines.push(
      `| ${markdownCell(ledger.startedAt)} | ${ledger.ok ? "PASS" : "FAIL"} | ${ledger.evidenceOk ? "OK" : "BAD"} | ${ledger.cycleCount} | ${ledger.failedCycles.join(", ") || "-"} | ${markdownCell(ledger.ledgerPath)} |`
    );
  }

  const problemLedgers = index.ledgers.filter((ledger) => !ledger.ok || !ledger.evidenceOk);
  if (problemLedgers.length) {
    lines.push("", "## Problems", "");
    for (const ledger of problemLedgers) {
      const problems = [];
      if (!ledger.checksum.ok) problems.push(ledger.checksum.error);
      if (ledger.failedCycles.length) problems.push(`failed cycles: ${ledger.failedCycles.join(", ")}`);
      if (ledger.evidenceFailedCycles.length) problems.push(`evidence failed cycles: ${ledger.evidenceFailedCycles.join(", ")}`);
      lines.push(`- ${ledger.id}: ${problems.join("; ") || "unknown issue"}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const ledgers = collectLedgers(options.reportDir);
  const index = {
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    outputPath: options.outputPath,
    totalLedgers: ledgers.length,
    passingLedgers: ledgers.filter((ledger) => ledger.ok).length,
    failingLedgers: ledgers.filter((ledger) => !ledger.ok).length,
    evidenceFailures: ledgers.filter((ledger) => !ledger.evidenceOk).length,
    ledgers
  };

  if (!options.noWrite) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, renderMarkdown(index), "utf8");
  }

  if (options.json) {
    console.log(JSON.stringify(index, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          ok: index.evidenceFailures === 0,
          outputPath: options.noWrite ? "" : options.outputPath,
          totalLedgers: index.totalLedgers,
          passingLedgers: index.passingLedgers,
          failingLedgers: index.failingLedgers,
          evidenceFailures: index.evidenceFailures,
          latestLedger: ledgers[0]?.id || ""
        },
        null,
        2
      )
    );
  }

  if (index.evidenceFailures > 0) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Continuous validation index failed: ${error.message}`);
  process.exit(1);
}
