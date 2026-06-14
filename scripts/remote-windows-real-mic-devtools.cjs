const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "HUAWEI@192.168.1.117",
  remoteHost: "0.0.0.0",
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
    "  UST_REMOTE_REAL_MIC_REMOTE_HOST     Default: 0.0.0.0",
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
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion"
  ];
  if (config.secureOrigins.length) {
    args.push(`--unsafely-treat-insecure-origin-as-secure=${config.secureOrigins.join(",")}`);
  }
  if (config.fakeUiForMediaStream) args.push("--use-fake-ui-for-media-stream");
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
$logPath = Join-Path $env:TEMP ($tag + "-start.log")
function Write-Stage {
  param([string]$Name)
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ((Get-Date).ToUniversalTime().ToString("o") + " " + $Name)
}
Write-Stage "start"
$debugHost = if ($remoteHost -eq "0.0.0.0") { "127.0.0.1" } else { $remoteHost }
$debugBaseUrl = "http://" + $debugHost + ":" + $remotePort
$debugUrl = $debugBaseUrl + "/json/version"
$targetsUrl = $debugBaseUrl + "/json/list"
$paths = @(
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe"
)
$edge = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "msedge.exe not found" }
Write-Stage "edge-found"
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "msedge.exe" -and
    ($_.CommandLine -like "*--remote-debugging-port=$remotePort*" -or $_.CommandLine -like "*$tag*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Stage "old-processes-stopped"
Start-Sleep -Milliseconds 500
$removedProfiles = 0
$runTag = $tag + "-" + [guid]::NewGuid().ToString("N")
$userDataDir = Join-Path $env:TEMP $runTag
New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
Write-Stage "profile-created"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Write-Stage "task-unregistered"
$args = @(
  ${psArray(browserArgs(config))}
)
$args += "--user-data-dir=""$userDataDir"""
$args += "about:blank"
$argumentString = $args -join " "
$action = New-ScheduledTaskAction -Execute $edge -Argument $argumentString
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Write-Stage "task-registering"
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Write-Stage "task-registered"
Start-ScheduledTask -TaskName $taskName
Write-Stage "task-started"
$ready = $false
$browser = ""
$targetCount = 0
$stableChecks = 0
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -UseBasicParsing $debugUrl -TimeoutSec 2
    $targetsResponse = Invoke-WebRequest -UseBasicParsing $targetsUrl -TimeoutSec 2
    $targets = @()
    try { $targets = @(ConvertFrom-Json $targetsResponse.Content) } catch {}
    $targetCount = @($targets | Where-Object { $_.type -eq "page" }).Count
    if ($response.StatusCode -eq 200 -and $targetsResponse.StatusCode -eq 200 -and $targetCount -ge 1) {
      $stableChecks += 1
      try { $browser = (ConvertFrom-Json $response.Content).Browser } catch {}
      if ($stableChecks -ge 3) {
        $ready = $true
        Write-Stage "debug-ready"
        break
      }
    } else {
      $stableChecks = 0
    }
  } catch {
    $stableChecks = 0
  }
} while ((Get-Date) -lt $deadline)
$postReadyDeadline = (Get-Date).AddSeconds(5)
while ($ready -and (Get-Date) -lt $postReadyDeadline) {
  Start-Sleep -Milliseconds 500
  try {
    $targetsResponse = Invoke-WebRequest -UseBasicParsing $targetsUrl -TimeoutSec 2
    $targets = @()
    try { $targets = @(ConvertFrom-Json $targetsResponse.Content) } catch {}
    $targetCount = @($targets | Where-Object { $_.type -eq "page" }).Count
    if ($targetCount -lt 1) {
      $ready = $false
      Write-Stage "post-ready-target-missing"
      break
    }
  } catch {
    $ready = $false
    Write-Stage "post-ready-check-failed"
    break
  }
}
Write-Stage "collecting-processes"
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "msedge.exe" -and
  $_.CommandLine -like "*$tag*"
})
Write-Stage "result-writing"
$result = [ordered]@{
  ok = $ready
  action = "start"
  taskName = $taskName
  remoteDebugUrl = $debugUrl
  processCount = $processes.Count
  browser = $browser
  targetCount = $targetCount
  stableChecks = $stableChecks
  removedProfiles = $removedProfiles
  userDataDir = $userDataDir
  logPath = $logPath
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
$debugHost = if ($remoteHost -eq "0.0.0.0") { "127.0.0.1" } else { $remoteHost }
$debugBaseUrl = "http://" + $debugHost + ":" + $remotePort
$debugUrl = $debugBaseUrl + "/json/version"
$targetsUrl = $debugBaseUrl + "/json/list"
$ok = $false
$browser = ""
$targetCount = 0
$errorText = ""
try {
  $response = Invoke-WebRequest -UseBasicParsing $debugUrl -TimeoutSec 3
  $targetsResponse = Invoke-WebRequest -UseBasicParsing $targetsUrl -TimeoutSec 3
  try {
    $targets = @(ConvertFrom-Json $targetsResponse.Content)
    $targetCount = @($targets | Where-Object { $_.type -eq "page" }).Count
  } catch {}
  $ok = $response.StatusCode -eq 200 -and $targetsResponse.StatusCode -eq 200 -and $targetCount -ge 1
  try { $browser = (ConvertFrom-Json $response.Content).Browser } catch {}
} catch {
  $errorText = $_.Exception.Message
}
$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "msedge.exe" -and
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
  targetCount = $targetCount
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
function Remove-TaggedTempProfiles {
  param([string]$Tag)
  $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
  if (-not $tempRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $tempRoot = $tempRoot + [System.IO.Path]::DirectorySeparatorChar
  }
  Get-ChildItem -LiteralPath $tempRoot -Directory -Filter ($Tag + "-*") -ErrorAction SilentlyContinue |
    ForEach-Object {
      $fullPath = [System.IO.Path]::GetFullPath($_.FullName)
      if ($fullPath.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $_.Name -like ($Tag + "-*")) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $fullPath)) { $script:removedProfiles += 1 }
      }
    }
}
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "msedge.exe" -and
    ($_.CommandLine -like "*--remote-debugging-port=$remotePort*" -or $_.CommandLine -like "*$tag*")
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Start-Sleep -Seconds 1
$script:removedProfiles = 0
Remove-TaggedTempProfiles -Tag $tag
$remaining = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "msedge.exe" -and
  ($_.CommandLine -like "*--remote-debugging-port=$remotePort*" -or $_.CommandLine -like "*$tag*")
}).Count
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
[ordered]@{
  ok = ($remaining -eq 0 -and -not $task)
  action = "stop"
  remaining = $remaining
  removedProfiles = $script:removedProfiles
  taskExists = [bool]$task
} | ConvertTo-Json -Depth 4
if ($remaining -ne 0 -or $task) { exit 1 }
`.trim();
}

function remotePowerShellInline(config, script, timeout = 15000) {
  return spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      config.sshTarget,
      "powershell",
      "-NoProfile",
      "-EncodedCommand",
      encodePowerShell(script)
    ],
    {
      encoding: "utf8",
      timeout,
      windowsHide: true
    }
  );
}

function remoteTempDir(config) {
  const result = remotePowerShellInline(
    config,
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($env:TEMP)",
    15000
  );
  if (result.status !== 0 || result.error) {
    return {
      ok: false,
      error: result.error,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  }
  const value = String(result.stdout || "").trim();
  return value ? { ok: true, value } : { ok: false, error: new Error("remote TEMP is empty"), stdout: "", stderr: "" };
}

function scpTarget(config, remotePath) {
  return `${config.sshTarget}:${remotePath.replace(/\\/g, "/")}`;
}

function runRemotePowerShell(config, script) {
  const scriptName = `ust-real-mic-${process.pid}-${Date.now()}.ps1`;
  const localPath = path.join(os.tmpdir(), scriptName);
  const temp = remoteTempDir(config);
  if (!temp.ok) {
    return {
      status: temp.status || 1,
      signal: temp.signal || null,
      error: temp.error,
      stdout: temp.stdout || "",
      stderr: temp.stderr || "failed to resolve remote TEMP"
    };
  }
  const remotePath = `${temp.value.replace(/[\\\/]+$/, "")}\\${scriptName}`;
  fs.writeFileSync(localPath, script, "utf8");
  const scp = spawnSync(
    "scp",
    ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", localPath, scpTarget(config, remotePath)],
    {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true
    }
  );
  fs.rmSync(localPath, { force: true });
  if (scp.status !== 0 || scp.error) {
    return {
      status: scp.status || 1,
      signal: scp.signal || null,
      error: scp.error,
      stdout: scp.stdout || "",
      stderr: scp.stderr || "failed to copy remote PowerShell script"
    };
  }
  const escapedRemotePath = remotePath.replace(/'/g, "''");
  const runner = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$path = '${escapedRemotePath}'`,
    "$code = 1",
    "try {",
    "  & powershell -NoProfile -ExecutionPolicy Bypass -File $path",
    "  $code = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }",
    "} finally {",
    "  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue",
    "}",
    "exit $code"
  ].join("\n");
  return remotePowerShellInline(config, runner, 90000);
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
  const versionUrl = `${config.lanDebugUrl}/json/version`;
  const targetsUrl = `${config.lanDebugUrl}/json/list`;
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < 10000) {
    try {
      const version = await fetchJson(versionUrl, 2500);
      const targets = await fetchJson(targetsUrl, 2500);
      const targetCount = (Array.isArray(targets) ? targets : [targets]).filter((target) => target?.type === "page").length;
      if (targetCount >= 1) {
        return { ok: true, url: versionUrl, browser: version.Browser || "", targetCount };
      }
      lastError = `no page target at ${targetsUrl}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, url: versionUrl, error: lastError || "timeout" };
}

function printRemoteResult(result) {
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`remote command terminated by signal ${result.signal}`);
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
