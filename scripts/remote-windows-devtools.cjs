const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "HUAWEI@192.168.1.117",
  remoteHost: "127.0.0.1",
  remotePort: "9222",
  localHost: "127.0.0.1",
  localPort: "9224",
  statePath: path.join("test-results", "remote-windows-devtools", "state.json"),
  remoteUserDataTag: "ust-edge-remote-debug-ssh",
  secureOrigins: "http://192.168.1.118:5173",
  fakeUiForMediaStream: "true",
  fakeDeviceForMediaStream: "true",
  headless: "true"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function envFlag(name, fallback) {
  const value = env(name, fallback).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envList(name, fallback) {
  return env(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function configFromEnv() {
  const localHost = env("UST_REMOTE_DEVTOOLS_LOCAL_HOST", DEFAULTS.localHost);
  const localPort = env("UST_REMOTE_DEVTOOLS_LOCAL_PORT", DEFAULTS.localPort);
  const config = {
    sshTarget: env("UST_REMOTE_SSH_TARGET", DEFAULTS.sshTarget),
    remoteHost: env("UST_REMOTE_DEVTOOLS_REMOTE_HOST", DEFAULTS.remoteHost),
    remotePort: env("UST_REMOTE_DEVTOOLS_REMOTE_PORT", DEFAULTS.remotePort),
    localHost,
    localPort,
    localDebugUrl: env("UST_REMOTE_DEBUG_URL", `http://${localHost}:${localPort}`),
    statePath: env("UST_REMOTE_DEVTOOLS_STATE", DEFAULTS.statePath),
    remoteUserDataTag: env("UST_REMOTE_DEVTOOLS_USER_DATA_TAG", DEFAULTS.remoteUserDataTag),
    secureOrigins: envList("UST_REMOTE_DEVTOOLS_SECURE_ORIGINS", DEFAULTS.secureOrigins),
    fakeUiForMediaStream: envFlag("UST_REMOTE_DEVTOOLS_FAKE_UI_FOR_MEDIA_STREAM", DEFAULTS.fakeUiForMediaStream),
    fakeDeviceForMediaStream: envFlag(
      "UST_REMOTE_DEVTOOLS_FAKE_DEVICE_FOR_MEDIA_STREAM",
      DEFAULTS.fakeDeviceForMediaStream
    ),
    headless: envFlag("UST_REMOTE_DEVTOOLS_HEADLESS", DEFAULTS.headless)
  };
  config.browserArgsFingerprint = browserArgs(config).join("\n");
  return config;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-windows-devtools.cjs start",
    "  node scripts/remote-windows-devtools.cjs check",
    "  node scripts/remote-windows-devtools.cjs stop",
    "  node scripts/remote-windows-devtools.cjs run -- <command> [args...]",
    "",
    "Environment:",
    "  UST_REMOTE_SSH_TARGET              Default: HUAWEI@192.168.1.117",
    "  UST_REMOTE_DEVTOOLS_LOCAL_PORT     Default: 9224",
    "  UST_REMOTE_DEVTOOLS_REMOTE_PORT    Default: 9222",
    "  UST_REMOTE_DEBUG_URL               Default: http://127.0.0.1:9224",
    "  UST_REMOTE_DEVTOOLS_STATE          Default: test-results/remote-windows-devtools/state.json",
    "  UST_REMOTE_DEVTOOLS_SECURE_ORIGINS Default: http://192.168.1.118:5173",
    "  UST_REMOTE_DEVTOOLS_FAKE_UI_FOR_MEDIA_STREAM     Default: true",
    "  UST_REMOTE_DEVTOOLS_FAKE_DEVICE_FOR_MEDIA_STREAM Default: true",
    "  UST_REMOTE_DEVTOOLS_HEADLESS       Default: true"
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkDevTools(config, options = {}) {
  const url = `${config.localDebugUrl.replace(/\/$/, "")}/json/version`;
  try {
    const version = await fetchJson(url, options.timeoutMs || 5000);
    return { ok: true, url, version };
  } catch (error) {
    return { ok: false, url, error: error.message };
  }
}

function ensureStateDir(config) {
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
}

function readState(config) {
  try {
    return JSON.parse(fs.readFileSync(config.statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(config, state) {
  ensureStateDir(config);
  fs.writeFileSync(config.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeState(config) {
  try {
    fs.rmSync(config.statePath, { force: true });
  } catch {}
}

function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 && result.stdout.includes(`"${pid}"`);
}

function killProcessTree(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0;
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function browserArgs(config) {
  const args = [
    `--remote-debugging-port=${config.remotePort}`,
    `--remote-debugging-address=${config.remoteHost}`,
    "--remote-allow-origins=*",
    "--user-data-dir=$userDataDir",
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (config.headless) args.push("--headless=new");
  if (config.secureOrigins.length) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${config.secureOrigins.join(",")}`);
  }
  if (config.fakeUiForMediaStream) args.push("--use-fake-ui-for-media-stream");
  if (config.fakeDeviceForMediaStream) args.push("--use-fake-device-for-media-stream");
  args.push("about:blank");
  return args;
}

function powerShellArgumentList(config) {
  return browserArgs(config)
    .map((arg) => (arg === "--user-data-dir=$userDataDir" ? '"--user-data-dir=$userDataDir"' : powerShellSingleQuoted(arg)))
    .join(",\n  ");
}

function remoteEdgeScript(config) {
  const argumentList = powerShellArgumentList(config);
  return `
$ErrorActionPreference = "Stop"
$paths = @(
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe"
)
$edge = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "msedge.exe not found" }
$userDataDir = Join-Path $env:TEMP "${config.remoteUserDataTag}"
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "msedge.exe" -and
    $_.CommandLine -like "*--remote-debugging-port=${config.remotePort}*" -and
    $_.CommandLine -like "*${config.remoteUserDataTag}*"
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process -FilePath $edge -ArgumentList @(
  ${argumentList}
) -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(20)
do {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing "http://${config.remoteHost}:${config.remotePort}/json/version" -TimeoutSec 2
    if ($response.StatusCode -eq 200) { break }
  } catch {}
} while ((Get-Date) -lt $deadline)
while ($true) { Start-Sleep -Seconds 60 }
`.trim();
}

function remoteCleanupScript(config) {
  return `
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "msedge.exe" -and
    $_.CommandLine -like "*--remote-debugging-port=${config.remotePort}*" -and
    $_.CommandLine -like "*${config.remoteUserDataTag}*"
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`.trim();
}

function spawnTunnel(config) {
  const encoded = encodePowerShell(remoteEdgeScript(config));
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=2",
    "-L",
    `${config.localHost}:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
    config.sshTarget,
    "powershell",
    "-NoProfile",
    "-EncodedCommand",
    encoded
  ];
  const child = spawn("ssh", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  if (!child.pid) throw new Error("failed to start ssh tunnel process");
  child.unref();
  return child.pid;
}

async function waitForReady(config, timeoutMs = 25000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await checkDevTools(config, { timeoutMs: 2500 });
    if (last.ok) return last;
    await sleep(500);
  }
  throw new Error(`DevTools did not become ready at ${config.localDebugUrl}: ${last?.error || "timeout"}`);
}

async function start(config) {
  const existing = await checkDevTools(config, { timeoutMs: 1500 });
  if (existing.ok) {
    const state = readState(config);
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "start",
          alreadyRunning: true,
          localDebugUrl: config.localDebugUrl,
          statePath: config.statePath,
          sshPid: state?.sshPid || null,
          browser: existing.version.Browser
        },
        null,
        2
      )
    );
    return;
  }

  const previousState = readState(config);
  if (previousState?.sshPid && isProcessRunning(previousState.sshPid)) {
    killProcessTree(previousState.sshPid);
  }

  const sshPid = spawnTunnel(config);
  writeState(config, {
    sshPid,
    startedAt: new Date().toISOString(),
    localDebugUrl: config.localDebugUrl,
    sshTarget: config.sshTarget,
    remoteHost: config.remoteHost,
    remotePort: config.remotePort,
    localHost: config.localHost,
    localPort: config.localPort,
    remoteUserDataTag: config.remoteUserDataTag,
    secureOrigins: config.secureOrigins,
    fakeUiForMediaStream: config.fakeUiForMediaStream,
    fakeDeviceForMediaStream: config.fakeDeviceForMediaStream,
    headless: config.headless,
    browserArgsFingerprint: config.browserArgsFingerprint
  });

  const ready = await waitForReady(config);
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "start",
        alreadyRunning: false,
        localDebugUrl: config.localDebugUrl,
        statePath: config.statePath,
        sshPid,
        browser: ready.version.Browser
      },
      null,
      2
    )
  );
}

function runRemoteCleanup(config) {
  const encoded = encodePowerShell(remoteCleanupScript(config));
  return spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", config.sshTarget, "powershell", "-NoProfile", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true
    }
  );
}

function stop(config) {
  const state = readState(config);
  let localStopped = false;
  if (state?.sshPid && isProcessRunning(state.sshPid)) {
    localStopped = killProcessTree(state.sshPid);
  }
  const cleanup = runRemoteCleanup(config);
  removeState(config);
  console.log(
    JSON.stringify(
      {
        ok: cleanup.status === 0,
        action: "stop",
        localStopped,
        remoteCleanupExitCode: cleanup.status,
        statePath: config.statePath,
        stderr: cleanup.status === 0 ? "" : cleanup.stderr.trim()
      },
      null,
      2
    )
  );
  const exitCode = cleanup.status === 0 ? 0 : cleanup.status || 1;
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

async function check(config) {
  const result = await checkDevTools(config);
  const state = readState(config);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        action: "check",
        localDebugUrl: config.localDebugUrl,
        statePath: config.statePath,
        sshPid: state?.sshPid || null,
        sshPidRunning: state?.sshPid ? isProcessRunning(state.sshPid) : false,
        browser: result.version?.Browser || "",
        error: result.ok ? "" : result.error
      },
      null,
      2
    )
  );
  if (!result.ok) process.exitCode = 1;
}

function runCommand(config, commandArgs) {
  if (!commandArgs.length) {
    throw new Error("run requires a command after --");
  }
  let [command, ...args] = commandArgs;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", ...commandArgs];
  }
  const child = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      UST_REMOTE_DEBUG_URL: config.localDebugUrl
    },
    stdio: "inherit",
    windowsHide: false
  });
  if (child.error) {
    console.error(child.error.message);
    return 1;
  }
  return child.status ?? (child.signal ? 1 : 0);
}

function parse(argv) {
  const separatorIndex = argv.indexOf("--");
  const commandArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
  const ownArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const action = ownArgs[0] || "help";
  return { action, commandArgs };
}

async function main(argv) {
  const { action, commandArgs } = parse(argv);
  const config = configFromEnv();
  if (action === "help" || action === "--help" || action === "-h") {
    console.log(usage());
    return;
  }
  if (action === "start") {
    await start(config);
    return;
  }
  if (action === "check") {
    await check(config);
    return;
  }
  if (action === "stop") {
    stop(config);
    return;
  }
  if (action === "run") {
    await start(config);
    const exitCode = runCommand(config, commandArgs);
    const stopExitCode = stop(config);
    process.exitCode = exitCode || stopExitCode;
    return;
  }
  throw new Error(`unknown action: ${action}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Remote Windows DevTools failed: ${error.message}`);
  process.exit(1);
});
