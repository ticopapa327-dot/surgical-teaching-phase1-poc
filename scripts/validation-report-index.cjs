const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULTS = {
  reportDir: path.join("validation-results", "cross-machine-validation"),
  outputPath: path.join("validation-results", "cross-machine-validation", "index.md")
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function usage() {
  return [
    "Usage:",
    "  node scripts/validation-report-index.cjs [--json] [--no-write]",
    "",
    "Options:",
    "  --json       Print the index as JSON",
    "  --no-write   Do not write the Markdown index file",
    "  --help       Show this help",
    "",
    "Environment:",
    "  UST_VALIDATION_REPORT_DIR       Default validation report directory",
    "  UST_VALIDATION_INDEX_PATH       Default Markdown index output path"
  ].join("\n");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    noWrite: argv.includes("--no-write"),
    help: argv.includes("--help") || argv.includes("-h"),
    reportDir: env("UST_VALIDATION_REPORT_DIR", DEFAULTS.reportDir),
    outputPath: env("UST_VALIDATION_INDEX_PATH", DEFAULTS.outputPath)
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readChecksum(reportPath) {
  const checksumPath = reportPath.replace(/\.json$/i, ".sha256");
  if (!fs.existsSync(checksumPath)) {
    return {
      ok: false,
      checksumPath,
      expected: "",
      actual: sha256File(reportPath),
      error: "checksum file missing"
    };
  }
  const expected = fs.readFileSync(checksumPath, "utf8").split(/\s+/)[0].trim().toLowerCase();
  const actual = sha256File(reportPath);
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
  if (!file?.targetPath) return { artifact: null, targetPath: "" };
  const targetPath = path.resolve(file.targetPath);
  if (!fs.existsSync(targetPath)) return { artifact: null, targetPath };
  try {
    return { artifact: readJson(targetPath), targetPath };
  } catch {
    return { artifact: null, targetPath };
  }
}

function findArtifactFile(manifest, sourceName, extension = "") {
  return (manifest.files || [])
    .filter((item) => String(item.sourcePath || item.targetPath || "").includes(sourceName))
    .filter((item) => !extension || String(item.targetPath || "").toLowerCase().endsWith(extension))
    .sort((a, b) => String(b.targetPath || "").localeCompare(String(a.targetPath || "")))[0];
}

function readNamedJsonArtifact(manifest, sourceName) {
  const file = findArtifactFile(manifest, sourceName, ".json");
  if (!file?.targetPath) return { artifact: null, targetPath: "", error: "" };
  const targetPath = path.resolve(file.targetPath);
  if (!fs.existsSync(targetPath)) return { artifact: null, targetPath, error: "artifact missing" };
  try {
    return { artifact: readJson(targetPath), targetPath, error: "" };
  } catch {
    return { artifact: null, targetPath, error: "artifact unreadable" };
  }
}

function readTextArtifact(manifest, sourceName, extension = "") {
  const file = findArtifactFile(manifest, sourceName, extension);
  if (!file?.targetPath) return { text: "", targetPath: "" };
  const targetPath = path.resolve(file.targetPath);
  if (!fs.existsSync(targetPath)) return { text: "", targetPath };
  try {
    return { text: fs.readFileSync(targetPath, "utf8"), targetPath };
  } catch {
    return { text: "", targetPath };
  }
}

function kylinDiscoveryStatus(report, reportPath) {
  const manifestPath = resolveArtifactManifestPath(report, reportPath);
  if (!manifestPath) {
    return {
      available: false,
      ok: false,
      classification: "",
      matchCount: null,
      boundTcpOpen: null,
      osRouteTcpOpen: null,
      warningCount: 0,
      warnings: [],
      artifactPath: "",
      error: ""
    };
  }
  const manifest = readJson(manifestPath);
  const { artifact, targetPath } = readJsonArtifact(manifest, "remote-kylin-discovery");
  if (!artifact) {
    return {
      available: false,
      ok: false,
      classification: "",
      matchCount: null,
      boundTcpOpen: null,
      osRouteTcpOpen: null,
      warningCount: 0,
      warnings: [],
      artifactPath: targetPath,
      error: targetPath ? "kylin discovery artifact unreadable" : ""
    };
  }

  const connectivity = artifact.knownHostConnectivity || {};
  const warnings = [
    ...(Array.isArray(artifact.warnings) ? artifact.warnings : []),
    ...(Array.isArray(connectivity.warnings) ? connectivity.warnings : [])
  ].filter(Boolean);
  const uniqueWarnings = [...new Set(warnings)];
  return {
    available: true,
    ok: Boolean(artifact.ok),
    classification: connectivity.classification || "",
    matchCount: Number(artifact.matchCount ?? 0),
    boundTcpOpen: connectivity.bound?.tcpOpen ?? null,
    osRouteTcpOpen: connectivity.osRoute?.tcpOpen ?? null,
    routeOnExpectedLan: connectivity.routeOnExpectedLan ?? null,
    routeHint: {
      interfaceAlias: connectivity.routeHint?.interfaceAlias || "",
      sourceAddress: connectivity.routeHint?.sourceAddress || "",
      nextHop: connectivity.routeHint?.nextHop || ""
    },
    warningCount: uniqueWarnings.length,
    warnings: uniqueWarnings,
    artifactPath: targetPath,
    error: ""
  };
}

function lanTopologyStatus(report, reportPath) {
  const manifestPath = resolveArtifactManifestPath(report, reportPath);
  if (!manifestPath) {
    return {
      available: false,
      topologyOk: null,
      classification: "",
      localRoute: "",
      remoteWindowsRoute: "",
      artifactPath: "",
      error: ""
    };
  }
  const manifest = readJson(manifestPath);
  const { artifact, targetPath } = readJsonArtifact(manifest, "remote-lan-topology");
  if (!artifact) {
    return {
      available: false,
      topologyOk: null,
      classification: "",
      localRoute: "",
      remoteWindowsRoute: "",
      artifactPath: targetPath,
      error: targetPath ? "LAN topology artifact unreadable" : ""
    };
  }
  const localRoute = artifact.diagnosis?.local || {};
  const remoteRoute = artifact.diagnosis?.remoteWindows || {};
  const routeText = (route) => {
    const destination = route.routeDestination || "";
    const routeInterface = route.routeInterface || "";
    const routeSource = route.routeSource || "";
    return [
      destination,
      routeInterface ? `via ${routeInterface}` : "",
      routeSource ? `src ${routeSource}` : ""
    ]
      .filter(Boolean)
      .join(" ");
  };
  return {
    available: true,
    topologyOk: artifact.topologyOk === true,
    classification: artifact.diagnosis?.classification || (artifact.topologyOk === true ? "ok" : "unknown"),
    localRoute: routeText(localRoute),
    remoteWindowsRoute: routeText(remoteRoute),
    artifactPath: targetPath,
    error: ""
  };
}

function lanRoutePlanStatus(report, reportPath) {
  const manifestPath = resolveArtifactManifestPath(report, reportPath);
  if (!manifestPath) {
    return {
      available: false,
      ok: false,
      classification: "",
      requiresManualAction: null,
      artifactPath: "",
      error: ""
    };
  }
  const manifest = readJson(manifestPath);
  const planJson = readNamedJsonArtifact(manifest, "lan-route-remediation-plan");
  if (planJson.targetPath) {
    if (!planJson.artifact) {
      return {
        available: false,
        ok: false,
        classification: "",
        requiresManualAction: null,
        artifactPath: planJson.targetPath,
        source: "json",
        error: `LAN route remediation plan ${planJson.error}`
      };
    }
    const classification = String(planJson.artifact.classification || "");
    const requiresManualAction =
      typeof planJson.artifact.requiresManualAction === "boolean"
        ? planJson.artifact.requiresManualAction
        : null;
    const ok = Boolean(classification && requiresManualAction !== null);
    return {
      available: true,
      ok,
      classification,
      requiresManualAction,
      artifactPath: planJson.targetPath,
      source: "json",
      targetHost: planJson.artifact.targetHost || "",
      targetPort: planJson.artifact.targetPort ?? null,
      generatedAt: planJson.artifact.generatedAt || "",
      error: ok ? "" : "LAN route remediation plan JSON missing required fields"
    };
  }

  const { text, targetPath } = readTextArtifact(manifest, "lan-route-remediation-plan", ".md");
  if (!text) {
    return {
      available: false,
      ok: false,
      classification: "",
      requiresManualAction: null,
      artifactPath: targetPath,
      source: "",
      error: targetPath ? "LAN route remediation plan unreadable" : ""
    };
  }
  const classification = /Classification:\s*([^\r\n]+)/.exec(text)?.[1]?.trim() || "";
  const requiresManualActionText = /Requires manual action:\s*([^\r\n]+)/.exec(text)?.[1]?.trim().toLowerCase() || "";
  return {
    available: true,
    ok: Boolean(classification && requiresManualActionText),
    classification,
    requiresManualAction:
      requiresManualActionText === "true" ? true : requiresManualActionText === "false" ? false : null,
    artifactPath: targetPath,
    source: "markdown",
    error: classification && requiresManualActionText ? "" : "LAN route remediation plan missing required fields"
  };
}

function routeSummary(discovery) {
  if (!discovery?.available) return "";
  const classification = discovery.classification || "discovery";
  const sourceAddress = discovery.routeHint?.sourceAddress || "";
  const interfaceAlias = discovery.routeHint?.interfaceAlias || "";
  if (!sourceAddress && !interfaceAlias) return classification;
  return `${classification} via ${interfaceAlias || "-"} ${sourceAddress || "-"}`;
}

function topologySummary(topology) {
  if (!topology?.available) return "";
  return topology.classification || (topology.topologyOk ? "ok" : "unknown");
}

function routePlanSummary(plan) {
  if (!plan?.available) return "";
  if (!plan.ok) return "unreadable";
  return `${plan.classification || "plan"} manual=${plan.requiresManualAction}`;
}

function summarizeReport(reportPath) {
  const report = readJson(reportPath);
  const checksum = readChecksum(reportPath);
  const artifacts = inspectArtifactArchive(report, reportPath);
  const failedSteps = (report.steps || []).filter((step) => step.status === "failed").map((step) => step.id);
  const skippedSteps = (report.steps || []).filter((step) => step.status === "skipped").map((step) => step.id);
  const retriedSteps = (report.steps || []).filter((step) => Number(step.attemptCount || 1) > 1);
  const maxAttemptsUsed = Math.max(0, ...(report.steps || []).map((step) => Number(step.attemptCount || 1)));
  const healthAfter = report.healthAfter || {};

  return {
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
    stepCount: (report.steps || []).length,
    failedSteps,
    skippedSteps,
    retriedSteps: retriedSteps.map((step) => ({
      id: step.id,
      attemptCount: step.attemptCount,
      maxAttempts: step.maxAttempts
    })),
    maxAttemptsUsed,
    checksum,
    artifacts,
    kylinDiscovery: kylinDiscoveryStatus(report, reportPath),
    lanTopology: lanTopologyStatus(report, reportPath),
    lanRoutePlan: lanRoutePlanStatus(report, reportPath),
    evidenceOk: checksum.ok && artifacts.ok,
    legacyEvidence: Boolean(artifacts.legacy),
    resultOk: Boolean(report.ok) && checksum.ok && artifacts.ok
  };
}

function collectReports(reportDir) {
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return [];
  return fs
    .readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[^.]+)?\.json$/.test(entry.name))
    .filter((entry) => !entry.name.startsWith("continuous-"))
    .filter((entry) => entry.name !== "status.json")
    .filter((entry) => !entry.name.endsWith("artifact-manifest.json"))
    .map((entry) => path.join(reportDir, entry.name))
    .map(summarizeReport)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function renderMarkdown(index) {
  const latest = index.reports[0];
  const lines = [
    "# UST Cross-Machine Validation Index",
    "",
    `- Generated: ${index.generatedAt}`,
    `- Report directory: ${index.reportDir}`,
    `- Total reports: ${index.totalReports}`,
    `- Passing reports: ${index.passingReports}`,
    `- Failing reports: ${index.failingReports}`,
    `- Evidence failures: ${index.evidenceFailures}`,
    `- Legacy reports without artifact archive: ${index.legacyReports}`,
    `- Reports with LAN route plans: ${index.routePlanReports}`,
    latest ? `- Latest report: ${latest.id} (${latest.ok ? "PASS" : "FAIL"})` : "- Latest report: none",
    latest?.kylinDiscovery?.available
      ? `- Latest 137 discovery: ${routeSummary(latest.kylinDiscovery)} (bound=${latest.kylinDiscovery.boundTcpOpen}, osRoute=${latest.kylinDiscovery.osRouteTcpOpen}, matches=${latest.kylinDiscovery.matchCount})`
      : "- Latest 137 discovery: none",
    latest?.lanTopology?.available
      ? `- Latest LAN topology: ${topologySummary(latest.lanTopology)} (118=${latest.lanTopology.localRoute || "-"}, 117=${latest.lanTopology.remoteWindowsRoute || "-"})`
      : "- Latest LAN topology: none",
    latest?.lanRoutePlan?.available
      ? `- Latest LAN route plan: ${routePlanSummary(latest.lanRoutePlan)}`
      : "- Latest LAN route plan: none",
    "",
    "## Reports",
    "",
    "| Started | Result | Evidence | 137 Route | LAN Topology | Route Plan | Steps | Retries | Artifacts | Report |",
    "|---|---:|---:|---|---|---|---:|---:|---:|---|"
  ];

  for (const report of index.reports) {
    const route = routeSummary(report.kylinDiscovery);
    const topology = topologySummary(report.lanTopology);
    const routePlan = routePlanSummary(report.lanRoutePlan);
    lines.push(
      `| ${markdownCell(report.startedAt)} | ${report.ok ? "PASS" : "FAIL"} | ${report.legacyEvidence ? "LEGACY" : report.evidenceOk ? "OK" : "BAD"} | ${markdownCell(route)} | ${markdownCell(topology)} | ${markdownCell(routePlan)} | ${report.stepCount} | ${report.retriedSteps.length} | ${report.artifacts.verifiedFiles}/${report.artifacts.fileCount} | ${markdownCell(report.reportPath)} |`
    );
  }

  const problemReports = index.reports.filter((report) => !report.ok || !report.evidenceOk);
  if (problemReports.length) {
    lines.push("", "## Problems", "");
    for (const report of problemReports) {
      const problems = [];
      if (report.failedSteps.length) problems.push(`failed steps: ${report.failedSteps.join(", ")}`);
      if (report.kylinDiscovery.available && !report.kylinDiscovery.ok) {
        problems.push(`137 discovery: ${report.kylinDiscovery.classification || "failed"}`);
      }
      if (report.lanTopology.available && report.lanTopology.topologyOk === false) {
        problems.push(`LAN topology: ${report.lanTopology.classification || "failed"}`);
      }
      if (report.lanRoutePlan.available && !report.lanRoutePlan.ok) {
        problems.push(`LAN route plan: ${report.lanRoutePlan.error || "unreadable"}`);
      }
      if (!report.checksum.ok) problems.push(report.checksum.error);
      if (!report.artifacts.ok && !report.artifacts.legacy) problems.push(report.artifacts.error);
      if (report.artifacts.legacy) problems.push(report.artifacts.error);
      lines.push(`- ${report.id}: ${problems.join("; ") || "unknown issue"}`);
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

  const reports = collectReports(options.reportDir);
  const index = {
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    outputPath: options.outputPath,
    totalReports: reports.length,
    passingReports: reports.filter((report) => report.ok).length,
    failingReports: reports.filter((report) => !report.ok).length,
    evidenceFailures: reports.filter((report) => !report.evidenceOk).length,
    legacyReports: reports.filter((report) => report.legacyEvidence).length,
    routePlanReports: reports.filter((report) => report.lanRoutePlan.available).length,
    reports
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
          totalReports: index.totalReports,
          passingReports: index.passingReports,
          failingReports: index.failingReports,
          evidenceFailures: index.evidenceFailures,
          legacyReports: index.legacyReports,
          routePlanReports: index.routePlanReports,
          latestReport: reports[0]?.id || ""
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
  console.error(`Validation report index failed: ${error.message}`);
  process.exit(1);
}
