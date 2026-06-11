const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "HUAWEI@192.168.1.117",
  webUrl: "http://192.168.1.118:5173/",
  signalingHealthUrl: "http://192.168.1.118:7077/health",
  devToolsUrl: "http://127.0.0.1:9222/json/version",
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

function configFromEnv() {
  return {
    sshTarget: env("UST_REMOTE_SSH_TARGET", DEFAULTS.sshTarget),
    webUrl: env("UST_REMOTE_WINDOWS_WEB_URL", DEFAULTS.webUrl),
    signalingHealthUrl: env("UST_REMOTE_WINDOWS_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    devToolsUrl: env("UST_REMOTE_WINDOWS_DEVTOOLS_URL", DEFAULTS.devToolsUrl),
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
    "  UST_REMOTE_WINDOWS_SSH_TIMEOUT_MS         Default: 20000"
  ].join("\n");
}

function remoteProbeScript(config) {
  return `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$webUrl = ${psQuote(config.webUrl)}
$healthUrl = ${psQuote(config.signalingHealthUrl)}
$devToolsUrl = ${psQuote(config.devToolsUrl)}

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
$edgeDebugProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*--remote-debugging-port=*" } |
  Select-Object ProcessId, CommandLine)

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
    edgeDebugProcesses = $edgeDebugProcesses
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
  const warnings = [];
  if (!remote?.checks?.runtime?.node) warnings.push("node_not_found_on_remote_windows");
  if (!remote?.checks?.devTools?.ok) warnings.push("devtools_not_running_before_probe");

  const ok = ssh.ok && Boolean(remote?.ok);
  console.log(
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  );

  if (!ok) process.exitCode = 1;
}

main(process.argv.slice(2));
