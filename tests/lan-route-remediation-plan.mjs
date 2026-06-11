import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPlan, findLatestJsonFile, renderMarkdown, run } = require("../scripts/lan-route-remediation-plan.cjs");

const splitRouteArtifact = {
  generatedAt: "2026-06-11T19:59:23.157Z",
  topologyOk: false,
  config: {
    localName: "or118",
    localAddress: "192.168.1.118",
    remoteWindowsName: "teach117",
    remoteWindowsAddress: "192.168.1.117",
    targetHost: "192.168.1.137",
    targetPort: 22
  },
  diagnosis: {
    classification: "overlay_route_hijack_and_lan_target_unresolved",
    blocking: true,
    evidence: [
      "default_route_tcp_works_but_lan_bound_tcp_fails",
      "target_neighbor_unresolved_on_all_available_probes"
    ]
  },
  local: {
    probe: {
      localAddress: "192.168.1.118",
      routeHint: {
        destinationPrefix: "0.0.0.0/0",
        interfaceAlias: "CMYNetwork",
        sourceAddress: "198.19.0.1"
      },
      targetRoutes: [
        {
          destinationPrefix: "0.0.0.0/0",
          nextHop: "198.19.0.2",
          interfaceAlias: "CMYNetwork",
          routeMetric: 0
        }
      ],
      interfaces: [{ InterfaceAlias: "Ethernet", IPAddress: "192.168.1.118" }],
      routes: [{ DestinationPrefix: "192.168.1.0/24", InterfaceAlias: "Ethernet", InterfaceIndex: 14 }],
      tcp: { bound: { ok: false } },
      neighbors: [
        { ipAddress: "192.168.1.137", linkLayerAddress: "00-00-00-00-00-00" },
        { ipAddress: "192.168.1.117", linkLayerAddress: "8C-B8-7E-AC-D9-F6" }
      ]
    }
  },
  remoteWindows: {
    probe: {
      localAddress: "192.168.1.117",
      routeHint: {
        destinationPrefix: "0.0.0.0/0",
        interfaceAlias: "CMYNetwork",
        sourceAddress: "198.19.0.1"
      },
      targetRoutes: {
        destinationPrefix: "0.0.0.0/0",
        nextHop: "198.19.0.2",
        interfaceAlias: "CMYNetwork",
        routeMetric: 0
      },
      interfaces: [{ InterfaceAlias: "WLAN", IPAddress: "192.168.1.117" }],
      routes: [{ DestinationPrefix: "192.168.1.0/24", InterfaceAlias: "WLAN", InterfaceIndex: 22 }],
      tcp: { bound: { ok: false } },
      neighbors: [
        { ipAddress: "192.168.1.137", linkLayerAddress: "00-00-00-00-00-00" },
        { ipAddress: "192.168.1.118", linkLayerAddress: "00-E0-4C-39-59-A8" }
      ]
    }
  }
};

const plan = createPlan(splitRouteArtifact, "split-route.json");
assert.equal(plan.requiresManualAction, true);
assert.equal(plan.classification, "overlay_route_hijack_and_lan_target_unresolved");
assert.equal(plan.hosts[0].issues.includes("route_source_not_expected_lan"), true);
assert.equal(plan.hosts[0].issues.includes("lan_bound_tcp_unreachable"), true);
assert.equal(plan.hosts[0].targetRoutes[0].destinationPrefix, "0.0.0.0/0");
assert.match(plan.hosts[0].gatedCommands[0].command, /New-NetRoute/);
assert.match(plan.hosts[0].gatedCommands[0].command, /-InterfaceIndex 14/);
assert.match(plan.hosts[0].gatedCommands[0].command, /-PolicyStore ActiveStore/);

const markdown = renderMarkdown(plan);
assert.match(markdown, /Do not run these commands from unattended Codex automation/);
assert.match(markdown, /CMYNetwork/);
assert.match(markdown, /0\.0\.0\.0\/0/);
assert.match(markdown, /Remove-NetRoute/);

const okArtifact = {
  ...splitRouteArtifact,
  topologyOk: true,
  diagnosis: { classification: "ok", blocking: false, evidence: [] },
  local: {
    probe: {
      ...splitRouteArtifact.local.probe,
      routeHint: {
        destinationPrefix: "192.168.1.0/24",
        interfaceAlias: "Ethernet",
        sourceAddress: "192.168.1.118"
      },
      tcp: { bound: { ok: true } },
      neighbors: [{ ipAddress: "192.168.1.137", linkLayerAddress: "00-11-22-33-44-55" }]
    }
  },
  remoteWindows: {
    probe: {
      ...splitRouteArtifact.remoteWindows.probe,
      routeHint: {
        destinationPrefix: "192.168.1.0/24",
        interfaceAlias: "WLAN",
        sourceAddress: "192.168.1.117"
      },
      tcp: { bound: { ok: true } },
      neighbors: [{ ipAddress: "192.168.1.137", linkLayerAddress: "00-11-22-33-44-66" }]
    }
  }
};
const okPlan = createPlan(okArtifact, "ok.json");
assert.equal(okPlan.requiresManualAction, false);
assert.deepEqual(okPlan.hosts[0].issues, []);

const hostRouteArtifact = {
  ...okArtifact,
  local: {
    probe: {
      ...okArtifact.local.probe,
      routeHint: {
        destinationPrefix: "192.168.1.137/32",
        interfaceAlias: "Ethernet",
        sourceAddress: "192.168.1.118"
      }
    }
  }
};
const hostRoutePlan = createPlan(hostRouteArtifact, "host-route.json");
assert.equal(hostRoutePlan.hosts[0].issues.includes("target_route_not_same_lan_prefix"), false);

const tmp = await mkdtemp(path.join(tmpdir(), "ust-lan-route-plan-"));
try {
  const olderPath = path.join(tmp, "older.json");
  const newerPath = path.join(tmp, "newer.json");
  await writeFile(olderPath, `${JSON.stringify(okArtifact)}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(newerPath, `${JSON.stringify(splitRouteArtifact)}\n`, "utf8");
  assert.equal(path.basename(findLatestJsonFile(tmp)), "newer.json");

  const outputPath = path.join(tmp, "plan.md");
  const originalLog = console.log;
  let result;
  try {
    console.log = () => {};
    result = run(["--artifact", newerPath, "--output", outputPath]);
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.requiresManualAction, true);
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /LAN route remediation plan/);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log("lan route remediation plan test passed");
