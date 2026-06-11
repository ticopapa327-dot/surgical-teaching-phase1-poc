import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compareKeys,
  describeKnownHostConnectivity,
  fingerprintKey,
  hostsFromCidr,
  parseKeyscanText,
  parseKnownHostsText,
  routeUsesExpectedLocalAddress
} = require("../scripts/remote-kylin-discover.cjs");

const keyA = Buffer.from("kylin-test-key-a").toString("base64");
const keyB = Buffer.from("kylin-test-key-b").toString("base64");

const knownHostsText = [
  "192.168.1.137 ssh-ed25519 " + keyA,
  "[192.168.1.137]:2222 ssh-rsa " + keyB,
  "192.168.1.117 ssh-ed25519 " + keyB
].join("\n");

const defaultPortKeys = parseKnownHostsText(knownHostsText, "192.168.1.137", 22);
assert.equal(defaultPortKeys.length, 1);
assert.equal(defaultPortKeys[0].keyType, "ssh-ed25519");
assert.equal(defaultPortKeys[0].fingerprint, fingerprintKey(keyA));

const explicitPortKeys = parseKnownHostsText(knownHostsText, "192.168.1.137", 2222);
assert.equal(explicitPortKeys.length, 1);
assert.equal(explicitPortKeys[0].keyType, "ssh-rsa");

const keyscan = parseKeyscanText(
  [
    "# 192.168.1.88:22 SSH-2.0-OpenSSH",
    "192.168.1.88 ssh-ed25519 " + keyA,
    "192.168.1.88 ecdsa-sha2-nistp256 " + keyB
  ].join("\n")
);
const comparison = compareKeys(keyscan, defaultPortKeys);
assert.equal(comparison.ok, true);
assert.deepEqual(comparison.matchedKeyTypes, ["ssh-ed25519"]);

const miss = compareKeys(parseKeyscanText("192.168.1.99 ssh-rsa " + keyB), defaultPortKeys);
assert.equal(miss.ok, false);

const splitRoute = describeKnownHostConnectivity({
  host: "192.168.1.137",
  port: 22,
  localAddress: "192.168.1.118",
  boundResult: { ok: false, error: "timeout" },
  osRouteResult: { ok: true, error: "" },
  keyscan: { status: 1, error: "", stderr: "Connection closed", keys: [] },
  routeHint: {
    interfaceAlias: "CMYNetwork",
    sourceAddress: "198.19.0.1",
    nextHop: "198.19.0.2"
  }
});
assert.equal(splitRoute.classification, "os-route-open-lan-bound-closed");
assert.equal(splitRoute.bound.tcpOpen, false);
assert.equal(splitRoute.osRoute.tcpOpen, true);
assert.equal(splitRoute.routeOnExpectedLan, false);
assert.equal(splitRoute.routeHint.interfaceAlias, "CMYNetwork");
assert.equal(splitRoute.keyscan.keyCount, 0);
assert.ok(splitRoute.warnings.some((warning) => warning.includes("another interface")));
assert.ok(splitRoute.warnings.some((warning) => warning.includes("did not return SSH host keys")));
assert.ok(splitRoute.warnings.some((warning) => warning.includes("does not match expected LAN source")));

const lanRoute = describeKnownHostConnectivity({
  host: "192.168.1.137",
  port: 22,
  localAddress: "192.168.1.118",
  boundResult: { ok: true, error: "" },
  osRouteResult: { ok: true, error: "" },
  keyscan: { status: 0, error: "", stderr: "", keys: keyscan }
});
assert.equal(lanRoute.classification, "lan-bound-open");
assert.deepEqual(lanRoute.warnings, []);

assert.deepEqual(hostsFromCidr("192.168.1.0/30"), ["192.168.1.1", "192.168.1.2"]);
assert.throws(() => hostsFromCidr("192.168.1.0/16"), /\/24 to \/30/);
assert.equal(routeUsesExpectedLocalAddress({ sourceAddress: "192.168.1.118" }, "192.168.1.118"), true);
assert.equal(routeUsesExpectedLocalAddress({ sourceAddress: "198.19.0.1" }, "192.168.1.118"), false);
assert.equal(routeUsesExpectedLocalAddress(null, "192.168.1.118"), null);

const expectedDigest = crypto.createHash("sha256").update(Buffer.from(keyA, "base64")).digest("base64");
assert.equal(fingerprintKey(keyA), `SHA256:${expectedDigest.replace(/=+$/, "")}`);

console.log("kylin discovery test passed");
