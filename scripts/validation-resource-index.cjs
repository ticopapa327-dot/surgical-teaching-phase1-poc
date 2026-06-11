const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULTS = {
  reportDir: path.join("validation-results", "cross-machine-validation"),
  outputPath: path.join("validation-results", "cross-machine-validation", "resource-index.md"),
  minMemoryFreeGiB: 2,
  minDiskFreeGiB: 5
};

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
    "  node scripts/validation-resource-index.cjs [options]",
    "",
    "Options:",
    "  --json                         Print resource index as JSON",
    "  --no-write                     Do not write resource-index.md",
    "  --strict-only                  Only include strict full-coverage reports",
    "  --fail-on-warn                 Exit non-zero when resource warnings exist",
    "  --min-memory-free-gib <gib>    Warn when any machine memory free/available is below this",
    "  --min-disk-free-gib <gib>      Warn when any reported local disk is below this",
    "  --help                         Show this help",
    "",
    "Environment:",
    "  UST_VALIDATION_REPORT_DIR                 Default validation report directory",
    "  UST_VALIDATION_RESOURCE_INDEX_PATH        Default Markdown index output path",
    "  UST_RESOURCE_INDEX_MIN_MEMORY_FREE_GIB    Default memory warning threshold",
    "  UST_RESOURCE_INDEX_MIN_DISK_FREE_GIB      Default disk warning threshold"
  ].join("\n");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    noWrite: argv.includes("--no-write"),
    strictOnly: argv.includes("--strict-only"),
    failOnWarn: argv.includes("--fail-on-warn"),
    help: argv.includes("--help") || argv.includes("-h"),
    reportDir: env("UST_VALIDATION_REPORT_DIR", DEFAULTS.reportDir),
    outputPath: env("UST_VALIDATION_RESOURCE_INDEX_PATH", DEFAULTS.outputPath),
    minMemoryFreeGiB: parseNonNegativeNumber(
      readArg(argv, "--min-memory-free-gib") ||
        env("UST_RESOURCE_INDEX_MIN_MEMORY_FREE_GIB", DEFAULTS.minMemoryFreeGiB),
      DEFAULTS.minMemoryFreeGiB,
      "--min-memory-free-gib"
    ),
    minDiskFreeGiB: parseNonNegativeNumber(
      readArg(argv, "--min-disk-free-gib") || env("UST_RESOURCE_INDEX_MIN_DISK_FREE_GIB", DEFAULTS.minDiskFreeGiB),
      DEFAULTS.minDiskFreeGiB,
      "--min-disk-free-gib"
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
      error: "checksum file missing"
    };
  }
  const expected = fs.readFileSync(checksumPath, "utf8").split(/\s+/)[0].trim().toLowerCase();
  const actual = sha256File(jsonPath);
  return {
    ok: expected === actual,
    checksumPath,
    error: expected === actual ? "" : "checksum mismatch"
  };
}

function resolveManifestPath(report, reportPath) {
  const manifestPath = report?.artifactArchive?.manifestPath || "";
  if (!manifestPath) return "";
  const direct = path.resolve(manifestPath);
  if (fs.existsSync(direct)) return direct;
  const relative = path.resolve(path.dirname(reportPath), "..", "..", manifestPath);
  return fs.existsSync(relative) ? relative : "";
}

function readArtifactJson(manifest, sourceDirName) {
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metric(capturedAt, memoryFreeGiB, cpuLoadPercent, diskFreeGiB, processCount) {
  return {
    capturedAt: capturedAt || "",
    memoryFreeGiB: numberOrNull(memoryFreeGiB),
    cpuLoadPercent: numberOrNull(cpuLoadPercent),
    diskFreeGiB: numberOrNull(diskFreeGiB),
    processCount: Number.isFinite(Number(processCount)) ? Number(processCount) : 0
  };
}

function minDiskFree(disks) {
  const values = (Array.isArray(disks) ? disks : [])
    .map((disk) => numberOrNull(disk.FreeGiB ?? disk.freeGiB ?? disk.availableGiB))
    .filter((value) => value !== null);
  return values.length ? Math.min(...values) : null;
}

function extractLocal118(report) {
  const before = report.systemResources?.before || {};
  const after = report.systemResources?.after || {};
  const beforeSystem = before.system || {};
  const afterSystem = after.system || {};
  return {
    before: metric(
      beforeSystem.capturedAt || before.capturedAt,
      beforeSystem.memory?.freeGiB ?? before.memory?.freeGiB,
      beforeSystem.cpu?.loadPercent,
      minDiskFree(beforeSystem.disks),
      beforeSystem.processes?.length
    ),
    after: metric(
      afterSystem.capturedAt || after.capturedAt,
      afterSystem.memory?.freeGiB ?? after.memory?.freeGiB,
      afterSystem.cpu?.loadPercent,
      minDiskFree(afterSystem.disks),
      afterSystem.processes?.length
    ),
    ok: beforeSystem.ok === true && afterSystem.ok === true
  };
}

function extractRemoteResources(report, reportPath) {
  const manifestPath = resolveManifestPath(report, reportPath);
  if (!manifestPath) {
    return {
      windows117: null,
      kylin137: null,
      manifestPath: "",
      error: "artifact manifest missing"
    };
  }
  const manifest = readJson(manifestPath);
  const windowsProbe = readArtifactJson(manifest, "remote-windows-probe");
  const kylinProbe = readArtifactJson(manifest, "remote-kylin-probe");
  const windowsResources = windowsProbe?.checks?.remote?.checks?.resources || null;
  const kylinResources = kylinProbe?.checks?.resources || null;
  return {
    manifestPath,
    windows117: windowsResources
      ? metric(
          windowsResources.capturedAt,
          windowsResources.memory?.freeGiB,
          windowsResources.cpu?.loadPercent,
          minDiskFree(windowsResources.disks),
          windowsResources.processes?.length
        )
      : null,
    kylin137: kylinResources
      ? metric(
          kylinResources.capturedAt,
          kylinResources.memory?.availableGiB,
          null,
          kylinResources.diskRoot?.availableGiB,
          kylinResources.processes?.length
        )
      : null,
    error: ""
  };
}

function isStrictReport(report) {
  const config = report.config || {};
  return (
    config.strictRemoteCoverage === true &&
    config.requireWindows117 === true &&
    config.requireKylin137 === true &&
    config.requireConference === true &&
    config.skipWindows117 === false &&
    config.skipKylin137 === false
  );
}

function collectWarnings(record, options) {
  const warnings = [];
  const checkMemory = (label, value) => {
    if (value === null) {
      warnings.push(`${label}_memory_missing`);
    } else if (value < options.minMemoryFreeGiB) {
      warnings.push(`${label}_memory_low`);
    }
  };
  const checkDisk = (label, value) => {
    if (value !== null && value < options.minDiskFreeGiB) warnings.push(`${label}_disk_low`);
  };

  if (!record.local118.ok) warnings.push("local118_resources_missing");
  if (!record.windows117) warnings.push("windows117_resources_missing");
  if (!record.kylin137) warnings.push("kylin137_resources_missing");

  checkMemory("local118_after", record.local118.after.memoryFreeGiB);
  checkMemory("windows117", record.windows117?.memoryFreeGiB ?? null);
  checkMemory("kylin137", record.kylin137?.memoryFreeGiB ?? null);
  checkDisk("local118_after", record.local118.after.diskFreeGiB);
  checkDisk("windows117", record.windows117?.diskFreeGiB ?? null);
  checkDisk("kylin137", record.kylin137?.diskFreeGiB ?? null);

  if (!record.checksum.ok) warnings.push(record.checksum.error);
  return warnings;
}

function summarizeReport(reportPath, options) {
  const report = readJson(reportPath);
  const checksum = readChecksum(reportPath);
  const strict = isStrictReport(report);
  const local118 = extractLocal118(report);
  const remote = extractRemoteResources(report, reportPath);
  const record = {
    id: path.basename(reportPath, ".json"),
    reportPath,
    startedAt: report.startedAt || "",
    finishedAt: report.finishedAt || "",
    ok: Boolean(report.ok),
    strict,
    checksum,
    local118,
    windows117: remote.windows117,
    kylin137: remote.kylin137,
    artifactManifestPath: remote.manifestPath,
    remoteError: remote.error,
    warnings: []
  };
  record.warnings = collectWarnings(record, options);
  return record;
}

function collectReports(options) {
  if (!fs.existsSync(options.reportDir) || !fs.statSync(options.reportDir).isDirectory()) return [];
  return fs
    .readdirSync(options.reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => !entry.name.startsWith("continuous-"))
    .filter((entry) => entry.name !== "status.json")
    .filter((entry) => !entry.name.endsWith("artifact-manifest.json"))
    .map((entry) => path.join(options.reportDir, entry.name))
    .map((reportPath) => summarizeReport(reportPath, options))
    .filter((record) => !options.strictOnly || record.strict)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function machineStats(records, selector) {
  const samples = records
    .map(selector)
    .filter(Boolean)
    .filter((sample) => sample.memoryFreeGiB !== null || sample.cpuLoadPercent !== null || sample.diskFreeGiB !== null);
  const memoryValues = samples.map((sample) => sample.memoryFreeGiB).filter((value) => value !== null);
  const cpuValues = samples.map((sample) => sample.cpuLoadPercent).filter((value) => value !== null);
  const diskValues = samples.map((sample) => sample.diskFreeGiB).filter((value) => value !== null);
  const latest = samples[0] || null;
  return {
    sampleCount: samples.length,
    latest,
    minMemoryFreeGiB: memoryValues.length ? Math.min(...memoryValues) : null,
    maxMemoryFreeGiB: memoryValues.length ? Math.max(...memoryValues) : null,
    maxCpuLoadPercent: cpuValues.length ? Math.max(...cpuValues) : null,
    minDiskFreeGiB: diskValues.length ? Math.min(...diskValues) : null
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function formatNumber(value) {
  return value === null || value === undefined ? "-" : String(Math.round(Number(value) * 10) / 10);
}

function renderMarkdown(index) {
  const lines = [
    "# UST Resource Trend Index",
    "",
    `- Generated: ${index.generatedAt}`,
    `- Report directory: ${index.reportDir}`,
    `- Total reports: ${index.totalReports}`,
    `- Reports with all machine resources: ${index.reportsWithAllResources}`,
    `- Reports with warnings: ${index.reportsWithWarnings}`,
    `- Memory warning threshold: ${index.thresholds.minMemoryFreeGiB} GiB`,
    `- Disk warning threshold: ${index.thresholds.minDiskFreeGiB} GiB`,
    "",
    "## Machine Summary",
    "",
    "| Machine | Samples | Latest free GiB | Min free GiB | Max CPU % | Min disk free GiB |",
    "|---|---:|---:|---:|---:|---:|"
  ];

  for (const [label, stats] of Object.entries(index.machines)) {
    lines.push(
      `| ${markdownCell(label)} | ${stats.sampleCount} | ${formatNumber(stats.latest?.memoryFreeGiB)} | ${formatNumber(stats.minMemoryFreeGiB)} | ${formatNumber(stats.maxCpuLoadPercent)} | ${formatNumber(stats.minDiskFreeGiB)} |`
    );
  }

  lines.push(
    "",
    "## Reports",
    "",
    "| Started | Result | 118 free before->after | 117 free | 137 free | Warnings | Report |",
    "|---|---:|---:|---:|---:|---|---|"
  );

  for (const report of index.reports) {
    lines.push(
      `| ${markdownCell(report.startedAt)} | ${report.ok ? "PASS" : "FAIL"} | ${formatNumber(report.local118.before.memoryFreeGiB)} -> ${formatNumber(report.local118.after.memoryFreeGiB)} | ${formatNumber(report.windows117?.memoryFreeGiB)} | ${formatNumber(report.kylin137?.memoryFreeGiB)} | ${markdownCell(report.warnings.join(", ") || "-")} | ${markdownCell(report.reportPath)} |`
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildIndex(options) {
  const reports = collectReports(options);
  return {
    ok: options.failOnWarn ? reports.every((report) => report.warnings.length === 0) : true,
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    outputPath: options.outputPath,
    strictOnly: options.strictOnly,
    thresholds: {
      minMemoryFreeGiB: options.minMemoryFreeGiB,
      minDiskFreeGiB: options.minDiskFreeGiB
    },
    totalReports: reports.length,
    reportsWithAllResources: reports.filter(
      (report) => report.local118.ok && report.windows117 && report.kylin137
    ).length,
    reportsWithWarnings: reports.filter((report) => report.warnings.length > 0).length,
    machines: {
      local118Before: machineStats(reports, (report) => report.local118.before),
      local118After: machineStats(reports, (report) => report.local118.after),
      windows117: machineStats(reports, (report) => report.windows117),
      kylin137: machineStats(reports, (report) => report.kylin137)
    },
    reports
  };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const index = buildIndex(options);
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
          ok: index.ok,
          outputPath: options.noWrite ? "" : options.outputPath,
          totalReports: index.totalReports,
          reportsWithAllResources: index.reportsWithAllResources,
          reportsWithWarnings: index.reportsWithWarnings,
          latestReport: index.reports[0]?.id || ""
        },
        null,
        2
      )
    );
  }

  if (!index.ok) process.exitCode = 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Validation resource index failed: ${error.message}`);
  process.exit(1);
}
