import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseRouteInterfaceList,
  routeAliasIsDisallowed,
  routePolicyStatus
} = require("../scripts/remote-kylin-devtools.cjs");

const baseConfig = {
  remoteLanHost: "192.168.1.137",
  firewallAllowHost: "192.168.1.118",
  disallowedRouteInterfaces: ["CMYNetwork"]
};

assert.deepEqual(parseRouteInterfaceList("CMYNetwork, Other"), ["CMYNetwork", "Other"]);
assert.equal(routeAliasIsDisallowed("CMYNetwork", ["CMYNetwork"]), true);
assert.equal(routeAliasIsDisallowed("cmynetwork", ["CMYNetwork"]), true);
assert.equal(routeAliasIsDisallowed("以太网 2", ["CMYNetwork"]), false);

const lanPolicy = routePolicyStatus(
  {
    available: true,
    interfaceAlias: "以太网 2",
    sourceAddress: "192.168.1.118",
    destinationPrefix: "192.168.1.0/24",
    nextHop: "0.0.0.0"
  },
  baseConfig
);
assert.equal(lanPolicy.ok, true);
assert.equal(lanPolicy.usesDisallowedRoute, false);

const cmyPolicy = routePolicyStatus(
  {
    available: true,
    interfaceAlias: "CMYNetwork",
    sourceAddress: "198.19.0.1",
    destinationPrefix: "0.0.0.0/0",
    nextHop: "198.19.0.2"
  },
  baseConfig
);
assert.equal(cmyPolicy.ok, false);
assert.equal(cmyPolicy.usesDisallowedRoute, true);
assert.equal(cmyPolicy.sourceAddress, "198.19.0.1");

console.log("kylin devtools route policy test passed");
