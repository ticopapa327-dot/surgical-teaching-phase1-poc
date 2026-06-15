const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  reportDir: path.join("validation-results", "local-118-validation"),
  preferredAddress: "192.168.1.118"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function usage() {
  return [
    "Usage:",
    "  node scripts/local-118-validation.cjs [options]",
    "",
    "Options:",
    "  --skip-build       Do not run npm run build",
    "  --skip-scripts     Do not run npm run test:scripts",
    "  --skip-smoke       Do not run npm run test:smoke",
    "  --skip-signaling   Do not run npm run test:signaling",
    "  --include-audit    Also run npm run audit:high",
    "  --dry-run          Write the planned report without running commands",
    "  --json             Print full report JSON",
    "  --no-write         Do not write report files",
    "  --help             Show this help",
    "",
    "Environment:",
    "  UST_LOCAL_118_REPORT_DIR          Default validation report directory",
    "  UST_LOCAL_118_PREFERRED_ADDRESS   Default 192.168.1.118"
  ].join("\n");
}

function parseArgs(argv) {
  const reportDir = env("UST_LOCAL_118_REPORT_DIR", DEFAULTS.reportDir);
  return {
    help: hasArg(argv, "--help") || hasArg(argv, "-h"),
    json: hasArg(argv, "--json"),
    noWrite: hasArg(argv, "--no-write"),
    dryRun: hasArg(argv, "--dry-run"),
    reportDir,
    id: readArg(argv, "--id") || timestamp(),
    preferredAddress: env("UST_LOCAL_118_PREFERRED_ADDRESS", DEFAULTS.preferredAddress),
    steps: buildStepPlan({
      skipBuild: hasArg(argv, "--skip-build"),
      skipScripts: hasArg(argv, "--skip-scripts"),
      skipSmoke: hasArg(argv, "--skip-smoke"),
      skipSignaling: hasArg(argv, "--skip-signaling"),
      includeAudit: hasArg(argv, "--include-audit")
    })
  };
}

function buildStepPlan(options = {}) {
  const steps = [];
  if (!options.skipBuild) steps.push({ id: "build", command: "npm", args: ["run", "build"] });
  if (options.includeAudit) steps.push({ id: "audit-high", command: "npm", args: ["run", "audit:high"] });
  if (!options.skipScripts) steps.push({ id: "script-tests", command: "npm", args: ["run", "test:scripts"] });
  if (!options.skipSmoke) steps.push({ id: "ui-smoke", command: "npm", args: ["run", "test:smoke"] });
  if (!options.skipSignaling) steps.push({ id: "signaling-contract", command: "npm", args: ["run", "test:signaling"] });
  return steps;
}

function npmCommand(step) {
  if (process.platform === "win32" && step.command === "npm") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", ...step.args] };
  }
  return step;
}

function tail(text, maxChars = 6000) {
  const value = String(text || "");
  return value.length <= maxChars ? value : value.slice(value.length - maxChars);
}

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

function nodeLocalAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, items = []]) =>
      items
        .filter((item) => item && item.family === "IPv4" && !item.internal)
        .map((item) => ({ name, address: item.address, mac: item.mac || "" }))
    );
}

function sortAddresses(addresses, preferredAddress = DEFAULTS.preferredAddress) {
  return addresses.sort((left, right) => {
    if (left.address === preferredAddress) return -1;
    if (right.address === preferredAddress) return 1;
    const leftLan = left.address.startsWith("192.168.") ? 0 : 1;
    const rightLan = right.address.startsWith("192.168.") ? 0 : 1;
    if (leftLan !== rightLan) return leftLan - rightLan;
    return left.name.localeCompare(right.name);
  });
}

function parseJsonFromOutput(text) {
  const value = String(text || "").trim();
  const objectStart = value.indexOf("{");
  const arrayStart = value.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = value.lastIndexOf(value[start] === "[" ? "]" : "}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function captureWindowsAddresses(preferredAddress = DEFAULTS.preferredAddress) {
  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$adapters = @{}
Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | ForEach-Object {
  $adapters[[int]$_.InterfaceIndex] = $_
}
@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPAddress -and
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254.*"
  } |
  ForEach-Object {
    $adapter = $adapters[[int]$_.InterfaceIndex]
    $mac = ""
    if ($adapter -and $adapter.MacAddress) {
      $mac = ($adapter.MacAddress -replace "-", ":").ToLowerInvariant()
    }
    [ordered]@{
      name = if ($adapter -and $adapter.Name) { $adapter.Name } else { $_.InterfaceAlias }
      address = $_.IPAddress
      mac = $mac
      interfaceIndex = [int]$_.InterfaceIndex
    }
  }) | ConvertTo-Json -Depth 4
`.trim();
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  const parsed = parseJsonFromOutput(result.stdout);
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return sortAddresses(
    items
      .filter((item) => item && item.name && item.address)
      .map((item) => ({
        name: String(item.name),
        address: String(item.address),
        mac: String(item.mac || ""),
        interfaceIndex: Number.isFinite(item.interfaceIndex) ? item.interfaceIndex : undefined
      })),
    preferredAddress
  );
}

function localAddresses(preferredAddress = DEFAULTS.preferredAddress) {
  if (process.platform === "win32") {
    const addresses = captureWindowsAddresses(preferredAddress);
    if (addresses.length) return addresses;
  }
  return sortAddresses(nodeLocalAddresses(), preferredAddress);
}

function captureWindowsResources() {
  const script = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$os = Get-CimInstance Win32_OperatingSystem
$cpuLoad = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |
  Measure-Object -Property LoadPercentage -Average).Average
$processes = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { @("chrome", "msedge", "node", "electron") -contains $_.ProcessName } |
  Sort-Object WorkingSet64 -Descending |
  Select-Object -First 12 Id, ProcessName,
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
  processes = $processes
} | ConvertTo-Json -Depth 6
`.trim();
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  return (
    parseJsonFromOutput(result.stdout) || {
      ok: false,
      capturedAt: new Date().toISOString(),
      error: result.error?.message || result.stderr || "resource probe did not return JSON"
    }
  );
}

function captureResources() {
  if (process.platform === "win32") return captureWindowsResources();
  return {
    ok: true,
    capturedAt: new Date().toISOString(),
    cpu: { logicalProcessors: os.cpus().length, loadavg: os.loadavg() },
    memory: {
      totalGiB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 100) / 100,
      freeGiB: Math.round((os.freemem() / 1024 / 1024 / 1024) * 100) / 100
    }
  };
}

function runStep(step, cwd) {
  const command = npmCommand(step);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(command.command, command.args, {
    cwd,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    windowsHide: true
  });
  return {
    id: step.id,
    command: [step.command, ...step.args].join(" "),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    ok: result.status === 0 && !result.error,
    status: result.status,
    signal: result.signal || "",
    error: result.error?.message || "",
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function markdownReport(report) {
  const rows = report.steps.map(
    (step) =>
      `| ${step.id} | ${step.ok === false ? "FAIL" : "PASS"} | ${
        Number.isFinite(step.durationMs) ? Math.round(step.durationMs / 1000) : ""
      } | ${
        step.status ?? ""
      } |`
  );
  return [
    "# 118 Local Validation",
    "",
    `- Result: ${report.ok ? "PASS" : "FAIL"}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt || ""}`,
    `- Host: ${report.host.hostname}`,
    `- Preferred address: ${report.network.preferredAddress}`,
    `- Report JSON: ${path.basename(report.reportPath || "")}`,
    "",
    "| Step | Result | Seconds | Exit |",
    "|---|---:|---:|---:|",
    ...rows,
    "",
    "## Addresses",
    "",
    ...report.network.addresses.map((item) => `- ${item.name}: ${item.address}`),
    ""
  ].join("\n");
}

function writeReportFiles(report, options) {
  fs.mkdirSync(options.reportDir, { recursive: true });
  const jsonPath = path.join(options.reportDir, `${options.id}.json`);
  const mdPath = path.join(options.reportDir, `${options.id}.md`);
  const shaPath = path.join(options.reportDir, `${options.id}.sha256`);
  report.reportPath = jsonPath;
  report.markdownPath = mdPath;
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = `${markdownReport(report)}\n`;
  fs.writeFileSync(jsonPath, json, "utf8");
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(shaPath, `${sha256(json)}  ${path.basename(jsonPath)}\n`, "utf8");
  return { jsonPath, mdPath, shaPath };
}

function buildInitialReport(options) {
  const addresses = localAddresses(options.preferredAddress);
  return {
    schema: "ust-local-118-validation-v1",
    id: options.id,
    ok: false,
    dryRun: options.dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      node: process.version
    },
    network: {
      preferredAddress: options.preferredAddress,
      addresses
    },
    resources: {
      before: null,
      after: null
    },
    steps: options.steps.map((step) => ({
      id: step.id,
      command: [step.command, ...step.args].join(" "),
      planned: true
    }))
  };
}

function runValidation(options, cwd = process.cwd()) {
  const report = buildInitialReport(options);
  if (!options.dryRun) {
    report.resources.before = captureResources();
    report.steps = options.steps.map((step) => runStep(step, cwd));
    report.resources.after = captureResources();
  }
  report.finishedAt = new Date().toISOString();
  report.ok = report.steps.every((step) => step.ok !== false);
  return report;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = runValidation(options);
  let files = null;
  if (!options.noWrite) files = writeReportFiles(report, options);
  const summary = {
    ok: report.ok,
    id: report.id,
    dryRun: report.dryRun,
    reportPath: files?.jsonPath || "",
    markdownPath: files?.mdPath || "",
    failedSteps: report.steps.filter((step) => step.ok === false).map((step) => step.id)
  };
  process.stdout.write(`${JSON.stringify(options.json ? report : summary, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Local 118 validation failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildStepPlan,
  localAddresses,
  markdownReport,
  parseArgs,
  runValidation,
  timestamp
};
