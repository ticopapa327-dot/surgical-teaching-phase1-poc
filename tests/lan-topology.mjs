import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { powershellProbeScript, topologyWarnings } = require("../scripts/remote-lan-topology.cjs");

const splitRouteProbe = {
  localAddress: "192.168.1.118",
  target: {
    name: "kylin137",
    host: "192.168.1.137",
    port: 22
  },
  routeHint: {
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
assert.match(script, /Get-NetNeighbor/);
assert.match(script, /Test-TcpTarget/);
assert.match(script, /192\.168\.1\.137/);

console.log("lan topology test passed");
