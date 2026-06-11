import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  compareKeys,
  fingerprintKey,
  hostsFromCidr,
  parseKeyscanText,
  parseKnownHostsText
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

assert.deepEqual(hostsFromCidr("192.168.1.0/30"), ["192.168.1.1", "192.168.1.2"]);
assert.throws(() => hostsFromCidr("192.168.1.0/16"), /\/24 to \/30/);

const expectedDigest = crypto.createHash("sha256").update(Buffer.from(keyA, "base64")).digest("base64");
assert.equal(fingerprintKey(keyA), `SHA256:${expectedDigest.replace(/=+$/, "")}`);

console.log("kylin discovery test passed");
