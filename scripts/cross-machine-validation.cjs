const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  healthUrl: "http://127.0.0.1:7077/health",
  reportDir: path.join("test-results", "cross-machine-validation")
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

async function fetchHealth(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function runStep(step, report) {
  const startedAt = new Date();
  console.log(`\n[${step.id}] ${step.title}`);
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: step.timeoutMs || 300000,
    windowsHide: true
  });
  const finishedAt = new Date();
  const entry = {
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
  report.steps.push(entry);

  if (entry.stdout.trim()) console.log(entry.stdout.trim());
  if (entry.stderr.trim()) console.error(entry.stderr.trim());
  if (entry.error) console.error(entry.error);
  console.log(`[${step.id}] ${entry.status} in ${entry.durationMs} ms`);
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
    timeoutMs
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
  const reportPath = path.join(config.reportDir, `${nowStamp()}.json`);
  const report = {
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    config,
    healthBefore: null,
    healthAfter: null,
    healthClean: false,
    steps: []
  };

  try {
    report.healthBefore = await fetchHealth(config.healthUrl);
  } catch (error) {
    report.healthBefore = { ok: false, error: error.message };
  }

  const windowsSteps = [
    step("117-signal", "117 Windows signal smoke", "test:remote:signal:tunnel", 180000),
    step("117-media", "117 Windows 4-channel media smoke", "test:remote:media:tunnel", 240000),
    step("117-audio", "117 Windows remote audio receive smoke", "test:remote:audio:tunnel", 240000),
    step("117-media-diagnostics", "117 Windows media diagnostics", "test:remote:diagnostics", 60000),
    step("117-audio-diagnostics", "117 Windows audio diagnostics", "test:remote:audio:diagnostics", 60000)
  ];

  const kylinSteps = [
    step("137-probe", "137 Kylin environment probe", "test:remote:kylin:probe", 60000),
    step("137-signal", "137 Kylin signal smoke", "test:remote:kylin:signal:lan", 180000),
    step("137-media", "137 Kylin 4-channel media smoke", "test:remote:kylin:media:lan", 240000),
    step("137-audio", "137 Kylin remote audio receive smoke", "test:remote:kylin:audio:lan", 240000),
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

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        reportPath,
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
