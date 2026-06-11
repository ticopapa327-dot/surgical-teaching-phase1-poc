import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseLanTargets,
  parseRouteInterfaceList,
  probeWarnings
} = require("../scripts/remote-windows-probe.cjs");

assert.deepEqual(parseLanTargets("kylin137=192.168.1.137:22"), [
  {
    name: "kylin137",
    host: "192.168.1.137",
    port: 22
  }
]);

assert.deepEqual(parseLanTargets("192.168.1.118:7077, kylin137=192.168.1.137:22"), [
  {
    name: "192.168.1.118:7077",
    host: "192.168.1.118",
    port: 7077
  },
  {
    name: "kylin137",
    host: "192.168.1.137",
    port: 22
  }
]);

assert.deepEqual(parseLanTargets(""), []);
assert.throws(() => parseLanTargets("bad-target"), /invalid LAN target/);
assert.throws(() => parseLanTargets("kylin137=192.168.1.137:0"), /invalid LAN target/);
assert.deepEqual(parseRouteInterfaceList("CMYNetwork, Other"), ["CMYNetwork", "Other"]);

assert.deepEqual(
  probeWarnings({
    checks: {
      runtime: { node: "" },
      devTools: { ok: false },
      lanTargets: [
        {
          name: "kylin137",
          ok: true,
          onExpectedLan: false,
          usesDisallowedRoute: true,
          route: {
            interfaceAlias: "CMYNetwork",
            sourceAddress: "198.19.0.1"
          }
        },
        {
          name: "or118",
          ok: false,
          onExpectedLan: true
        }
      ]
    }
  }),
  [
    "node_not_found_on_remote_windows",
    "devtools_not_running_before_probe",
    "lan_target_kylin137_disallowed_route_interface",
    "lan_target_kylin137_non_lan_route",
    "lan_target_or118_unreachable"
  ]
);

console.log("remote windows probe test passed");
