const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  healthUrl: "http://127.0.0.1:7077/health",
  reportDir: path.join("validation-results", "cross-machine-validation")
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function envFlag(name, fallback = "false") {
  const value = env(name, fallback).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function npmCommandParts(script) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm", "run", script]
    };
  }
  return {
    command: "npm",
    args: ["run", script]
  };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyFileWithHash(sourcePath, targetPath) {
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  return {
    sourcePath,
    targetPath,
    bytes: fs.statSync(targetPath).size,
    sha256: sha256File(targetPath)
  };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(filePath));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

function archiveDiagnosticArtifacts(reportDir, reportId, startedAt) {
  const sources = [
    path.join("test-results", "remote-windows-media-smoke"),
    path.join("test-results", "remote-windows-audio-smoke"),
    path.join("test-results", "remote-kylin-media-smoke"),
    path.join("test-results", "remote-kylin-audio-smoke")
  ];
  const allowedExtensions = new Set([".json", ".csv"]);
  const artifactsDir = path.join(reportDir, `${reportId}-artifacts`);
  const minMtimeMs = new Date(startedAt).getTime() - 5000;
  const files = [];

  for (const sourceDir of sources) {
    for (const sourcePath of walkFiles(sourceDir)) {
      if (!allowedExtensions.has(path.extname(sourcePath).toLowerCase())) continue;
      if (fs.statSync(sourcePath).mtimeMs < minMtimeMs) continue;
      const relativeSource = path.relative("test-results", sourcePath);
      const targetPath = path.join(artifactsDir, relativeSource);
      files.push(copyFileWithHash(sourcePath, targetPath));
    }
  }

  const manifest = {
    artifactsDir,
    createdAt: new Date().toISOString(),
    sourceMtimeNotBefore: new Date(minMtimeMs).toISOString(),
    fileCount: files.length,
    files
  };
  const manifestPath = path.join(artifactsDir, "artifact-manifest.json");
  ensureDir(artifactsDir);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return {
    artifactsDir,
    manifestPath,
    fileCount: files.length,
    files
  };
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|");
}

function renderSummary(report, paths) {
  const lines = [
    "# UST Cross-Machine Validation Report",
    "",
    `- Result: ${report.ok ? "PASS" : "FAIL"}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- JSON report: ${paths.reportPath}`,
    `- Artifact manifest: ${report.artifactArchive?.manifestPath || "-"}`,
    `- Archived artifact files: ${report.artifactArchive?.fileCount ?? 0}`,
    `- SHA256: ${paths.reportSha256}`,
    "",
    "## Health",
    "",
    `- Before: endpoints=${report.healthBefore?.endpoints ?? "-"}, sessions=${report.healthBefore?.sessions ?? "-"}, pendingCalls=${report.healthBefore?.pendingCalls ?? "-"}`,
    `- After: endpoints=${report.healthAfter?.endpoints ?? "-"}, sessions=${report.healthAfter?.sessions ?? "-"}, pendingCalls=${report.healthAfter?.pendingCalls ?? "-"}`,
    `- Health clean: ${report.healthClean ? "yes" : "no"}`,
    "",
    "## Steps",
    "",
    "| Step | Status | Attempts | Duration ms | Exit | Command |",
    "|---|---:|---:|---:|---:|---|"
  ];

  for (const item of report.steps) {
    lines.push(
      `| ${markdownCell(item.id)} | ${markdownCell(item.status)} | ${markdownCell(item.attemptCount ?? 1)} / ${markdownCell(item.maxAttempts ?? 1)} | ${markdownCell(item.durationMs)} | ${markdownCell(item.exitCode ?? "")} | ${markdownCell(item.command || item.reason || "")} |`
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- Full stdout/stderr is retained in the JSON report for local audit.",
    "- Diagnostic snapshots and CSV reports are copied into the artifacts directory before this report is finalized.",
    "- The validation-results directory is intentionally ignored by Git because it may contain machine-specific runtime evidence.",
    "- Test snapshots under test-results remain volatile and may be cleaned by Playwright."
  );
  return `${lines.join("\n")}\n`;
}

async function fetchHealth(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function runStepAttempt(step, attempt, totalAttempts) {
  const startedAt = new Date();
  console.log(`\n[${step.id}] ${step.title} (attempt ${attempt}/${totalAttempts})`);
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: step.timeoutMs || 300000,
    windowsHide: true
  });
  const finishedAt = new Date();
  const entry = {
    attempt,
    id: step.id,
    title: step.title,
    command: [step.command, ...step.args].join(" "),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal || "",
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || ""
  };
  if (entry.stdout.trim()) console.log(entry.stdout.trim());
  if (entry.stderr.trim()) console.error(entry.stderr.trim());
  if (entry.error) console.error(entry.error);
  console.log(`[${step.id}] attempt ${attempt}/${totalAttempts} ${entry.status} in ${entry.durationMs} ms`);
  return entry;
}

function runStep(step, report) {
  const totalAttempts = 1 + (step.retries || 0);
  const attempts = [];

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const attemptEntry = runStepAttempt(step, attempt, totalAttempts);
    attempts.push(attemptEntry);
    if (attemptEntry.status === "passed") break;
    if (attempt < totalAttempts) {
      console.log(`[${step.id}] retrying after failed attempt ${attempt}`);
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  const totalDurationMs = attempts.reduce((total, item) => total + item.durationMs, 0);
  const entry = {
    ...lastAttempt,
    durationMs: totalDurationMs,
    attemptCount: attempts.length,
    maxAttempts: totalAttempts,
    attempts
  };
  report.steps.push(entry);
  console.log(`[${step.id}] final ${entry.status} after ${entry.attemptCount}/${entry.maxAttempts} attempt(s)`);
  return entry;
}

function skipStep(step, report, reason) {
  const entry = {
    id: step.id,
    title: step.title,
    command: [step.command, ...step.args].join(" "),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    status: "skipped",
    reason
  };
  report.steps.push(entry);
  console.log(`\n[${step.id}] skipped: ${reason}`);
}

function step(id, title, script, timeoutMs) {
  const commandParts = npmCommandParts(script);
  return {
    id,
    title,
    command: commandParts.command,
    args: commandParts.args,
    timeoutMs,
    retries: 0
  };
}

function retryingStep(id, title, script, timeoutMs) {
  return {
    ...step(id, title, script, timeoutMs),
    retries: 1
  };
}

async function main() {
  const config = {
    healthUrl: env("UST_CROSS_HEALTH_URL", DEFAULTS.healthUrl),
    reportDir: env("UST_CROSS_REPORT_DIR", DEFAULTS.reportDir),
    skipWindows117: envFlag("UST_CROSS_SKIP_WINDOWS_117"),
    skipKylin137: envFlag("UST_CROSS_SKIP_KYLIN_137"),
    requireKylin137: envFlag("UST_CROSS_REQUIRE_KYLIN_137"),
    hasKylinSudoPassword: Boolean(env("UST_KYLIN_SUDO_PASSWORD", ""))
  };

  ensureDir(config.reportDir);
  const reportId = nowStamp();
  const reportPath = path.join(config.reportDir, `${reportId}.json`);
  const summaryPath = path.join(config.reportDir, `${reportId}.md`);
  const checksumPath = path.join(config.reportDir, `${reportId}.sha256`);
  const report = {
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    config,
    healthBefore: null,
    healthAfter: null,
    healthClean: false,
    artifactArchive: null,
    steps: []
  };

  try {
    report.healthBefore = await fetchHealth(config.healthUrl);
  } catch (error) {
    report.healthBefore = { ok: false, error: error.message };
  }

  const windowsSteps = [
    retryingStep("117-signal", "117 Windows signal smoke", "test:remote:signal:tunnel", 180000),
    retryingStep("117-media", "117 Windows 4-channel media smoke", "test:remote:media:tunnel", 240000),
    retryingStep("117-audio", "117 Windows remote audio receive smoke", "test:remote:audio:tunnel", 240000),
    step("117-media-diagnostics", "117 Windows media diagnostics", "test:remote:diagnostics", 60000),
    step("117-audio-diagnostics", "117 Windows audio diagnostics", "test:remote:audio:diagnostics", 60000)
  ];

  const kylinSteps = [
    step("137-probe", "137 Kylin environment probe", "test:remote:kylin:probe", 60000),
    retryingStep("137-signal", "137 Kylin signal smoke", "test:remote:kylin:signal:lan", 180000),
    retryingStep("137-media", "137 Kylin 4-channel media smoke", "test:remote:kylin:media:lan", 240000),
    retryingStep("137-audio", "137 Kylin remote audio receive smoke", "test:remote:kylin:audio:lan", 240000),
    step("137-media-diagnostics", "137 Kylin media diagnostics", "test:remote:kylin:diagnostics", 60000),
    step("137-audio-diagnostics", "137 Kylin audio diagnostics", "test:remote:kylin:audio:diagnostics", 60000)
  ];

  if (config.skipWindows117) {
    windowsSteps.forEach((item) => skipStep(item, report, "UST_CROSS_SKIP_WINDOWS_117 is enabled"));
  } else {
    for (const item of windowsSteps) {
      const entry = runStep(item, report);
      if (entry.status !== "passed") break;
    }
  }

  if (config.skipKylin137) {
    kylinSteps.forEach((item) => skipStep(item, report, "UST_CROSS_SKIP_KYLIN_137 is enabled"));
  } else if (!config.hasKylinSudoPassword) {
    const reason = "UST_KYLIN_SUDO_PASSWORD is required for temporary 137 LAN DevTools firewall rule";
    kylinSteps.forEach((item) => skipStep(item, report, reason));
    if (config.requireKylin137) {
      report.steps.push({
        id: "137-required-env",
        title: "137 Kylin required environment",
        status: "failed",
        reason
      });
    }
  } else {
    for (const item of kylinSteps) {
      const entry = runStep(item, report);
      if (entry.status !== "passed") break;
    }
  }

  try {
    report.healthAfter = await fetchHealth(config.healthUrl);
  } catch (error) {
    report.healthAfter = { ok: false, error: error.message };
  }

  report.finishedAt = new Date().toISOString();
  const failed = report.steps.filter((item) => item.status === "failed");
  report.healthClean =
    report.healthAfter?.ok === true &&
    Number(report.healthAfter.endpoints) === 0 &&
    Number(report.healthAfter.sessions) === 0 &&
    Number(report.healthAfter.pendingCalls) === 0;
  report.ok = failed.length === 0 && report.healthClean;
  report.artifactArchive = archiveDiagnosticArtifacts(config.reportDir, reportId, report.startedAt);

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = sha256(reportJson);
  fs.writeFileSync(reportPath, reportJson, "utf8");
  fs.writeFileSync(checksumPath, `${reportSha256}  ${path.basename(reportPath)}\n`, "utf8");
  fs.writeFileSync(summaryPath, renderSummary(report, { reportPath, summaryPath, checksumPath, reportSha256 }), "utf8");
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        reportPath,
        summaryPath,
        checksumPath,
        reportSha256,
        failedSteps: failed.map((item) => item.id),
        skippedSteps: report.steps.filter((item) => item.status === "skipped").map((item) => item.id),
        healthAfter: report.healthAfter
      },
      null,
      2
    )
  );

  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Cross-machine validation failed: ${error.message}`);
  process.exit(1);
});
