const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "HUAWEI@192.168.1.117",
  remoteHost: "127.0.0.1",
  remotePort: "9222",
  lanDebugUrl: "http://192.168.1.117:9222",
  taskName: "UST Edge Real Mic DevTools",
  userDataTag: "ust-edge-real-mic-interactive",
  secureOrigins: "http://192.168.1.118:5173",
  fakeUiForMediaStream: "true",
  requireLanDebug: "true"
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
  return {
    sshTarget: env("UST_REMOTE_REAL_MIC_SSH_TARGET", DEFAULTS.sshTarget),
    remoteHost: env("UST_REMOTE_REAL_MIC_REMOTE_HOST", DEFAULTS.remoteHost),
    remotePort: env("UST_REMOTE_REAL_MIC_REMOTE_PORT", DEFAULTS.remotePort),
    lanDebugUrl: env("UST_REMOTE_REAL_MIC_DEBUG_URL", DEFAULTS.lanDebugUrl).replace(/\/$/, ""),
    taskName: env("UST_REMOTE_REAL_MIC_TASK_NAME", DEFAULTS.taskName),
    userDataTag: env("UST_REMOTE_REAL_MIC_USER_DATA_TAG", DEFAULTS.userDataTag),
    secureOrigins: envList("UST_REMOTE_REAL_MIC_SECURE_ORIGINS", DEFAULTS.secureOrigins),
    fakeUiForMediaStream: envFlag("UST_REMOTE_REAL_MIC_FAKE_UI_FOR_MEDIA_STREAM", DEFAULTS.fakeUiForMediaStream),
    requireLanDebug: envFlag("UST_REMOTE_REAL_MIC_REQUIRE_LAN_DEBUG", DEFAULTS.requireLanDebug)
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-windows-real-mic-devtools.cjs start",
    "  node scripts/remote-windows-real-mic-devtools.cjs check",
    "  node scripts/remote-windows-real-mic-devtools.cjs stop",
    "  node scripts/remote-windows-real-mic-devtools.cjs run -- <command> [args...]",
    "",
    "Environment:",
    "  UST_REMOTE_REAL_MIC_SSH_TARGET      Default: HUAWEI@192.168.1.117",
    "  UST_REMOTE_REAL_MIC_REMOTE_HOST     Default: 127.0.0.1",
    "  UST_REMOTE_REAL_MIC_REMOTE_PORT     Default: 9222",
    "  UST_REMOTE_REAL_MIC_DEBUG_URL       Default: http://192.168.1.117:9222",
    "  UST_REMOTE_REAL_MIC_TASK_NAME       Default: UST Edge Real Mic DevTools",
    "  UST_REMOTE_REAL_MIC_USER_DATA_TAG   Default: ust-edge-real-mic-interactive",
    "  UST_REMOTE_REAL_MIC_SECURE_ORIGINS  Default: http://192.168.1.118:5173",
    "  UST_REMOTE_REAL_MIC_FAKE_UI_FOR_MEDIA_STREAM Default: true",
    "  UST_REMOTE_REAL_MIC_REQUIRE_LAN_DEBUG Default: true"
  ].join("\n");
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function psArray(values) {
  return values.map((value) => psSingleQuoted(value)).join(",\n  ");
}

function browserArgs(config) {
  const args = [
    `--remote-debugging-port=${config.remotePort}`,
    `--remote-debugging-address=${config.remoteHost}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check"
  ];
  if (config.secureOrigins.length) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${config.secureOrigins.join(",")}`);
  }
  if (config.fakeUiForMediaStream) args.push("--use-fake-ui-for-media-stream");
  args.push("about:blank");
  return args;
}

function remoteStartScript(config) {
  return `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$taskName = ${psSingleQuoted(config.taskName)}
$tag = ${psSingleQuoted(config.userDataTag)}
$remoteHost = ${psSingleQuoted(config.remoteHost)}
$remotePort = ${psSingleQuoted(config.remotePort)}
$debugUrl = "http://" + $remoteHost + ":" + $remotePort + "/json/version"
$paths = @(
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe"
)
$edge = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "msedge.exe not found" }
$userDataDir = Join-Path $env:TEMP $tag
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "msedge.exe" -and
    $_.CommandLine -like "*--remote-debugging-port=$remotePort*" -and
    $_.CommandLine -like "*$tag*"
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
$args = @(
  ${psArray(browserArgs(config))}
)
$args += "--user-data-dir=""$userDataDir"""
$argumentString = $args -join " "
$action = New-ScheduledTaskAction -Execute $edge -Argument $argumentString
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$ready = $false
$browser = ""
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing $debugUrl -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      try { $browser = (ConvertFrom-Json $response.Content).Browser } catch {}
      break
    }
  } catch {}
} while ((Get-Date) -lt $deadline)
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "msedge.exe" -and
  $_.CommandLine -like "*--remote-debugging-port=$remotePort*" -and
  $_.CommandLine -like "*$tag*"
})
$result = [ordered]@{
  ok = $ready
  action = "start"
  taskName = $taskName
  remoteDebugUrl = $debugUrl
  processCount = $processes.Count
  browser = $browser
  user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
}
$result | ConvertTo-Json -Depth 4
if (-not $ready) { exit 1 }
`.trim();
}

function remoteCheckScript(config) {
  return `
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$taskName = ${psSingleQuoted(config.taskName)}
$tag = ${psSingleQuoted(config.userDataTag)}
$remoteHost = ${psSingleQuoted(config.remoteHost)}
$remotePort = ${psSingleQuoted(config.remotePort)}
$debugUrl = "http://" + $remoteHost + ":" + $remotePort + "/json/version"
$ok = $false
$browser = ""
$errorText = ""
try {
  $response = Invoke-WebRequest -UseBasicParsing $debugUrl -TimeoutSec 3
  $ok = $response.StatusCode -eq 200
  try { $browser = (ConvertFrom-Json $response.Content).Browser } catch {}
} catch {
  $errorText = $_.Exception.Message
}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "msedge.exe" -and
  $_.CommandLine -like "*--remote-debugging-port=$remotePort*" -and
  $_.CommandLine -like "*$tag*"
})
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
[ordered]@{
  ok = $ok
  action = "check"
  taskExists = [bool]$task
  taskState = if ($task) { "$($task.State)" } else { "" }
  remoteDebugUrl = $debugUrl
  processCount = $processes.Count
  browser = $browser
  error = $errorText
} | ConvertTo-Json -Depth 4
if (-not $ok) { exit 1 }
`.trim();
}

function remoteStopScript(config) {
  return `
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
$taskName = ${psSingleQuoted(config.taskName)}
$tag = ${psSingleQuoted(config.userDataTag)}
$remotePort = ${psSingleQuoted(config.remotePort)}
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "msedge.exe" -and
    $_.CommandLine -like "*--remote-debugging-port=$remotePort*" -and
    $_.CommandLine -like "*$tag*"
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Seconds 1
$remaining = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "msedge.exe" -and
  $_.CommandLine -like "*--remote-debugging-port=$remotePort*" -and
  $_.CommandLine -like "*$tag*"
}).Count
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
[ordered]@{
  ok = ($remaining -eq 0 -and -not $task)
  action = "stop"
  remaining = $remaining
  taskExists = [bool]$task
} | ConvertTo-Json -Depth 4
if ($remaining -ne 0 -or $task) { exit 1 }
`.trim();
}

function runRemotePowerShell(config, script) {
  const encoded = encodePowerShell(script);
  return spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", config.sshTarget, "powershell", "-NoProfile", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      timeout: 45000,
      windowsHide: true
    }
  );
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

async function waitForLanDebug(config) {
  const url = `${config.lanDebugUrl}/json/version`;
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < 10000) {
    try {
      const version = await fetchJson(url, 2500);
      return { ok: true, url, browser: version.Browser || "" };
    } catch (error) {
      lastError = error.message;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return { ok: false, url, error: lastError || "timeout" };
}

function printRemoteResult(result) {
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
}

async function start(config) {
  const result = runRemotePowerShell(config, remoteStartScript(config));
  printRemoteResult(result);
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return false;
  }
  if (!config.requireLanDebug) return true;
  const lan = await waitForLanDebug(config);
  console.log(JSON.stringify({ ok: lan.ok, action: "lan-check", ...lan }, null, 2));
  if (!lan.ok) process.exitCode = 1;
  return lan.ok;
}

async function check(config) {
  const result = runRemotePowerShell(config, remoteCheckScript(config));
  printRemoteResult(result);
  const lan = await waitForLanDebug(config);
  console.log(JSON.stringify({ ok: lan.ok, action: "lan-check", ...lan }, null, 2));
  if (result.status !== 0 || !lan.ok) process.exitCode = result.status || 1;
}

function stop(config) {
  const result = runRemotePowerShell(config, remoteStopScript(config));
  printRemoteResult(result);
  if (result.status !== 0) process.exitCode = result.status || 1;
  return result.status || 0;
}

function runCommand(config, commandArgs) {
  if (!commandArgs.length) throw new Error("run requires a command after --");
  let [command, ...args] = commandArgs;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", ...commandArgs];
  }
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      UST_REMOTE_DEBUG_URL: config.lanDebugUrl
    },
    stdio: "inherit",
    windowsHide: false
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? (result.signal ? 1 : 0);
}

function parse(argv) {
  const separatorIndex = argv.indexOf("--");
  const commandArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
  const ownArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  return { action: ownArgs[0] || "help", commandArgs };
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
    const started = await start(config);
    const exitCode = started ? runCommand(config, commandArgs) : 1;
    const stopExitCode = stop(config);
    process.exitCode = exitCode || stopExitCode;
    return;
  }
  throw new Error(`unknown action: ${action}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Remote Windows real mic DevTools failed: ${error.message}`);
  process.exit(1);
});
