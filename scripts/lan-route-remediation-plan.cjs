const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  topologyDir: path.join("test-results", "remote-lan-topology"),
  outputPath: path.join("validation-results", "cross-machine-validation", "lan-route-remediation-plan.md"),
  targetSubnet: "192.168.1.0/24"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function usage() {
  return [
    "Usage:",
    "  node scripts/lan-route-remediation-plan.cjs [options]",
    "",
    "Options:",
    "  --artifact <path>     LAN topology artifact JSON; default is newest test-results/remote-lan-topology/*.json",
    "  --output <path>       Markdown output path",
    "  --json                Print plan as JSON",
    "  --no-write            Do not write Markdown output",
    "  --help                Show this help",
    "",
    "Environment:",
    "  UST_LAN_REMEDIATION_ARTIFACT     Default artifact path",
    "  UST_LAN_REMEDIATION_OUTPUT       Default Markdown output path",
    "  UST_LAN_REMEDIATION_TOPOLOGY_DIR Default topology artifact directory"
  ].join("\n");
}

function parseArgs(argv) {
  return {
    artifactPath: readArg(argv, "--artifact") || env("UST_LAN_REMEDIATION_ARTIFACT", ""),
    topologyDir: env("UST_LAN_REMEDIATION_TOPOLOGY_DIR", DEFAULTS.topologyDir),
    outputPath: readArg(argv, "--output") || env("UST_LAN_REMEDIATION_OUTPUT", DEFAULTS.outputPath),
    json: argv.includes("--json"),
    noWrite: argv.includes("--no-write"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findLatestJsonFile(dir) {
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .map((name) => path.join(dir, name))
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || "";
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function field(object, ...names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && String(value) !== "") return value;
  }
  return "";
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isResolvedNeighbor(neighbor) {
  const mac = String(field(neighbor, "linkLayerAddress", "LinkLayerAddress"));
  return Boolean(neighbor && mac && mac !== "00-00-00-00-00-00");
}

function findNeighbor(probe, address) {
  return normalizeArray(probe?.neighbors).find(
    (item) => String(field(item, "ipAddress", "IPAddress")) === String(address)
  );
}

function findInterfaceByAddress(probe, address) {
  return normalizeArray(probe?.interfaces).find(
    (item) => String(field(item, "ipAddress", "IPAddress")) === String(address)
  );
}

function findLanRoute(probe, interfaceAlias) {
  return normalizeArray(probe?.routes).find((item) => {
    const destination = String(field(item, "destinationPrefix", "DestinationPrefix"));
    const routeAlias = String(field(item, "interfaceAlias", "InterfaceAlias"));
    return destination === DEFAULTS.targetSubnet && (!interfaceAlias || routeAlias === interfaceAlias);
  });
}

function routeSummary(route) {
  return {
    destinationPrefix: String(field(route, "destinationPrefix", "DestinationPrefix")),
    nextHop: String(field(route, "nextHop", "NextHop")),
    interfaceAlias: String(field(route, "interfaceAlias", "InterfaceAlias")),
    routeMetric: field(route, "routeMetric", "RouteMetric") === "" ? null : Number(field(route, "routeMetric", "RouteMetric")),
    interfaceMetric:
      field(route, "interfaceMetric", "InterfaceMetric") === ""
        ? null
        : Number(field(route, "interfaceMetric", "InterfaceMetric"))
  };
}

function hostPlan({ label, probe, targetHost, targetPort, peerAddress }) {
  const localAddress = String(probe?.localAddress || "");
  const routeHint = probe?.routeHint || {};
  const routeSource = String(routeHint.sourceAddress || "");
  const routeDestination = String(routeHint.destinationPrefix || "");
  const routeInterface = String(routeHint.interfaceAlias || "");
  const targetNeighbor = findNeighbor(probe, targetHost);
  const peerNeighbor = findNeighbor(probe, peerAddress);
  const lanInterface = findInterfaceByAddress(probe, localAddress);
  const lanInterfaceAlias = String(field(lanInterface, "interfaceAlias", "InterfaceAlias"));
  const lanRoute = findLanRoute(probe, lanInterfaceAlias);
  const lanInterfaceIndexValue = field(lanInterface, "interfaceIndex", "InterfaceIndex") || field(lanRoute, "interfaceIndex", "InterfaceIndex");
  const lanInterfaceIndex = lanInterfaceIndexValue === "" ? null : Number(lanInterfaceIndexValue);
  const boundTcpOk = probe?.tcp?.bound?.ok === true;
  const targetNeighborResolved = isResolvedNeighbor(targetNeighbor);
  const peerNeighborResolved = isResolvedNeighbor(peerNeighbor);
  const issues = [];

  if (routeSource && localAddress && routeSource !== localAddress) {
    issues.push("route_source_not_expected_lan");
  }
  const validLanRouteDestinations = new Set([DEFAULTS.targetSubnet, `${targetHost}/32`]);
  if (routeDestination && !validLanRouteDestinations.has(routeDestination)) {
    issues.push("target_route_not_same_lan_prefix");
  }
  if (!boundTcpOk) issues.push("lan_bound_tcp_unreachable");
  if (!targetNeighborResolved) issues.push("target_neighbor_unresolved");

  const targetRoutes = normalizeArray(probe?.targetRoutes).map(routeSummary);
  const inspectCommands = [
    `Find-NetRoute -RemoteIPAddress ${psQuote(targetHost)} | Format-List *`,
    `Get-NetRoute -AddressFamily IPv4 | Sort-Object RouteMetric,InterfaceMetric | Format-Table DestinationPrefix,NextHop,InterfaceAlias,RouteMetric,InterfaceMetric`,
    `Get-NetNeighbor -AddressFamily IPv4 | Where-Object { $_.IPAddress -in @(${psQuote(targetHost)}, ${psQuote(peerAddress)}) }`,
    `Test-NetConnection ${targetHost} -Port ${Number(targetPort || 22)}`,
    localAddress ? `ping -S ${localAddress} -n 2 -w 1000 ${targetHost}` : `ping -n 2 -w 1000 ${targetHost}`
  ];
  const gatedCommands = [];
  if ((lanInterfaceIndex || lanInterfaceAlias) && targetHost) {
    const interfaceSelector = lanInterfaceIndex
      ? `-InterfaceIndex ${lanInterfaceIndex}`
      : `-InterfaceAlias ${psQuote(lanInterfaceAlias)}`;
    gatedCommands.push({
      purpose: "Temporary Windows host route for onsite/manual validation only",
      preconditions: [
        "137 is confirmed on the same physical LAN/VLAN as this host",
        "A local operator can restore network access if remote control is interrupted",
        "The command is run in an elevated PowerShell session and removed after validation"
      ],
      command: `New-NetRoute -DestinationPrefix ${targetHost}/32 ${interfaceSelector} -NextHop 0.0.0.0 -RouteMetric 1 -PolicyStore ActiveStore`,
      rollback: `Remove-NetRoute -DestinationPrefix ${targetHost}/32 ${interfaceSelector} -NextHop 0.0.0.0 -Confirm:$false`
    });
  }

  return {
    label,
    localAddress,
    lanInterfaceAlias,
    lanInterfaceIndex,
    routeDestination,
    routeInterface,
    routeSource,
    boundTcpOk,
    targetNeighborResolved,
    peerNeighborResolved,
    targetRoutes,
    issues,
    inspectCommands,
    gatedCommands
  };
}

function createPlan(artifact, sourcePath = "") {
  const config = artifact.config || {};
  const targetHost = config.targetHost || artifact.diagnosis?.targetHost || "";
  const targetPort = Number(config.targetPort || artifact.diagnosis?.targetPort || 22);
  const local = hostPlan({
    label: config.localName || "local",
    probe: artifact.local?.probe || {},
    targetHost,
    targetPort,
    peerAddress: config.remoteWindowsAddress || ""
  });
  const remoteWindows = hostPlan({
    label: config.remoteWindowsName || "remoteWindows",
    probe: artifact.remoteWindows?.probe || {},
    targetHost,
    targetPort,
    peerAddress: config.localAddress || ""
  });
  const hosts = [local, remoteWindows];
  const classification = artifact.diagnosis?.classification || (artifact.topologyOk ? "ok" : "unknown");
  const blocking = artifact.diagnosis?.blocking === true || artifact.topologyOk === false;
  const requiresManualAction = blocking || hosts.some((host) => host.issues.length > 0);
  const evidence = Array.isArray(artifact.diagnosis?.evidence) ? artifact.diagnosis.evidence : [];

  return {
    ok: !requiresManualAction,
    requiresManualAction,
    generatedAt: new Date().toISOString(),
    sourcePath,
    sourceGeneratedAt: artifact.generatedAt || "",
    targetHost,
    targetPort,
    classification,
    evidence,
    hosts,
    kylinManualChecks: [
      "ip -4 addr show",
      `ip route get ${config.localAddress || "192.168.1.118"}`,
      `ping -c 2 -I <kylin-lan-interface> ${config.localAddress || "192.168.1.118"}`,
      "ss -ltnp | grep ':22'",
      "sudo firewall-cmd --state 2>/dev/null || true",
      "sudo ufw status 2>/dev/null || true"
    ],
    nextSteps: [
      `Confirm ${targetHost} is actually connected to the same ${DEFAULTS.targetSubnet} LAN/VLAN as ${config.localAddress || "118"} and ${config.remoteWindowsAddress || "117"}.`,
      "Use the read-only inspection commands first; do not change Windows routes from an unattended remote session.",
      "If 137 is confirmed on the same LAN, run any temporary host-route command only with onsite recovery available.",
      "After any physical network or route change, rerun npm run test:remote:lan:topology and then npm run test:remote:cross:loop:strict -- --once --interval-seconds 1."
    ]
  };
}

function renderHostTable(hosts) {
  const rows = [
    "| Host | LAN address | LAN interface | LAN index | Route destination | Route interface | Route source | Bound TCP | 137 neighbor | Peer neighbor | Issues |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const host of hosts) {
    rows.push(
      [
        host.label,
        host.localAddress || "-",
        host.lanInterfaceAlias || "-",
        host.lanInterfaceIndex ?? "-",
        host.routeDestination || "-",
        host.routeInterface || "-",
        host.routeSource || "-",
        String(host.boundTcpOk),
        String(host.targetNeighborResolved),
        String(host.peerNeighborResolved),
        host.issues.join(", ") || "-"
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
    );
  }
  return rows.join("\n");
}

function renderMarkdown(plan) {
  const lines = [
    "# LAN route remediation plan",
    "",
    `Generated at: ${plan.generatedAt}`,
    `Source artifact: ${plan.sourcePath || "-"}`,
    `Source generated at: ${plan.sourceGeneratedAt || "-"}`,
    `Target: ${plan.targetHost}:${plan.targetPort}`,
    `Classification: ${plan.classification}`,
    `Requires manual action: ${plan.requiresManualAction}`,
    "",
    "## Evidence",
    "",
    ...(plan.evidence.length ? plan.evidence.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Host summary",
    "",
    renderHostTable(plan.hosts),
    "",
    "## Read-only Windows checks",
    ""
  ];
  for (const host of plan.hosts) {
    lines.push(`### ${host.label}`, "");
    for (const command of host.inspectCommands) lines.push(`- \`${command}\``);
    if (host.targetRoutes.length) {
      lines.push("", "Target route candidates:");
      for (const route of host.targetRoutes) {
        lines.push(
          `- ${route.destinationPrefix || "-"} via ${route.nextHop || "-"} on ${route.interfaceAlias || "-"} routeMetric=${route.routeMetric ?? "-"} interfaceMetric=${route.interfaceMetric ?? "-"}`
        );
      }
    }
    lines.push("");
  }

  lines.push("## Kylin 137 manual checks", "");
  for (const command of plan.kylinManualChecks) lines.push(`- \`${command}\``);

  lines.push("", "## Gated route commands", "");
  lines.push("Do not run these commands from unattended Codex automation. They are candidate manual actions only.");
  for (const host of plan.hosts) {
    for (const command of host.gatedCommands) {
      lines.push("", `### ${host.label}: ${command.purpose}`, "");
      lines.push("Preconditions:");
      for (const precondition of command.preconditions) lines.push(`- ${precondition}`);
      lines.push("", "Command:");
      lines.push(`\`${command.command}\``);
      lines.push("", "Rollback:");
      lines.push(`\`${command.rollback}\``);
    }
  }

  lines.push("", "## Next steps", "");
  for (const step of plan.nextSteps) lines.push(`- ${step}`);
  lines.push("");
  return lines.join("\n");
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, help: true };
  }
  const artifactPath = options.artifactPath || findLatestJsonFile(options.topologyDir);
  if (!artifactPath) {
    throw new Error(`No LAN topology artifact found in ${options.topologyDir}`);
  }
  const artifact = readJson(artifactPath);
  const plan = createPlan(artifact, artifactPath);
  const markdown = renderMarkdown(plan);
  if (!options.noWrite) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, markdown, "utf8");
  }
  const result = {
    ok: true,
    outputPath: options.noWrite ? "" : options.outputPath,
    artifactPath,
    requiresManualAction: plan.requiresManualAction,
    classification: plan.classification
  };
  if (options.json) {
    console.log(JSON.stringify({ ...result, plan }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  createPlan,
  findLatestJsonFile,
  hostPlan,
  parseArgs,
  renderMarkdown,
  run
};
