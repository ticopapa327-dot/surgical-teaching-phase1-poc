import assert from "node:assert/strict";
import fs from "node:fs";

const config = JSON.parse(fs.readFileSync("public/config.example.json", "utf8"));

assert.equal(typeof config.signalingUrl, "string");
const signalingUrl = new URL(config.signalingUrl);
assert.ok(["ws:", "wss:"].includes(signalingUrl.protocol), "signalingUrl must use ws:// or wss://");

assert.ok(config.localEndpoint && typeof config.localEndpoint === "object");
assert.equal(typeof config.localEndpoint.id, "string");
assert.equal(typeof config.localEndpoint.name, "string");
assert.ok(
  ["operating-room", "teaching-room", "observer"].includes(config.localEndpoint.role),
  "localEndpoint.role must be a supported role"
);

assert.ok(config.webrtc && typeof config.webrtc === "object");
assert.ok(Array.isArray(config.webrtc.iceServers), "webrtc.iceServers must be an array");
assert.ok(config.webrtc.iceServers.length >= 2, "example should include both STUN and TURN entries");

const urls = config.webrtc.iceServers.flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]));
assert.ok(urls.some((url) => /^stun:/i.test(url)), "example should include a STUN URL");
assert.ok(urls.some((url) => /^turns?:/i.test(url)), "example should include a TURN URL");

const turnServer = config.webrtc.iceServers.find((server) =>
  (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/i.test(url))
);
assert.equal(turnServer.username, "turn-user");
assert.equal(turnServer.credential, "turn-password");

console.log("runtime config example test passed");
