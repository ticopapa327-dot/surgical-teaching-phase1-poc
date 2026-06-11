const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "xyzn@192.168.1.137",
  webUrl: "http://192.168.1.118:5173/",
  signalingHealthUrl: "http://192.168.1.118:7077/health",
  artifactDir: path.join("test-results", "remote-kylin-probe"),
  sshTimeoutMs: "15000"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function stripLoginBanner(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim() !== "Kylin V10 SP1")
    .join("\n")
    .trim();
}

function runSsh(config, command, options = {}) {
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", config.sshTarget, command],
    {
      encoding: "utf8",
      timeout: options.timeoutMs || Number(config.sshTimeoutMs),
      windowsHide: true
    }
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: stripLoginBanner(result.stdout),
    stderr: stripLoginBanner(result.stderr),
    error: result.error?.message || ""
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function commandValue(result) {
  return result.stdout || result.stderr || result.error || "";
}

function parseKylinResources(text) {
  const resources = {
    raw: String(text || ""),
    capturedAt: "",
    loadavg: "",
    memory: {
      totalGiB: 0,
      availableGiB: 0,
      availablePercent: 0
    },
    diskRoot: {
      sizeGiB: 0,
      usedGiB: 0,
      availableGiB: 0,
      usedPercent: ""
    },
    processes: []
  };
  let inProcesses = false;
  for (const rawLine of resources.raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "processes=") {
      inProcesses = true;
      continue;
    }
    if (!inProcesses && line.includes("=")) {
      const index = line.indexOf("=");
      const key = line.slice(0, index);
      const value = line.slice(index + 1).trim();
      if (key === "capturedAt") resources.capturedAt = value;
      if (key === "loadavg") resources.loadavg = value;
      if (key === "memTotalKb") {
        resources.memory.totalGiB = Math.round((Number(value) / 1024 / 1024) * 100) / 100;
      }
      if (key === "memAvailableKb") {
        resources.memory.availableGiB = Math.round((Number(value) / 1024 / 1024) * 100) / 100;
      }
      if (key === "diskRoot") {
        const [sizeKb, usedKb, availableKb, usedPercent] = value.split(",");
        resources.diskRoot = {
          sizeGiB: Math.round((Number(sizeKb) / 1024 / 1024) * 100) / 100,
          usedGiB: Math.round((Number(usedKb) / 1024 / 1024) * 100) / 100,
          availableGiB: Math.round((Number(availableKb) / 1024 / 1024) * 100) / 100,
          usedPercent: usedPercent || ""
        };
      }
      continue;
    }

    if (inProcesses || /^\d+\s+/.test(line)) {
      const [pid, command, rssKb, cpuPercent, memoryPercent] = line.split(/\s+/);
      if (!pid || !/^\d+$/.test(pid)) continue;
      resources.processes.push({
        pid: Number(pid),
        command: command || "",
        rssMiB: Math.round((Number(rssKb) / 1024) * 10) / 10,
        cpuPercent: Number(cpuPercent) || 0,
        memoryPercent: Number(memoryPercent) || 0
      });
    }
  }
  if (resources.memory.totalGiB > 0) {
    resources.memory.availablePercent =
      Math.round((resources.memory.availableGiB / resources.memory.totalGiB) * 1000) / 10;
  }
  return resources;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeProbeArtifact(payload, artifactDir) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${nowStamp()}.json`);
  payload.artifactPath = artifactPath;
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return artifactPath;
}

function configFromEnv() {
  return {
    sshTarget: env("UST_KYLIN_SSH_TARGET", DEFAULTS.sshTarget),
    webUrl: env("UST_KYLIN_WEB_URL", DEFAULTS.webUrl),
    signalingHealthUrl: env("UST_KYLIN_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    artifactDir: env("UST_KYLIN_PROBE_ARTIFACT_DIR", DEFAULTS.artifactDir),
    sshTimeoutMs: env("UST_KYLIN_SSH_TIMEOUT_MS", DEFAULTS.sshTimeoutMs)
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-kylin-probe.cjs",
    "",
    "Environment:",
    "  UST_KYLIN_SSH_TARGET             Default: xyzn@192.168.1.137",
    "  UST_KYLIN_WEB_URL                Default: http://192.168.1.118:5173/",
    "  UST_KYLIN_SIGNALING_HEALTH_URL   Default: http://192.168.1.118:7077/health",
    "  UST_KYLIN_PROBE_ARTIFACT_DIR     Default: test-results/remote-kylin-probe",
    "  UST_KYLIN_SSH_TIMEOUT_MS         Default: 15000"
  ].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const config = configFromEnv();
  const ssh = runSsh(config, "uname -a");
  const webStatus = ssh.ok
    ? runSsh(config, `curl -sS -o /dev/null -w '%{http_code}' ${config.webUrl}`)
    : { ok: false, stdout: "", stderr: "ssh_unavailable" };
  const signalingHealth = ssh.ok
    ? runSsh(config, `curl -sS ${config.signalingHealthUrl}`)
    : { ok: false, stdout: "", stderr: "ssh_unavailable" };
  const browserPath = ssh.ok ? runSsh(config, "which kylin-browser") : { ok: false, stdout: "" };
  const browserVersion = ssh.ok
    ? runSsh(config, "kylin-browser --version 2>&1 | head -n 1")
    : { ok: false, stdout: "" };
  const runtime = ssh.ok
    ? runSsh(
        config,
        [
          "printf 'node='; which node 2>/dev/null || true; printf '\\n'",
          "printf 'nodeVersion='; node -v 2>/dev/null || true; printf '\\n'",
          "printf 'npm='; which npm 2>/dev/null || true; printf '\\n'",
          "printf 'npmVersion='; npm -v 2>/dev/null || true; printf '\\n'",
          "printf 'python3='; which python3 2>/dev/null || true; printf '\\n'",
          "printf 'python3Version='; python3 --version 2>&1 || true; printf '\\n'",
          "printf 'curl='; which curl 2>/dev/null || true; printf '\\n'",
          "printf 'curlVersion='; curl --version 2>/dev/null | head -n 1 || true; printf '\\n'"
        ].join("; ")
      )
    : { ok: false, stdout: "" };
  const desktop = ssh.ok
    ? runSsh(
        config,
        "printf 'DISPLAY='; printenv DISPLAY || true; printf '\\n'; ps -ef | grep -Ei 'kylin-browser|chrome|chromium|firefox' | grep -v grep | head -n 10"
      )
    : { ok: false, stdout: "" };
  const resources = ssh.ok
    ? runSsh(
        config,
        [
          "printf 'capturedAt='; date -Iseconds; printf '\\n'",
          "printf 'loadavg='; cat /proc/loadavg; printf '\\n'",
          "printf 'memTotalKb='; awk '/MemTotal/ {print $2}' /proc/meminfo; printf '\\n'",
          "printf 'memAvailableKb='; awk '/MemAvailable/ {print $2}' /proc/meminfo; printf '\\n'",
          "printf 'diskRoot='; df -Pk / | awk 'NR==2 {print $2\",\"$3\",\"$4\",\"$5}'; printf '\\n'",
          "printf 'processes=\\n'; ps -eo pid=,comm=,rss=,pcpu=,pmem= --sort=-rss | grep -Ei 'kylin-browser|chrome|chromium|node|electron' | head -n 12 | sed 's/^[[:space:]]*//; s/[[:space:]][[:space:]]*/ /g'"
        ].join("; ")
      )
    : { ok: false, stdout: "" };

  const healthJson = parseJson(signalingHealth.stdout);
  const statusCode = Number(webStatus.stdout);
  const warnings = [];
  if (!runtime.stdout.includes("node=/")) warnings.push("node_not_found_on_kylin");
  if (!desktop.stdout.includes("DISPLAY=") || desktop.stdout.trim() === "DISPLAY=") {
    warnings.push("display_not_exported_in_ssh_session");
  }

  const ok =
    ssh.ok &&
    Number.isInteger(statusCode) &&
    statusCode >= 200 &&
    statusCode < 400 &&
    Boolean(healthJson?.ok) &&
    Boolean(browserPath.stdout);

  const payload = {
    ok,
    config,
    checks: {
      ssh: {
        ok: ssh.ok,
        value: commandValue(ssh)
      },
      web: {
        ok: Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 400,
        statusCode,
        stderr: webStatus.stderr
      },
      signalingHealth: {
        ok: Boolean(healthJson?.ok),
        value: healthJson || commandValue(signalingHealth)
      },
      browser: {
        ok: Boolean(browserPath.stdout),
        path: browserPath.stdout,
        version: commandValue(browserVersion)
      },
      runtime: runtime.stdout,
      desktop: desktop.stdout,
      resources: parseKylinResources(resources.stdout)
    },
    warnings
  };
  writeProbeArtifact(payload, config.artifactDir);
  console.log(JSON.stringify(payload, null, 2));

  if (!ok) process.exitCode = 1;
}

main(process.argv.slice(2));
