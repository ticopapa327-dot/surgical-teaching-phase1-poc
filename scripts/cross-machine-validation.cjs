const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  healthUrl: "http://127.0.0.1:7077/health",
  reportDir: path.join("validation-results", "cross-machine-validation")
};

function usage() {
  return [
    "Usage:",
    "  node scripts/cross-machine-validation.cjs [options]",
    "",
    "Options:",
    "  --strict                 Require 117, 137 and the concurrent conference smoke",
    "  --require-windows-117    Fail if the 117 Windows validation path is skipped",
    "  --require-kylin-137      Fail if the 137 Kylin validation path is skipped",
    "  --require-conference     Fail if the 117+137 conference validation is skipped",
    "  --help                   Show this help",
    "",
    "Environment:",
    "  UST_CROSS_HEALTH_URL              Default: http://127.0.0.1:7077/health",
    "  UST_CROSS_REPORT_DIR              Default validation report directory",
    "  UST_CROSS_SKIP_WINDOWS_117        Skip 117 Windows steps",
    "  UST_CROSS_SKIP_KYLIN_137          Skip 137 Kylin steps",
    "  UST_CROSS_STRICT_REMOTE_COVERAGE  Same as --strict",
    "  UST_CROSS_REQUIRE_WINDOWS_117     Same as --require-windows-117",
    "  UST_CROSS_REQUIRE_KYLIN_137       Same as --require-kylin-137",
    "  UST_CROSS_REQUIRE_CONFERENCE      Same as --require-conference",
    "  UST_KYLIN_SUDO_PASSWORD           Required for restricted 137 LAN DevTools validation"
  ].join("\n");
}

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function parseJsonFromOutput(text) {
  const value = String(text || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function envFlag(name, fallback = "false") {
  const value = env(name, fallback).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function hasArg(argv, name) {
  return argv.includes(name);
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

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function bytesToGiB(bytes) {
  return round(Number(bytes || 0) / 1024 / 1024 / 1024, 2);
}

function captureLocalWindowsResources() {
  const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$os = Get-CimInstance Win32_OperatingSystem
$cpuLoad = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |
  Measure-Object -Property LoadPercentage -Average).Average
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" -ErrorAction SilentlyContinue |
  Select-Object DeviceID,
    @{Name="SizeGiB"; Expression={ if ($_.Size) { [math]::Round($_.Size / 1GB, 2) } else { 0 } }},
    @{Name="FreeGiB"; Expression={ if ($_.FreeSpace) { [math]::Round($_.FreeSpace / 1GB, 2) } else { 0 } }},
    @{Name="FreePercent"; Expression={ if ($_.Size) { [math]::Round(($_.FreeSpace / $_.Size) * 100, 1) } else { 0 } }})
$processes = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { @("chrome", "msedge", "node", "electron") -contains $_.ProcessName } |
  Sort-Object WorkingSet64 -Descending |
  Select-Object -First 16 Id, ProcessName,
    @{Name="WorkingSetMiB"; Expression={ [math]::Round($_.WorkingSet64 / 1MB, 1) }},
    @{Name="CpuSeconds"; Expression={ if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 } }})
[ordered]@{
  ok = $true
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  cpu = [ordered]@{
    logicalProcessors = [int]$env:NUMBER_OF_PROCESSORS
    loadPercent = if ($null -ne $cpuLoad) { [math]::Round([double]$cpuLoad, 1) } else { $null }
  }
  memory = [ordered]@{
    totalGiB = if ($os.TotalVisibleMemorySize) { [math]::Round(([double]$os.TotalVisibleMemorySize * 1KB) / 1GB, 2) } else { 0 }
    freeGiB = if ($os.FreePhysicalMemory) { [math]::Round(([double]$os.FreePhysicalMemory * 1KB) / 1GB, 2) } else { 0 }
    freePercent = if ($os.TotalVisibleMemorySize) { [math]::Round(([double]$os.FreePhysicalMemory / [double]$os.TotalVisibleMemorySize) * 100, 1) } else { 0 }
  }
  disks = $disks
  processes = $processes
} | ConvertTo-Json -Depth 8
`.trim();

  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  const parsed = parseJsonFromOutput(result.stdout);
  return (
    parsed || {
      ok: false,
      error: result.error?.message || result.stderr || "local Windows resource probe did not return JSON"
    }
  );
}

function captureLocalUnixResources() {
  const df = spawnSync("df", ["-Pk", "/"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  const ps = spawnSync("ps", ["-eo", "pid=,comm=,rss=,pcpu=,pmem=", "--sort=-rss"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true
  });
  const diskLine = String(df.stdout || "")
    .trim()
    .split(/\r?\n/)
    .slice(1)[0];
  const [, sizeKb, usedKb, availableKb, usedPercent] = diskLine ? diskLine.trim().split(/\s+/) : [];
  const processes = String(ps.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:chrome|chromium|node|electron)/i.test(line))
    .slice(0, 16)
    .map((line) => {
      const [pid, command, rssKb, cpuPercent, memoryPercent] = line.split(/\s+/);
      return {
        pid: Number(pid) || 0,
        command: command || "",
        rssMiB: round(Number(rssKb || 0) / 1024, 1),
        cpuPercent: Number(cpuPercent) || 0,
        memoryPercent: Number(memoryPercent) || 0
      };
    });
  return {
    ok: true,
    capturedAt: new Date().toISOString(),
    memory: {
      totalGiB: bytesToGiB(os.totalmem()),
      freeGiB: bytesToGiB(os.freemem()),
      freePercent: round((os.freemem() / os.totalmem()) * 100, 1)
    },
    diskRoot: {
      sizeGiB: round(Number(sizeKb || 0) / 1024 / 1024, 2),
      usedGiB: round(Number(usedKb || 0) / 1024 / 1024, 2),
      availableGiB: round(Number(availableKb || 0) / 1024 / 1024, 2),
      usedPercent: usedPercent || ""
    },
    processes
  };
}

function captureLocalResources(label) {
  const snapshot = {
    label,
    capturedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      logicalProcessors: os.cpus().length,
      loadavg: os.loadavg()
    },
    node: {
      version: process.version,
      pid: process.pid,
      memory: {
        rssMiB: round(process.memoryUsage().rss / 1024 / 1024, 1),
        heapUsedMiB: round(process.memoryUsage().heapUsed / 1024 / 1024, 1)
      }
    },
    memory: {
      totalGiB: bytesToGiB(os.totalmem()),
      freeGiB: bytesToGiB(os.freemem()),
      freePercent: round((os.freemem() / os.totalmem()) * 100, 1)
    }
  };

  try {
    snapshot.system = process.platform === "win32" ? captureLocalWindowsResources() : captureLocalUnixResources();
  } catch (error) {
    snapshot.system = { ok: false, error: error.message };
  }

  return snapshot;
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
    path.join("test-results", "remote-lan-topology"),
    path.join("test-results", "remote-windows-probe"),
    path.join("test-results", "remote-kylin-probe"),
    path.join("test-results", "remote-kylin-discovery"),
    path.join("test-results", "remote-windows-media-smoke"),
    path.join("test-results", "remote-windows-audio-smoke"),
    path.join("test-results", "remote-kylin-media-smoke"),
    path.join("test-results", "remote-kylin-audio-smoke"),
    path.join("test-results", "remote-cross-conference-smoke")
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

function describeExitCode(exitCode) {
  if (!Number.isInteger(exitCode)) {
    return {
      exitCode: exitCode ?? null,
      exitCodeHex: "",
      exitCodeName: ""
    };
  }
  const normalized = exitCode >>> 0;
  const exitCodeHex = `0x${normalized.toString(16).padStart(8, "0").toUpperCase()}`;
  const knownNames = new Map([
    [0xc0000409, "STATUS_STACK_BUFFER_OVERRUN"],
    [0xc0000005, "STATUS_ACCESS_VIOLATION"],
    [0xc000001d, "STATUS_ILLEGAL_INSTRUCTION"],
    [0xc0000135, "STATUS_DLL_NOT_FOUND"],
    [0xc0000139, "STATUS_ENTRYPOINT_NOT_FOUND"]
  ]);
  return {
    exitCode,
    exitCodeHex,
    exitCodeName: knownNames.get(normalized) || ""
  };
}

function resourceSummary(snapshot) {
  const system = snapshot?.system || {};
  const memory = system.memory || snapshot?.memory || {};
  const cpu = system.cpu || {};
  const processes = Array.isArray(system.processes) ? system.processes.length : 0;
  return [
    `captured=${snapshot?.capturedAt || "-"}`,
    `cpu=${cpu.loadPercent ?? "-"}`,
    `memoryFreeGiB=${memory.freeGiB ?? "-"}`,
    `memoryFreePercent=${memory.freePercent ?? "-"}`,
    `processes=${processes}`
  ].join(", ");
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
    "## Local Resources",
    "",
    `- Before: ${resourceSummary(report.systemResources?.before)}`,
    `- After: ${resourceSummary(report.systemResources?.after)}`,
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
    "- Probe snapshots, diagnostic snapshots and CSV reports are copied into the artifacts directory before this report is finalized.",
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
    ...describeExitCode(result.status),
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

function failRequirement(id, title, report, reason) {
  const entry = {
    id,
    title,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    status: "failed",
    reason
  };
  report.steps.push(entry);
  console.log(`\n[${id}] failed: ${reason}`);
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

async function main(argv = []) {
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    console.log(usage());
    return;
  }

  const strictRemoteCoverage = hasArg(argv, "--strict") || envFlag("UST_CROSS_STRICT_REMOTE_COVERAGE");
  const config = {
    healthUrl: env("UST_CROSS_HEALTH_URL", DEFAULTS.healthUrl),
    reportDir: env("UST_CROSS_REPORT_DIR", DEFAULTS.reportDir),
    skipWindows117: envFlag("UST_CROSS_SKIP_WINDOWS_117"),
    skipKylin137: envFlag("UST_CROSS_SKIP_KYLIN_137"),
    strictRemoteCoverage,
    requireWindows117:
      strictRemoteCoverage || hasArg(argv, "--require-windows-117") || envFlag("UST_CROSS_REQUIRE_WINDOWS_117"),
    requireKylin137:
      strictRemoteCoverage || hasArg(argv, "--require-kylin-137") || envFlag("UST_CROSS_REQUIRE_KYLIN_137"),
    requireConference:
      strictRemoteCoverage || hasArg(argv, "--require-conference") || envFlag("UST_CROSS_REQUIRE_CONFERENCE"),
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
    systemResources: {
      before: captureLocalResources("before"),
      after: null
    },
    steps: []
  };

  try {
    report.healthBefore = await fetchHealth(config.healthUrl);
  } catch (error) {
    report.healthBefore = { ok: false, error: error.message };
  }

  const windowsSteps = [
    step("117-probe", "117 Windows environment probe", "test:remote:windows:probe", 60000),
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

  const conferenceSteps = [
    retryingStep(
      "117-137-conference",
      "117 Windows + 137 Kylin concurrent conference smoke",
      "test:remote:conference:lan",
      360000
    )
  ];
  const kylinDiscoveryStep = step(
    "137-discovery",
    "137 Kylin SSH host discovery diagnostic",
    "test:remote:kylin:discover",
    120000
  );
  const lanTopologyStep = step(
    "lan-topology",
    "118/117/137 LAN topology diagnostic",
    "test:remote:lan:topology",
    90000
  );

  const hasFailedStep = () => report.steps.some((item) => item.status === "failed");
  const runKylinDiscovery = () => {
    if (!report.steps.some((item) => item.id === kylinDiscoveryStep.id)) {
      runStep(kylinDiscoveryStep, report);
    }
  };

  if (config.skipWindows117) {
    skipStep(lanTopologyStep, report, "UST_CROSS_SKIP_WINDOWS_117 is enabled");
    windowsSteps.forEach((item) => skipStep(item, report, "UST_CROSS_SKIP_WINDOWS_117 is enabled"));
    if (config.requireWindows117) {
      failRequirement(
        "117-required-coverage",
        "117 Windows required coverage",
        report,
        "117 Windows validation is required but UST_CROSS_SKIP_WINDOWS_117 is enabled"
      );
    }
  } else {
    runStep(lanTopologyStep, report);
    for (const item of windowsSteps) {
      const entry = runStep(item, report);
      if (entry.status !== "passed") break;
    }
  }

  if (config.skipKylin137) {
    kylinSteps.forEach((item) => skipStep(item, report, "UST_CROSS_SKIP_KYLIN_137 is enabled"));
    if (config.requireKylin137) {
      failRequirement(
        "137-required-coverage",
        "137 Kylin required coverage",
        report,
        "137 Kylin validation is required but UST_CROSS_SKIP_KYLIN_137 is enabled"
      );
    }
  } else if (!config.hasKylinSudoPassword) {
    const reason = "UST_KYLIN_SUDO_PASSWORD is required for temporary 137 LAN DevTools firewall rule";
    kylinSteps.forEach((item) => skipStep(item, report, reason));
    runKylinDiscovery();
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
      if (entry.status !== "passed" && item.id === "137-probe") {
        runKylinDiscovery();
      }
      if (entry.status !== "passed") break;
    }
  }

  if (config.skipWindows117) {
    conferenceSteps.forEach((item) => skipStep(item, report, "UST_CROSS_SKIP_WINDOWS_117 is enabled"));
    if (config.requireConference) {
      failRequirement(
        "conference-required-coverage",
        "117+137 conference required coverage",
        report,
        "conference validation is required but 117 Windows validation is skipped"
      );
    }
  } else if (config.skipKylin137) {
    conferenceSteps.forEach((item) => skipStep(item, report, "UST_CROSS_SKIP_KYLIN_137 is enabled"));
    if (config.requireConference) {
      failRequirement(
        "conference-required-coverage",
        "117+137 conference required coverage",
        report,
        "conference validation is required but 137 Kylin validation is skipped"
      );
    }
  } else if (!config.hasKylinSudoPassword) {
    conferenceSteps.forEach(
      (item) => skipStep(item, report, "UST_KYLIN_SUDO_PASSWORD is required for concurrent 137 LAN DevTools validation")
    );
    if (config.requireConference) {
      failRequirement(
        "conference-required-env",
        "117+137 conference required environment",
        report,
        "UST_KYLIN_SUDO_PASSWORD is required for required concurrent 137 LAN DevTools validation"
      );
    }
  } else if (hasFailedStep()) {
    conferenceSteps.forEach((item) => skipStep(item, report, "a prerequisite remote validation step failed"));
  } else {
    for (const item of conferenceSteps) {
      const entry = runStep(item, report);
      if (entry.status !== "passed") break;
    }
  }

  try {
    report.healthAfter = await fetchHealth(config.healthUrl);
  } catch (error) {
    report.healthAfter = { ok: false, error: error.message };
  }
  report.systemResources.after = captureLocalResources("after");

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

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Cross-machine validation failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  describeExitCode
};
