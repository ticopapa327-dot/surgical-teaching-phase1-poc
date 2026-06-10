const { spawn } = require("node:child_process");
const os = require("node:os");

const isWindows = process.platform === "win32";

function localIPv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
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

let shuttingDown = false;
const children = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const npxCommand = isWindows ? "npx.cmd" : "npx";

console.log("Starting UST LAN test services...");
console.log("Signaling: ws://0.0.0.0:7077/signal");
console.log("Web:       http://0.0.0.0:5173");
for (const address of localIPv4Addresses()) {
  console.log(`LAN URL:   http://${address}:5173`);
  console.log(`Signal:    ws://${address}:7077/signal`);
}

children.push(
  startProcess("signaling", "node", ["server/signaling-server.cjs"], {
    SIGNALING_HOST: "0.0.0.0",
    SIGNALING_PORT: "7077"
  })
);
children.push(startProcess("web", npxCommand, ["vite", "--host", "0.0.0.0", "--port", "5173"]));
