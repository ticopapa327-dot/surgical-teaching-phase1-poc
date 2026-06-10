const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const dryRun = process.argv.includes("--check");
const smokeRun = process.argv.includes("--smoke");
const signalingHost = process.env.SIGNALING_HOST || "0.0.0.0";
const signalingPort = Number(process.env.SIGNALING_PORT || 7077);
const webHost = process.env.UST_WEB_HOST || "0.0.0.0";
const webPort = Number(process.env.UST_WEB_PORT || 5173);
const viteBin = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");

let shuttingDown = false;
const children = [];

function localIPv4Addresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, items = []]) =>
      items
        .filter((item) => item && item.family === "IPv4" && !item.internal)
        .map((item) => ({ name, address: item.address }))
    )
    .sort((left, right) => addressPriority(left) - addressPriority(right));
}

function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isLikelyVirtualAdapter(name) {
  return /virtual|vethernet|vmware|hyper-v|wsl|vpn|cmy/i.test(name);
}

function addressPriority(item) {
  let score = 0;
  if (!isPrivateIPv4(item.address)) score += 20;
  if (isLikelyVirtualAdapter(item.name)) score += 10;
  return score;
}

function validatePortNumber(name, value) {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port, got ${value}`);
  }
}

function checkPortAvailable(name, host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      reject(new Error(`${name} port ${port} on ${host} is unavailable: ${error.code || error.message}`));
    });
    server.listen(port, host, () => {
      server.close(() => resolve());
    });
  });
}

function waitForHttp(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1200, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(probe, 500);
    };
    probe();
  });
}

function printAccessInfo(addresses) {
  console.log("UST LAN test service configuration");
  console.log(`Signaling bind: ws://${signalingHost}:${signalingPort}/signal`);
  console.log(`Web bind:       http://${webHost}:${webPort}`);
  console.log("");
  if (!addresses.length) {
    console.log("No non-loopback IPv4 address detected. Check the active LAN adapter.");
  }
  for (const [index, item] of addresses.entries()) {
    console.log(`Adapter: ${item.name}${index === 0 ? " (recommended)" : ""}`);
    console.log(`  LAN URL: http://${item.address}:${webPort}`);
    console.log(`  Signal:  ws://${item.address}:${signalingPort}/signal`);
  }
  console.log("");
  console.log("Windows firewall commands when PC-B needs to access PC-A:");
  console.log(
    `  New-NetFirewallRule -DisplayName "UST Signaling ${signalingPort}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${signalingPort}`
  );
  console.log(
    `  New-NetFirewallRule -DisplayName "UST Web ${webPort}" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${webPort}`
  );
}

function startProcess(name, command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited with ${signal || code}`);
    shutdown(code || 1);
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

async function main() {
  validatePortNumber("SIGNALING_PORT", signalingPort);
  validatePortNumber("UST_WEB_PORT", webPort);
  const addresses = localIPv4Addresses();
  printAccessInfo(addresses);

  await checkPortAvailable("SIGNALING_PORT", signalingHost, signalingPort);
  await checkPortAvailable("UST_WEB_PORT", webHost, webPort);
  console.log("Port check: OK");

  if (dryRun) return;

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  children.push(
    startProcess("signaling", process.execPath, ["server/signaling-server.cjs"], {
      SIGNALING_HOST: signalingHost,
      SIGNALING_PORT: String(signalingPort)
    })
  );
  children.push(
    startProcess("web", process.execPath, [viteBin, "--host", webHost, "--port", String(webPort), "--strictPort"])
  );

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${signalingPort}/health`),
    waitForHttp(`http://127.0.0.1:${webPort}`)
  ]);
  console.log("");
  console.log("Services ready. Keep this terminal open during the two-PC test.");
  if (smokeRun) shutdown(0);
}

main().catch((error) => {
  console.error(`LAN test service startup failed: ${error.message}`);
  shutdown(1);
});
