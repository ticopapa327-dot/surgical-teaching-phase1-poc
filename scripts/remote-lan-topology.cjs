const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  artifactDir: path.join("test-results", "remote-lan-topology"),
  localName: "or118",
  localAddress: "192.168.1.118",
  remoteWindowsName: "teach117",
  remoteWindowsSshTarget: "HUAWEI@192.168.1.117",
  remoteWindowsAddress: "192.168.1.117",
  targetName: "kylin137",
  targetHost: "192.168.1.137",
  targetPort: "22",
  timeoutMs: "1500",
  sshTimeoutMs: "90000",
  disallowedRouteInterfaces: "CMYNetwork"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
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

function parseRouteInterfaceList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function routeAliasIsDisallowed(interfaceAlias, disallowedRouteInterfaces = DEFAULTS.disallowedRouteInterfaces) {
  const normalized = String(interfaceAlias || "").trim().toLowerCase();
  return parseRouteInterfaceList(disallowedRouteInterfaces).some(
    (item) => item.toLowerCase() === normalized
  );
}

function bootstrapEncodedCommand() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$scriptText = [Console]::In.ReadToEnd()",
    "$scriptPath = Join-Path $env:TEMP ('ust-lan-topology-' + [guid]::NewGuid().ToString('N') + '.ps1')",
    "Set-Content -LiteralPath $scriptPath -Value $scriptText -Encoding UTF8",
    "try { & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath } finally { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }"
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

function topologyWarnings(probe, role, disallowedRouteInterfaces = DEFAULTS.disallowedRouteInterfaces) {
  const warnings = [];
  const targetName = probe?.target?.name || probe?.target?.host || "target";
  const expectedSource = String(probe?.localAddress || "");
  const routeSource = String(probe?.routeHint?.sourceAddress || "");
  const routeInterface = String(probe?.routeHint?.interfaceAlias || "");
  if (routeAliasIsDisallowed(routeInterface, disallowedRouteInterfaces)) {
    warnings.push(`${role}_${targetName}_disallowed_route_interface`);
  }
  if (routeSource && expectedSource && routeSource !== expectedSource) {
    warnings.push(`${role}_${targetName}_route_source_not_expected_lan`);
  }
  if (probe?.tcp?.bound?.ok !== true) {
    warnings.push(`${role}_${targetName}_bound_tcp_unreachable`);
  }
  const neighbor = Array.isArray(probe?.neighbors)
    ? probe.neighbors.find((item) => String(item.ipAddress || item.IPAddress || "") === String(probe?.target?.host || ""))
    : null;
  const mac = String(neighbor?.linkLayerAddress || neighbor?.LinkLayerAddress || "");
  if (!neighbor || !mac || mac === "00-00-00-00-00-00") {
    warnings.push(`${role}_${targetName}_neighbor_unresolved`);
  }
  return warnings;
}

function findNeighbor(probe, address) {
  return Array.isArray(probe?.neighbors)
    ? probe.neighbors.find((item) => String(item.ipAddress || item.IPAddress || "") === String(address || ""))
    : null;
}

function hasResolvedNeighbor(neighbor) {
  const mac = neighborMac(neighbor);
  return Boolean(neighbor && mac && mac !== "00-00-00-00-00-00");
}

function neighborMac(neighbor) {
  return String(neighbor?.linkLayerAddress || neighbor?.LinkLayerAddress || "");
}

function summarizeProbe(probe, peerAddress, disallowedRouteInterfaces = DEFAULTS.disallowedRouteInterfaces) {
  const targetHost = probe?.target?.host || "";
  const routeSource = String(probe?.routeHint?.sourceAddress || "");
  const localAddress = String(probe?.localAddress || "");
  const targetNeighbor = findNeighbor(probe, targetHost);
  const peerNeighbor = findNeighbor(probe, peerAddress);
  return {
    available: Boolean(probe),
    role: probe?.role || "",
    localAddress,
    routeDestination: probe?.routeHint?.destinationPrefix || "",
    routeInterface: probe?.routeHint?.interfaceAlias || "",
    routeInterfaceDisallowed: routeAliasIsDisallowed(
      probe?.routeHint?.interfaceAlias || "",
      disallowedRouteInterfaces
    ),
    routeSource,
    routeSourceExpectedLan: Boolean(routeSource && localAddress && routeSource === localAddress),
    defaultTcpOk: probe?.tcp?.default?.ok ?? null,
    boundTcpOk: probe?.tcp?.bound?.ok ?? null,
    targetNeighborResolved: hasResolvedNeighbor(targetNeighbor),
    targetNeighborMac: neighborMac(targetNeighbor),
    peerNeighborResolved: hasResolvedNeighbor(peerNeighbor),
    peerNeighborMac: neighborMac(peerNeighbor)
  };
}

function diagnoseTopology({ config, local, remoteWindows, warnings }) {
  const localSummary = summarizeProbe(local.probe, config.remoteWindowsAddress, config.disallowedRouteInterfaces);
  const remoteSummary = summarizeProbe(
    remoteWindows.probe,
    config.localAddress,
    config.disallowedRouteInterfaces
  );
  const summaries = [localSummary, remoteSummary].filter((item) => item.available);
  const all = (predicate) => summaries.length > 0 && summaries.every(predicate);
  const any = (predicate) => summaries.some(predicate);
  const bothProbesOk = local.ok && remoteWindows.ok;
  const bothRouteHijacked = all((item) => item.routeSourceExpectedLan === false && Boolean(item.routeSource));
  const bothBoundUnreachable = all((item) => item.boundTcpOk === false);
  const bothTargetNeighborUnresolved = all((item) => item.targetNeighborResolved === false);
  const defaultRouteTcpWorks = any((item) => item.defaultTcpOk === true);
  const peerLanVisible = any((item) => item.peerNeighborResolved === true);

  let classification = "ok";
  if (!bothProbesOk) {
    classification = "partial_topology_evidence";
  } else if (bothRouteHijacked && bothBoundUnreachable && bothTargetNeighborUnresolved) {
    classification = "overlay_route_hijack_and_lan_target_unresolved";
  } else if (bothTargetNeighborUnresolved && bothBoundUnreachable) {
    classification = "lan_target_unresolved";
  } else if (bothRouteHijacked) {
    classification = "overlay_route_hijack";
  } else if (warnings.length) {
    classification = "topology_warning";
  }

  const blocking = classification !== "ok";
  const evidence = [];
  if (defaultRouteTcpWorks && bothBoundUnreachable) {
    evidence.push("default_route_tcp_works_but_lan_bound_tcp_fails");
  }
  if (bothRouteHijacked) evidence.push("route_source_is_not_expected_lan_on_all_available_probes");
  if (all((item) => item.routeInterfaceDisallowed === true)) {
    evidence.push("disallowed_route_interface_on_all_available_probes");
  }
  if (bothTargetNeighborUnresolved) evidence.push("target_neighbor_unresolved_on_all_available_probes");
  if (peerLanVisible) evidence.push("117_and_118_can_resolve_each_other_on_lan");

  const recommendations = blocking
    ? [
      `Confirm ${config.targetHost} is physically connected or associated to the same 192.168.1.0/24 LAN as ${config.localAddress} and ${config.remoteWindowsAddress}.`,
        "CMYNetwork is a disallowed validation interface for 118/117; do not count traffic through it as surgical teaching LAN evidence.",
        "Do not treat TCP success through CMYNetwork/Meta Tunnel as valid same-LAN surgical teaching evidence.",
        "Disable or deprioritize the overlay tunnel for validation only after confirming remote access will not be lost.",
        "Re-run npm run test:remote:lan:topology before strict cross-machine validation."
      ]
    : [];

  return {
    classification,
    blocking,
    targetHost: config.targetHost,
    targetPort: Number(config.targetPort),
    evidence,
    recommendations,
    local: localSummary,
    remoteWindows: remoteSummary
  };
}

function powershellProbeScript({ role, localAddress, targetName, targetHost, targetPort, timeoutMs, peerAddresses }) {
  const peerAddressList = (peerAddresses || []).map((item) => psQuote(item)).join(", ");
  return `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$role = ${psQuote(role)}
$localAddress = ${psQuote(localAddress)}
$targetName = ${psQuote(targetName)}
$targetHost = ${psQuote(targetHost)}
$targetPort = [int]${Number(targetPort) || Number(DEFAULTS.targetPort)}
$timeoutMs = [int]${Number(timeoutMs) || Number(DEFAULTS.timeoutMs)}
$peerAddresses = @(${peerAddressList})

function Get-RouteHint($HostName) {
  try {
    $matches = @(Find-NetRoute -RemoteIPAddress $HostName -ErrorAction Stop)
    $source = $matches | Where-Object { $_.IPAddress } | Select-Object -First 1
    $route = $matches | Where-Object { $_.DestinationPrefix } | Select-Object -First 1
    if ($source -or $route) {
      $interfaceAlias = if ($source -and $source.InterfaceAlias) { $source.InterfaceAlias } elseif ($route) { $route.InterfaceAlias } else { "" }
      $interfaceIndex = if ($source -and $null -ne $source.InterfaceIndex) { $source.InterfaceIndex } elseif ($route) { $route.InterfaceIndex } else { $null }
      return [ordered]@{
        interfaceAlias = [string]$interfaceAlias
        interfaceIndex = if ($null -ne $interfaceIndex) { [int]$interfaceIndex } else { $null }
        destinationPrefix = if ($route) { [string]$route.DestinationPrefix } else { "" }
        sourceAddress = if ($source) { [string]$source.IPAddress } else { "" }
        prefixLength = if ($source -and $null -ne $source.PrefixLength) { [int]$source.PrefixLength } else { $null }
        routeMetric = if ($null -ne $route.RouteMetric) { [int]$route.RouteMetric } else { $null }
        interfaceMetric = if ($null -ne $route.InterfaceMetric) { [int]$route.InterfaceMetric } else { $null }
        nextHop = if ($route) { [string]$route.NextHop } else { "" }
      }
    }
  } catch {}
  return [ordered]@{
    interfaceAlias = ""
    interfaceIndex = $null
    destinationPrefix = ""
    sourceAddress = ""
    prefixLength = $null
    routeMetric = $null
    interfaceMetric = $null
    nextHop = ""
  }
}

function Get-TargetRoutes($HostName) {
  try {
    return @(Find-NetRoute -RemoteIPAddress $HostName -ErrorAction Stop |
      Where-Object { $_.DestinationPrefix } |
      Select-Object @{Name="destinationPrefix"; Expression={[string]$_.DestinationPrefix}},
        @{Name="nextHop"; Expression={[string]$_.NextHop}},
        @{Name="interfaceAlias"; Expression={[string]$_.InterfaceAlias}},
        @{Name="interfaceIndex"; Expression={if ($null -ne $_.InterfaceIndex) { [int]$_.InterfaceIndex } else { $null }}},
        @{Name="routeMetric"; Expression={if ($null -ne $_.RouteMetric) { [int]$_.RouteMetric } else { $null }}},
        @{Name="interfaceMetric"; Expression={if ($null -ne $_.InterfaceMetric) { [int]$_.InterfaceMetric } else { $null }}},
        @{Name="sourceAddress"; Expression={[string]$_.IPAddress}},
        @{Name="sourcePrefixLength"; Expression={if ($null -ne $_.PrefixLength) { [int]$_.PrefixLength } else { $null }}})
  } catch {
    return @()
  }
}

function Test-TcpTarget($HostName, $Port, $LocalAddress) {
  $started = Get-Date
  $client = New-Object System.Net.Sockets.TcpClient ([System.Net.Sockets.AddressFamily]::InterNetwork)
  $ok = $false
  $errorText = ""
  try {
    if ($LocalAddress) {
      $ip = [System.Net.IPAddress]::Parse($LocalAddress)
      $client.Client.Bind((New-Object System.Net.IPEndPoint($ip, 0)))
    }
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    $completed = $async.AsyncWaitHandle.WaitOne($timeoutMs, $false)
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
  return [ordered]@{
    ok = [bool]$ok
    localAddress = [string]$LocalAddress
    error = $errorText
    durationMs = [int]([math]::Round(($finished - $started).TotalMilliseconds))
  }
}

function Invoke-PingText($Arguments) {
  try {
    return [string]((& ping @Arguments) -join [Environment]::NewLine)
  } catch {
    return [string]$_.Exception.Message
  }
}

$null = Invoke-PingText @("-n", "1", "-w", "1000", $targetHost)
if ($localAddress) { $null = Invoke-PingText @("-S", $localAddress, "-n", "1", "-w", "1000", $targetHost) }
$neighborTargets = @($targetHost) + @($peerAddresses)
$neighbors = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $neighborTargets -contains $_.IPAddress } |
  Select-Object @{Name="interfaceAlias"; Expression={[string]$_.InterfaceAlias}},
    @{Name="ipAddress"; Expression={[string]$_.IPAddress}},
    @{Name="linkLayerAddress"; Expression={[string]$_.LinkLayerAddress}},
    @{Name="state"; Expression={[int]$_.State}})
$routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    $_.DestinationPrefix -eq "0.0.0.0/0" -or
    $_.DestinationPrefix -eq "192.168.1.0/24" -or
    $_.DestinationPrefix -eq "198.19.0.0/30"
  } |
  Sort-Object RouteMetric, InterfaceMetric |
  Select-Object DestinationPrefix, NextHop, InterfaceAlias, InterfaceIndex, RouteMetric, InterfaceMetric)
$interfaces = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object InterfaceAlias, IPAddress, PrefixLength)
$targetRoutes = Get-TargetRoutes $targetHost

[ordered]@{
  ok = $true
  role = $role
  computerName = $env:COMPUTERNAME
  userName = $env:USERNAME
  localAddress = $localAddress
  target = [ordered]@{
    name = $targetName
    host = $targetHost
    port = $targetPort
  }
  routeHint = Get-RouteHint $targetHost
  targetRoutes = @($targetRoutes)
  interfaces = $interfaces
  routes = $routes
  tcp = [ordered]@{
    default = Test-TcpTarget $targetHost $targetPort ""
    bound = Test-TcpTarget $targetHost $targetPort $localAddress
  }
  ping = [ordered]@{
    default = Invoke-PingText @("-n", "2", "-w", "1000", $targetHost)
    bound = if ($localAddress) { Invoke-PingText @("-S", $localAddress, "-n", "2", "-w", "1000", $targetHost) } else { "" }
  }
  neighbors = $neighbors
  arp = [string]((arp -a $targetHost) -join [Environment]::NewLine)
} | ConvertTo-Json -Depth 8
`.trim();
}

function runLocalProbe(config) {
  const script = powershellProbeScript({
    role: config.localName,
    localAddress: config.localAddress,
    targetName: config.targetName,
    targetHost: config.targetHost,
    targetPort: config.targetPort,
    timeoutMs: config.timeoutMs,
    peerAddresses: [config.remoteWindowsAddress]
  });
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", bootstrapEncodedCommand()], {
    encoding: "utf8",
    input: script,
    timeout: Math.max(10000, Number(config.timeoutMs) * 8),
    windowsHide: true
  });
  const parsed = parseJsonFromOutput(result.stdout);
  return {
    ok: Boolean(parsed),
    status: result.status,
    probe: parsed,
    stderr: result.stderr || "",
    error: result.error?.message || (parsed ? "" : "local LAN topology probe did not return JSON")
  };
}

function runRemoteWindowsProbe(config) {
  const script = powershellProbeScript({
    role: config.remoteWindowsName,
    localAddress: config.remoteWindowsAddress,
    targetName: config.targetName,
    targetHost: config.targetHost,
    targetPort: config.targetPort,
    timeoutMs: config.timeoutMs,
    peerAddresses: [config.localAddress]
  });
  const localScriptPath = path.join(os.tmpdir(), `ust-lan-topology-${Date.now()}-${process.pid}.ps1`);
  const remoteScriptName = path.basename(localScriptPath);
  fs.writeFileSync(localScriptPath, script, "utf8");
  const scpResult = spawnSync(
    "scp",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${Math.max(1, Math.ceil(Number(config.sshTimeoutMs) / 1000))}`,
      localScriptPath,
      `${config.remoteWindowsSshTarget}:${remoteScriptName}`
    ],
    {
      encoding: "utf8",
      timeout: Number(config.sshTimeoutMs) || Number(DEFAULTS.sshTimeoutMs),
      windowsHide: true
    }
  );
  try {
    fs.unlinkSync(localScriptPath);
  } catch {}
  if (scpResult.status !== 0) {
    return {
      ok: false,
      status: scpResult.status,
      probe: null,
      stderr: scpResult.stderr || "",
      error: scpResult.error?.message || "remote Windows LAN topology script upload failed"
    };
  }

  const remoteCommand = [
    `$scriptPath = ${psQuote(remoteScriptName)}`,
    "try { & powershell -NoProfile -ExecutionPolicy Bypass -File $scriptPath } finally { Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue }"
  ].join("; ");
  const remoteEncodedCommand = Buffer.from(remoteCommand, "utf16le").toString("base64");
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${Math.max(1, Math.ceil(Number(config.sshTimeoutMs) / 1000))}`,
      config.remoteWindowsSshTarget,
      `powershell -NoProfile -EncodedCommand ${remoteEncodedCommand}`
    ],
    {
      encoding: "utf8",
      timeout: Number(config.sshTimeoutMs) || Number(DEFAULTS.sshTimeoutMs),
      windowsHide: true
    }
  );
  const parsed = parseJsonFromOutput(result.stdout);
  return {
    ok: result.status === 0 && Boolean(parsed),
    status: result.status,
    probe: parsed,
    stderr: result.stderr || "",
    error: result.error?.message || (parsed ? "" : "remote Windows LAN topology probe did not return JSON")
  };
}

function buildReport(config) {
  const local = runLocalProbe(config);
  const remoteWindows = runRemoteWindowsProbe(config);
  const warnings = [
    ...(local.probe
      ? topologyWarnings(local.probe, config.localName, config.disallowedRouteInterfaces)
      : [`${config.localName}_probe_missing`]),
    ...(remoteWindows.probe
      ? topologyWarnings(remoteWindows.probe, config.remoteWindowsName, config.disallowedRouteInterfaces)
      : [`${config.remoteWindowsName}_probe_missing`])
  ];
  const uniqueWarnings = [...new Set(warnings)];
  const diagnosis = diagnoseTopology({ config, local, remoteWindows, warnings: uniqueWarnings });
  return {
    ok: local.ok || remoteWindows.ok,
    bothProbesOk: local.ok && remoteWindows.ok,
    topologyOk: !diagnosis.blocking,
    generatedAt: new Date().toISOString(),
    config: {
      localName: config.localName,
      localAddress: config.localAddress,
      remoteWindowsName: config.remoteWindowsName,
      remoteWindowsSshTarget: config.remoteWindowsSshTarget,
      remoteWindowsAddress: config.remoteWindowsAddress,
      targetName: config.targetName,
      targetHost: config.targetHost,
      targetPort: Number(config.targetPort),
      timeoutMs: Number(config.timeoutMs),
      disallowedRouteInterfaces: config.disallowedRouteInterfaces
    },
    local,
    remoteWindows,
    warnings: uniqueWarnings,
    diagnosis
  };
}

function writeArtifact(report, artifactDir) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${nowStamp()}.json`);
  report.artifactPath = artifactPath;
  fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return artifactPath;
}

function configFromEnv() {
  return {
    artifactDir: env("UST_LAN_TOPOLOGY_ARTIFACT_DIR", DEFAULTS.artifactDir),
    localName: env("UST_LAN_LOCAL_NAME", DEFAULTS.localName),
    localAddress: env("UST_LAN_LOCAL_ADDRESS", DEFAULTS.localAddress),
    remoteWindowsName: env("UST_LAN_REMOTE_WINDOWS_NAME", DEFAULTS.remoteWindowsName),
    remoteWindowsSshTarget: env("UST_LAN_REMOTE_WINDOWS_SSH_TARGET", DEFAULTS.remoteWindowsSshTarget),
    remoteWindowsAddress: env("UST_LAN_REMOTE_WINDOWS_ADDRESS", DEFAULTS.remoteWindowsAddress),
    targetName: env("UST_LAN_TARGET_NAME", DEFAULTS.targetName),
    targetHost: env("UST_LAN_TARGET_HOST", DEFAULTS.targetHost),
    targetPort: env("UST_LAN_TARGET_PORT", DEFAULTS.targetPort),
    timeoutMs: env("UST_LAN_TOPOLOGY_TIMEOUT_MS", DEFAULTS.timeoutMs),
    sshTimeoutMs: env("UST_LAN_TOPOLOGY_SSH_TIMEOUT_MS", DEFAULTS.sshTimeoutMs),
    disallowedRouteInterfaces: parseRouteInterfaceList(
      env("UST_DISALLOWED_ROUTE_INTERFACES", DEFAULTS.disallowedRouteInterfaces)
    )
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-lan-topology.cjs [--no-write]",
    "",
    "Environment:",
    "  UST_LAN_LOCAL_ADDRESS              Default: 192.168.1.118",
    "  UST_LAN_REMOTE_WINDOWS_SSH_TARGET  Default: HUAWEI@192.168.1.117",
    "  UST_LAN_REMOTE_WINDOWS_ADDRESS     Default: 192.168.1.117",
    "  UST_LAN_TARGET_HOST                Default: 192.168.1.137",
    "  UST_LAN_TARGET_PORT                Default: 22",
    "  UST_DISALLOWED_ROUTE_INTERFACES    Default: CMYNetwork"
  ].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const config = configFromEnv();
  const report = buildReport(config);
  if (!argv.includes("--no-write")) {
    writeArtifact(report, config.artifactDir);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  diagnoseTopology,
  topologyWarnings,
  powershellProbeScript,
  parseRouteInterfaceList,
  routeAliasIsDisallowed
};
