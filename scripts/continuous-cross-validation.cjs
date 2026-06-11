const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  reportDir: path.join("validation-results", "cross-machine-validation"),
  intervalSeconds: 300,
  iterations: 1,
  crossScript: "test:remote:cross"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function envFlag(name, fallback = "false") {
  const value = env(name, fallback).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function usage() {
  return [
    "Usage:",
    "  node scripts/continuous-cross-validation.cjs [options]",
    "",
    "Options:",
    "  --once                         Run exactly one cycle",
    "  --iterations <count>           Number of cycles; 0 means unlimited when duration is set",
    "  --duration-seconds <seconds>   Stop when the duration limit is reached",
    "  --duration-minutes <minutes>   Stop when the duration limit is reached",
    "  --duration-hours <hours>       Stop when the duration limit is reached",
    "  --interval-seconds <seconds>   Delay between cycles",
    "  --cross-script <npm-script>    Cross-machine validation npm script to run each cycle",
    "  --stop-on-failure              Stop the loop after the first failed cycle",
    "  --skip-resource-index          Do not refresh the resource trend index after each cycle",
    "  --skip-status-gate             Do not run the strict status gate after strict cycles",
    "  --help                         Show this help",
    "",
    "Environment:",
    "  UST_CROSS_LOOP_REPORT_DIR          Ledger and report directory",
    "  UST_CROSS_REPORT_DIR               Fallback report directory",
    "  UST_CROSS_LOOP_ITERATIONS          Default cycle count",
    "  UST_CROSS_LOOP_DURATION_SECONDS    Default duration limit",
    "  UST_CROSS_LOOP_INTERVAL_SECONDS    Default interval",
    "  UST_CROSS_LOOP_CROSS_SCRIPT        Default cross-machine npm script",
    "  UST_CROSS_LOOP_STOP_ON_FAILURE     Stop after first failed cycle",
    "  UST_CROSS_LOOP_SKIP_RESOURCE_INDEX Skip resource trend index refresh",
    "  UST_CROSS_LOOP_SKIP_STATUS_GATE    Skip strict status gate"
  ].join("\n");
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function parsePositiveNumber(value, fallback, name) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return number;
}

function parseArgs(argv) {
  const help = argv.includes("--help") || argv.includes("-h");
  const once = argv.includes("--once");
  const durationSecondsArg = readArg(argv, "--duration-seconds");
  const durationSeconds = durationSecondsArg
    ? parsePositiveNumber(durationSecondsArg, 0, "--duration-seconds")
    : parsePositiveNumber(env("UST_CROSS_LOOP_DURATION_SECONDS", ""), 0, "UST_CROSS_LOOP_DURATION_SECONDS");
  const durationMinutes = parsePositiveNumber(readArg(argv, "--duration-minutes"), 0, "--duration-minutes");
  const durationHours = parsePositiveNumber(readArg(argv, "--duration-hours"), 0, "--duration-hours");
  const durationMs = Math.floor((durationSeconds + durationMinutes * 60 + durationHours * 3600) * 1000);
  const requestedIterations = readArg(argv, "--iterations") || env("UST_CROSS_LOOP_ITERATIONS", DEFAULTS.iterations);
  const iterations = once ? 1 : parsePositiveNumber(requestedIterations, DEFAULTS.iterations, "--iterations");
  const intervalSeconds = parsePositiveNumber(
    readArg(argv, "--interval-seconds") || env("UST_CROSS_LOOP_INTERVAL_SECONDS", DEFAULTS.intervalSeconds),
    DEFAULTS.intervalSeconds,
    "--interval-seconds"
  );

  const normalizedIterations = iterations === 0 ? Number.POSITIVE_INFINITY : Math.floor(iterations);
  if (!Number.isFinite(normalizedIterations) && durationMs === 0) {
    throw new Error("--iterations 0 requires a duration limit");
  }

  const crossScript = readArg(argv, "--cross-script") || env("UST_CROSS_LOOP_CROSS_SCRIPT", DEFAULTS.crossScript);
  const strictPostChecks = crossScript === "test:remote:cross:strict";
  return {
    help,
    reportDir: env("UST_CROSS_LOOP_REPORT_DIR", env("UST_CROSS_REPORT_DIR", DEFAULTS.reportDir)),
    crossScript,
    strictPostChecks,
    iterations: normalizedIterations,
    durationMs,
    intervalSeconds,
    stopOnFailure: argv.includes("--stop-on-failure") || envFlag("UST_CROSS_LOOP_STOP_ON_FAILURE"),
    skipResourceIndex: argv.includes("--skip-resource-index") || envFlag("UST_CROSS_LOOP_SKIP_RESOURCE_INDEX"),
    skipStatusGate: argv.includes("--skip-status-gate") || envFlag("UST_CROSS_LOOP_SKIP_STATUS_GATE")
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function npmCommandParts(script, extraArgs = []) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "npm", "run", script, ...extraArgs]
    };
  }
  return {
    command: "npm",
    args: ["run", script, ...extraArgs]
  };
}

function tail(text, maxChars = 12000) {
  const value = String(text || "");
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function runNpmScript(script, extraArgs = [], timeoutMs = 900000) {
  const parts = npmCommandParts(script, extraArgs);
  const startedAt = new Date();
  console.log(`\n[loop] npm run ${script}${extraArgs.length ? ` ${extraArgs.join(" ")}` : ""}`);
  const result = spawnSync(parts.command, parts.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 30
  });
  const finishedAt = new Date();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  return {
    script,
    command: [parts.command, ...parts.args].join(" "),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal || "",
    error: result.error?.message || "",
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function latestCrossReport(reportDir, startedAfterMs) {
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return null;
  const candidates = fs
    .readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !name.startsWith("continuous-"))
    .filter((name) => name !== "status.json")
    .filter((name) => name !== "artifact-manifest.json")
    .map((name) => path.join(reportDir, name))
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
    .filter((item) => item.mtimeMs >= startedAfterMs - 5000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) return null;

  const reportPath = candidates[0].filePath;
  const report = readJson(reportPath);
  return {
    id: path.basename(reportPath, ".json"),
    reportPath,
    ok: Boolean(report.ok),
    startedAt: report.startedAt || "",
    finishedAt: report.finishedAt || "",
    failedSteps: (report.steps || []).filter((step) => step.status === "failed").map((step) => step.id),
    skippedSteps: (report.steps || []).filter((step) => step.status === "skipped").map((step) => step.id),
    healthClean: Boolean(report.healthClean),
    healthAfter: report.healthAfter || null,
    artifactCount: report.artifactArchive?.fileCount ?? 0
  };
}

function renderMarkdown(ledger) {
  const lines = [
    "# UST Continuous Cross-Machine Validation Ledger",
    "",
    `- Result: ${ledger.ok ? "PASS" : "FAIL"}`,
    `- Started: ${ledger.startedAt}`,
    `- Finished: ${ledger.finishedAt || "-"}`,
    `- Report directory: ${ledger.config.reportDir}`,
    `- Cross script: ${ledger.config.crossScript}`,
    `- Cycles: ${ledger.cycles.length}`,
    `- Stop reason: ${ledger.stopReason || "-"}`,
    "",
    "| Cycle | Result | Index | Resources | Status gate | Cross report | Failed steps | Duration ms |",
    "|---:|---:|---:|---:|---:|---|---|---:|"
  ];

  for (const cycle of ledger.cycles) {
    lines.push(
      `| ${cycle.iteration} | ${cycle.ok ? "PASS" : "FAIL"} | ${cycle.index?.status || "-"} | ${cycle.resourceIndex?.status || "-"} | ${cycle.statusGate?.status || "-"} | ${cycle.crossReport?.reportPath || "-"} | ${(cycle.crossReport?.failedSteps || []).join(", ") || "-"} | ${cycle.durationMs} |`
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- Each cycle runs the existing single cross-machine validation command first.",
    "- The validation index is regenerated after every cycle to verify report and artifact hashes.",
    "- The resource trend index is regenerated after every cycle unless disabled.",
    "- Strict loops run the current status gate after the cycle is written unless disabled.",
    "- Full command output tails are retained in the JSON ledger."
  );
  return `${lines.join("\n")}\n`;
}

function refreshLedgerOk(ledger) {
  ledger.ok = ledger.cycles.length > 0 && ledger.cycles.every((cycle) => cycle.ok);
}

function writeLedger(ledger, paths) {
  refreshLedgerOk(ledger);
  ledger.updatedAt = new Date().toISOString();
  const json = `${JSON.stringify(ledger, null, 2)}\n`;
  const digest = sha256(json);
  fs.writeFileSync(paths.jsonPath, json, "utf8");
  fs.writeFileSync(paths.mdPath, renderMarkdown(ledger), "utf8");
  fs.writeFileSync(paths.sha256Path, `${digest}  ${path.basename(paths.jsonPath)}\n`, "utf8");
  return digest;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRunNextCycle(ledger, options, startedMs) {
  if (ledger.cycles.length >= options.iterations) return false;
  if (options.durationMs > 0 && Date.now() - startedMs >= options.durationMs) return false;
  return true;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  ensureDir(options.reportDir);
  const ledgerId = `continuous-${nowStamp()}`;
  const paths = {
    jsonPath: path.join(options.reportDir, `${ledgerId}.json`),
    mdPath: path.join(options.reportDir, `${ledgerId}.md`),
    sha256Path: path.join(options.reportDir, `${ledgerId}.sha256`)
  };
  const startedMs = Date.now();
  const ledger = {
    id: ledgerId,
    ok: false,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: "",
    updatedAt: "",
    stopReason: "",
    config: {
      reportDir: options.reportDir,
      crossScript: options.crossScript,
      iterations: Number.isFinite(options.iterations) ? options.iterations : "unlimited",
      durationMs: options.durationMs,
      intervalSeconds: options.intervalSeconds,
      stopOnFailure: options.stopOnFailure,
      strictPostChecks: options.strictPostChecks,
      skipResourceIndex: options.skipResourceIndex,
      skipStatusGate: options.skipStatusGate
    },
    cycles: []
  };
  writeLedger(ledger, paths);

  while (shouldRunNextCycle(ledger, options, startedMs)) {
    const iteration = ledger.cycles.length + 1;
    const cycleStartedMs = Date.now();
    const cycle = {
      iteration,
      ok: false,
      startedAt: new Date(cycleStartedMs).toISOString(),
      finishedAt: "",
      durationMs: 0,
      cross: null,
      index: null,
      resourceIndex: null,
      statusGate: null,
      crossReport: null
    };

    cycle.cross = runNpmScript(options.crossScript);
    cycle.crossReport = latestCrossReport(options.reportDir, cycleStartedMs);
    cycle.index = runNpmScript("test:remote:cross:index", ["--", "--json"], 120000);
    if (!options.skipResourceIndex) {
      cycle.resourceIndex = runNpmScript(
        "test:remote:cross:resources",
        options.strictPostChecks ? ["--", "--strict-only"] : [],
        120000
      );
    }
    cycle.finishedAt = new Date().toISOString();
    cycle.durationMs = Date.now() - cycleStartedMs;
    cycle.ok =
      cycle.cross.status === "passed" &&
      cycle.index.status === "passed" &&
      (!cycle.resourceIndex || cycle.resourceIndex.status === "passed") &&
      cycle.crossReport?.ok === true;
    ledger.cycles.push(cycle);
    writeLedger(ledger, paths);
    if (options.strictPostChecks && !options.skipStatusGate) {
      cycle.statusGate = runNpmScript("test:remote:cross:status", [], 120000);
      cycle.finishedAt = new Date().toISOString();
      cycle.durationMs = Date.now() - cycleStartedMs;
      cycle.ok = cycle.ok && cycle.statusGate.status === "passed";
      writeLedger(ledger, paths);
    }

    if (!cycle.ok && options.stopOnFailure) {
      ledger.stopReason = `cycle ${iteration} failed and --stop-on-failure is enabled`;
      break;
    }

    if (!shouldRunNextCycle(ledger, options, startedMs)) break;
    await sleep(options.intervalSeconds * 1000);
  }

  if (!ledger.stopReason) {
    if (ledger.cycles.length >= options.iterations) {
      ledger.stopReason = "iteration limit reached";
    } else if (options.durationMs > 0 && Date.now() - startedMs >= options.durationMs) {
      ledger.stopReason = "duration limit reached";
    } else {
      ledger.stopReason = "loop ended";
    }
  }
  ledger.finishedAt = new Date().toISOString();
  const digest = writeLedger(ledger, paths);

  console.log(
    JSON.stringify(
      {
        ok: ledger.ok,
        ledgerPath: paths.jsonPath,
        summaryPath: paths.mdPath,
        checksumPath: paths.sha256Path,
        sha256: digest,
        cycles: ledger.cycles.length,
        stopReason: ledger.stopReason
      },
      null,
      2
    )
  );

  if (!ledger.ok) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Continuous cross-machine validation failed: ${error.message}`);
  process.exit(1);
});
