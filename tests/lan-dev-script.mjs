import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runLanDev(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/start-lan-dev.cjs", ...args], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const signalingPort = await getFreePort();
const webPort = await getFreePort();
const success = await runLanDev(["--check"], {
  SIGNALING_HOST: "127.0.0.1",
  SIGNALING_PORT: String(signalingPort),
  UST_WEB_HOST: "127.0.0.1",
  UST_WEB_PORT: String(webPort),
  UST_PREFERRED_ADAPTER: "wired-test-adapter"
});

assert.equal(success.code, 0, `${success.stdout}\n${success.stderr}`);
assert.match(success.stdout, /UST LAN test service configuration/);
assert.match(success.stdout, new RegExp(`ws://127\\.0\\.0\\.1:${signalingPort}/signal`));
assert.match(success.stdout, new RegExp(`http://127\\.0\\.0\\.1:${webPort}`));
assert.match(success.stdout, /Preferred adapter filter: wired-test-adapter/);
assert.match(success.stdout, /Port check: OK/);

const smokeSignalingPort = await getFreePort();
const smokeWebPort = await getFreePort();
const smoke = await runLanDev(["--smoke"], {
  SIGNALING_HOST: "127.0.0.1",
  SIGNALING_PORT: String(smokeSignalingPort),
  UST_WEB_HOST: "127.0.0.1",
  UST_WEB_PORT: String(smokeWebPort)
});

assert.equal(smoke.code, 0, `${smoke.stdout}\n${smoke.stderr}`);
assert.match(smoke.stdout, /Services ready/);
assert.match(smoke.stdout, new RegExp(`ws://127\\.0\\.0\\.1:${smokeSignalingPort}/signal`));
assert.match(smoke.stdout, new RegExp(`http://127\\.0\\.0\\.1:${smokeWebPort}`));

const occupiedPort = await getFreePort();
const occupiedServer = net.createServer();
await listen(occupiedServer, occupiedPort);
try {
  const freeWebPort = await getFreePort();
  const failure = await runLanDev(["--check"], {
    SIGNALING_HOST: "127.0.0.1",
    SIGNALING_PORT: String(occupiedPort),
    UST_WEB_HOST: "127.0.0.1",
    UST_WEB_PORT: String(freeWebPort)
  });
  assert.notEqual(failure.code, 0, `${failure.stdout}\n${failure.stderr}`);
  assert.match(failure.stderr, new RegExp(`SIGNALING_PORT port ${occupiedPort} on 127\\.0\\.0\\.1 is unavailable`));
} finally {
  await close(occupiedServer);
}

console.log("LAN dev script test passed");
