import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { diagnoseTopology, powershellProbeScript, topologyWarnings } = require("../scripts/remote-lan-topology.cjs");

const splitRouteProbe = {
  localAddress: "192.168.1.118",
  target: {
    name: "kylin137",
    host: "192.168.1.137",
    port: 22
  },
  routeHint: {
    destinationPrefix: "192.168.1.137/32",
    interfaceAlias: "CMYNetwork",
    sourceAddress: "198.19.0.1"
  },
  tcp: {
    bound: {
      ok: false,
      error: "timeout"
    }
  },
  neighbors: [
    {
      ipAddress: "192.168.1.137",
      linkLayerAddress: "00-00-00-00-00-00"
    }
  ]
};

assert.deepEqual(topologyWarnings(splitRouteProbe, "or118"), [
  "or118_kylin137_disallowed_route_interface",
  "or118_kylin137_route_source_not_expected_lan",
  "or118_kylin137_bound_tcp_unreachable",
  "or118_kylin137_neighbor_unresolved"
]);

const lanProbe = {
  ...splitRouteProbe,
  routeHint: {
    interfaceAlias: "以太网 2",
    sourceAddress: "192.168.1.118"
  },
  tcp: {
    bound: {
      ok: true,
      error: ""
    }
  },
  neighbors: [
    {
      ipAddress: "192.168.1.137",
      linkLayerAddress: "00-11-22-33-44-55"
    }
  ]
};

assert.deepEqual(topologyWarnings(lanProbe, "or118"), []);

const splitRouteDiagnosis = diagnoseTopology({
  config: {
    localAddress: "192.168.1.118",
    remoteWindowsAddress: "192.168.1.117",
    targetHost: "192.168.1.137",
    targetPort: "22"
  },
  local: {
    ok: true,
    probe: {
      ...splitRouteProbe,
      role: "or118",
      neighbors: [
        ...splitRouteProbe.neighbors,
        {
          ipAddress: "192.168.1.117",
          linkLayerAddress: "8C-B8-7E-AC-D9-F6"
        }
      ],
      tcp: {
        default: { ok: true },
        bound: { ok: false }
      }
    }
  },
  remoteWindows: {
    ok: true,
    probe: {
      ...splitRouteProbe,
      role: "teach117",
      localAddress: "192.168.1.117",
      routeHint: {
        destinationPrefix: "192.168.1.137/32",
        interfaceAlias: "CMYNetwork",
        sourceAddress: "198.19.0.1"
      },
      neighbors: [
        {
          ipAddress: "192.168.1.137",
          linkLayerAddress: "00-00-00-00-00-00"
        },
        {
          ipAddress: "192.168.1.118",
          linkLayerAddress: "00-E0-4C-39-59-A8"
        }
      ],
      tcp: {
        default: { ok: true },
        bound: { ok: false }
      }
    }
  },
  warnings: [
    "or118_kylin137_route_source_not_expected_lan",
    "teach117_kylin137_route_source_not_expected_lan"
  ]
});
assert.equal(splitRouteDiagnosis.classification, "overlay_route_hijack_and_lan_target_unresolved");
assert.equal(splitRouteDiagnosis.blocking, true);
assert.equal(splitRouteDiagnosis.local.routeDestination, "192.168.1.137/32");
assert.equal(splitRouteDiagnosis.local.routeInterfaceDisallowed, true);
assert.equal(
  splitRouteDiagnosis.evidence.includes("default_route_tcp_works_but_lan_bound_tcp_fails"),
  true
);
assert.equal(splitRouteDiagnosis.evidence.includes("disallowed_route_interface_on_all_available_probes"), true);
assert.equal(splitRouteDiagnosis.evidence.includes("117_and_118_can_resolve_each_other_on_lan"), true);

const okDiagnosis = diagnoseTopology({
  config: {
    localAddress: "192.168.1.118",
    remoteWindowsAddress: "192.168.1.117",
    targetHost: "192.168.1.137",
    targetPort: "22"
  },
  local: { ok: true, probe: lanProbe },
  remoteWindows: {
    ok: true,
    probe: {
      ...lanProbe,
      role: "teach117",
      localAddress: "192.168.1.117",
      routeHint: { interfaceAlias: "WLAN", sourceAddress: "192.168.1.117" },
      tcp: { default: { ok: true }, bound: { ok: true } },
      neighbors: [
        { ipAddress: "192.168.1.137", linkLayerAddress: "00-11-22-33-44-66" },
        { ipAddress: "192.168.1.118", linkLayerAddress: "00-E0-4C-39-59-A8" }
      ]
    }
  },
  warnings: []
});
assert.equal(okDiagnosis.classification, "ok");
assert.equal(okDiagnosis.blocking, false);

const script = powershellProbeScript({
  role: "or118",
  localAddress: "192.168.1.118",
  targetName: "kylin137",
  targetHost: "192.168.1.137",
  targetPort: "22",
  timeoutMs: "1500",
  peerAddresses: ["192.168.1.117"]
});
assert.match(script, /Find-NetRoute/);
assert.match(script, /Get-TargetRoutes/);
assert.match(script, /targetRoutes/);
assert.match(script, /destinationPrefix/);
assert.match(script, /Get-NetNeighbor/);
assert.match(script, /Test-TcpTarget/);
assert.match(script, /192\.168\.1\.137/);

console.log("lan topology test passed");
