const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "HUAWEI@192.168.1.117",
  webUrl: "http://192.168.1.118:5173/",
  signalingHealthUrl: "http://192.168.1.118:7077/health",
  devToolsUrl: "http://127.0.0.1:9222/json/version",
  lanTargets: "kylin137=192.168.1.137:22",
  lanTargetTimeoutMs: "1500",
  expectedLanSourcePrefix: "192.168.1.",
  artifactDir: path.join("test-results", "remote-windows-probe"),
  sshTimeoutMs: "20000"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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

function parseLanTargets(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [nameOrHost, address] = item.includes("=") ? item.split(/=(.*)/s).filter(Boolean) : ["", item];
      const hostPort = String(address || "").trim();
      const separator = hostPort.lastIndexOf(":");
      if (separator <= 0 || separator === hostPort.length - 1) {
        throw new Error(`invalid LAN target: ${item}`);
      }
      const host = hostPort.slice(0, separator).trim();
      const port = Number(hostPort.slice(separator + 1));
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid LAN target: ${item}`);
      }
      return {
        name: String(nameOrHost || `${host}:${port}`).trim(),
        host,
        port
      };
    });
}

function probeWarnings(remote) {
  const warnings = [];
  if (!remote?.checks?.runtime?.node) warnings.push("node_not_found_on_remote_windows");
  if (!remote?.checks?.devTools?.ok) warnings.push("devtools_not_running_before_probe");
  for (const target of remote?.checks?.lanTargets || []) {
    const targetName = target.name || target.host || "unknown";
    if (!target.ok) {
      warnings.push(`lan_target_${targetName}_unreachable`);
    } else if (target.onExpectedLan === false) {
      warnings.push(`lan_target_${targetName}_non_lan_route`);
    }
  }
  return warnings;
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
    sshTarget: env("UST_REMOTE_SSH_TARGET", DEFAULTS.sshTarget),
    webUrl: env("UST_REMOTE_WINDOWS_WEB_URL", DEFAULTS.webUrl),
    signalingHealthUrl: env("UST_REMOTE_WINDOWS_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    devToolsUrl: env("UST_REMOTE_WINDOWS_DEVTOOLS_URL", DEFAULTS.devToolsUrl),
    lanTargets: parseLanTargets(env("UST_REMOTE_WINDOWS_LAN_TARGETS", DEFAULTS.lanTargets)),
    lanTargetTimeoutMs: env("UST_REMOTE_WINDOWS_LAN_TARGET_TIMEOUT_MS", DEFAULTS.lanTargetTimeoutMs),
    expectedLanSourcePrefix: env("UST_REMOTE_WINDOWS_EXPECTED_LAN_SOURCE_PREFIX", DEFAULTS.expectedLanSourcePrefix),
    artifactDir: env("UST_REMOTE_WINDOWS_PROBE_ARTIFACT_DIR", DEFAULTS.artifactDir),
    sshTimeoutMs: env("UST_REMOTE_WINDOWS_SSH_TIMEOUT_MS", DEFAULTS.sshTimeoutMs)
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-windows-probe.cjs",
    "",
    "Environment:",
    "  UST_REMOTE_SSH_TARGET                     Default: HUAWEI@192.168.1.117",
    "  UST_REMOTE_WINDOWS_WEB_URL                Default: http://192.168.1.118:5173/",
    "  UST_REMOTE_WINDOWS_SIGNALING_HEALTH_URL   Default: http://192.168.1.118:7077/health",
    "  UST_REMOTE_WINDOWS_DEVTOOLS_URL           Default: http://127.0.0.1:9222/json/version",
    "  UST_REMOTE_WINDOWS_LAN_TARGETS            Default: kylin137=192.168.1.137:22",
    "  UST_REMOTE_WINDOWS_LAN_TARGET_TIMEOUT_MS  Default: 1500",
    "  UST_REMOTE_WINDOWS_EXPECTED_LAN_SOURCE_PREFIX",
    "                                            Default: 192.168.1.",
    "  UST_REMOTE_WINDOWS_PROBE_ARTIFACT_DIR     Default: test-results/remote-windows-probe",
    "  UST_REMOTE_WINDOWS_SSH_TIMEOUT_MS         Default: 20000"
  ].join("\n");
}

function remoteProbeScript(config) {
  const lanTargetsJson = JSON.stringify(config.lanTargets);
  return `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$webUrl = ${psQuote(config.webUrl)}
$healthUrl = ${psQuote(config.signalingHealthUrl)}
$devToolsUrl = ${psQuote(config.devToolsUrl)}
$lanTargetsJson = ${psQuote(lanTargetsJson)}
$lanTargetTimeoutMs = [int]${Number(config.lanTargetTimeoutMs) || Number(DEFAULTS.lanTargetTimeoutMs)}
$expectedLanSourcePrefix = ${psQuote(config.expectedLanSourcePrefix)}

function Test-HttpStatus($Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
    return [ordered]@{
      ok = ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
      statusCode = [int]$response.StatusCode
      error = ""
    }
  } catch {
    return [ordered]@{
      ok = $false
      statusCode = 0
      error = $_.Exception.Message
    }
  }
}

function Get-JsonHttp($Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
    $json = $response.Content | ConvertFrom-Json
    return [ordered]@{
      ok = [bool]$json.ok
      value = $json
      error = ""
    }
  } catch {
    return [ordered]@{
      ok = $false
      value = $null
      error = $_.Exception.Message
    }
  }
}

function Get-CommandPath($Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return [string]$command.Source }
  return ""
}

function Get-CommandVersion($Name, $CommandArgs) {
  try {
    $output = & $Name @CommandArgs 2>$null | Select-Object -First 1
    if ($output) { return [string]$output }
  } catch {}
  return ""
}

function Get-RouteHint($HostName) {
  try {
    $route = Find-NetRoute -RemoteIPAddress $HostName -ErrorAction Stop | Select-Object -First 1
    if ($route) {
      return [ordered]@{
        interfaceAlias = [string]$route.InterfaceAlias
        interfaceIndex = if ($null -ne $route.InterfaceIndex) { [int]$route.InterfaceIndex } else { $null }
        sourceAddress = [string]$route.IPAddress
        prefixLength = if ($null -ne $route.PrefixLength) { [int]$route.PrefixLength } else { $null }
      }
    }
  } catch {}
  return [ordered]@{
    interfaceAlias = ""
    interfaceIndex = $null
    sourceAddress = ""
    prefixLength = $null
  }
}

function Test-TcpTarget($Target) {
  $client = New-Object System.Net.Sockets.TcpClient
  $started = Get-Date
  $ok = $false
  $errorText = ""
  try {
    $async = $client.BeginConnect([string]$Target.host, [int]$Target.port, $null, $null)
    $completed = $async.AsyncWaitHandle.WaitOne($lanTargetTimeoutMs, $false)
    if ($completed) {
      try {
        $client.EndConnect($async)
        $ok = $true
      } catch {
        $errorText = $_.Exception.Message
      }
    } else {
      $errorText = "timeout"
    }
  } catch {
    $errorText = $_.Exception.Message
  } finally {
    try { $client.Close() } catch {}
  }
  $finished = Get-Date
  $route = Get-RouteHint ([string]$Target.host)
  $onExpectedLan = $true
  if ($expectedLanSourcePrefix) {
    $onExpectedLan = ([string]$route.sourceAddress).StartsWith($expectedLanSourcePrefix)
  }
  return [ordered]@{
    name = [string]$Target.name
    host = [string]$Target.host
    port = [int]$Target.port
    ok = [bool]$ok
    error = $errorText
    timeoutMs = [int]$lanTargetTimeoutMs
    durationMs = [int]([math]::Round(($finished - $started).TotalMilliseconds))
    expectedLanSourcePrefix = $expectedLanSourcePrefix
    onExpectedLan = [bool]$onExpectedLan
    route = $route
  }
}

$edgePaths = @(
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe"
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
$edgeVersion = ""
if ($edge) {
  try { $edgeVersion = [string](Get-Item $edge).VersionInfo.ProductVersion } catch {}
}

$os = Get-CimInstance Win32_OperatingSystem
$ipv4 = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object InterfaceAlias, IPAddress, PrefixLength)
$devTools = Test-HttpStatus $devToolsUrl
$web = Test-HttpStatus $webUrl
$health = Get-JsonHttp $healthUrl
$lanTargets = @()
try {
  $parsedLanTargets = $lanTargetsJson | ConvertFrom-Json
  if ($parsedLanTargets) { $lanTargets = @($parsedLanTargets) }
} catch {}
$lanTargetResults = @($lanTargets | ForEach-Object { Test-TcpTarget $_ })
$edgeDebugProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*--remote-debugging-port=*" } |
  Select-Object ProcessId, CommandLine)
$cpuLoad = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue |
  Measure-Object -Property LoadPercentage -Average).Average
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" -ErrorAction SilentlyContinue |
  Select-Object DeviceID,
    @{Name="SizeGiB"; Expression={ if ($_.Size) { [math]::Round($_.Size / 1GB, 2) } else { 0 } }},
    @{Name="FreeGiB"; Expression={ if ($_.FreeSpace) { [math]::Round($_.FreeSpace / 1GB, 2) } else { 0 } }},
    @{Name="FreePercent"; Expression={ if ($_.Size) { [math]::Round(($_.FreeSpace / $_.Size) * 100, 1) } else { 0 } }})
$resourceProcesses = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { @("msedge", "node", "electron") -contains $_.ProcessName } |
  Sort-Object WorkingSet64 -Descending |
  Select-Object -First 12 Id, ProcessName,
    @{Name="WorkingSetMiB"; Expression={ [math]::Round($_.WorkingSet64 / 1MB, 1) }},
    @{Name="CpuSeconds"; Expression={ if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 } }})

$result = [ordered]@{
  ok = ($web.ok -and $health.ok -and [bool]$edge)
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  os = [ordered]@{
    caption = [string]$os.Caption
    version = [string]$os.Version
    buildNumber = [string]$os.BuildNumber
    architecture = [string]$os.OSArchitecture
  }
  checks = [ordered]@{
    web = $web
    signalingHealth = $health
    browser = [ordered]@{
      ok = [bool]$edge
      path = [string]$edge
      version = $edgeVersion
    }
    devTools = [ordered]@{
      ok = [bool]$devTools.ok
      url = $devToolsUrl
      statusCode = $devTools.statusCode
      error = $devTools.error
    }
    runtime = [ordered]@{
      node = Get-CommandPath "node"
      nodeVersion = Get-CommandVersion "node" @("-v")
      npm = Get-CommandPath "npm"
      npmVersion = Get-CommandVersion "npm" @("-v")
      powershell = Get-CommandPath "powershell"
      powershellVersion = [string]$PSVersionTable.PSVersion
      curl = Get-CommandPath "curl.exe"
      curlVersion = Get-CommandVersion "curl.exe" @("--version")
    }
    network = $ipv4
    lanTargets = $lanTargetResults
    edgeDebugProcesses = $edgeDebugProcesses
    resources = [ordered]@{
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
      processes = $resourceProcesses
    }
  }
}

$result | ConvertTo-Json -Depth 8
`.trim();
}

function runSsh(config) {
  const script = remoteProbeScript(config);
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      config.sshTarget,
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "-"
    ],
    {
      encoding: "utf8",
      input: script,
      timeout: Number(config.sshTimeoutMs),
      windowsHide: true
    }
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || ""
  };
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const config = configFromEnv();
  const ssh = runSsh(config);
  const remote = parseJsonFromOutput(ssh.stdout);
  const warnings = probeWarnings(remote);

  const ok = ssh.ok && Boolean(remote?.ok);
  const payload = {
    ok,
    config,
    checks: {
      ssh: {
        ok: ssh.ok,
        status: ssh.status,
        stderr: ssh.stderr,
        error: ssh.error
      },
      remote: remote || {
        ok: false,
        parseError: "remote probe did not return JSON",
        stdout: ssh.stdout
      }
    },
    warnings
  };
  writeProbeArtifact(payload, config.artifactDir);
  console.log(JSON.stringify(payload, null, 2));

  if (!ok) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseLanTargets,
  probeWarnings
};
