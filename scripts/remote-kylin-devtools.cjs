const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "xyzn@192.168.1.137",
  remoteLanHost: "192.168.1.137",
  remoteHost: "127.0.0.1",
  remotePort: "9334",
  localHost: "127.0.0.1",
  localPort: "9225",
  mode: "lan",
  firewallAllowHost: "192.168.1.118",
  allowUnrestrictedLan: "false",
  headless: "true",
  display: ":0",
  xauthority: "/home/xyzn/.Xauthority",
  browserBin: "kylin-browser",
  remoteUserDataDir: "/tmp/ust-kylin-headless-remote-debug",
  legacyRemoteUserDataDirs: "/tmp/ust-kylin-browser-remote-debug",
  remoteLogPath: "/tmp/ust-kylin-headless-remote-debug.log",
  statePath: path.join("test-results", "remote-kylin-devtools", "state.json")
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function envFlag(name, fallback) {
  const value = env(name, fallback).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function configFromEnv() {
  const mode = env("UST_KYLIN_DEVTOOLS_MODE", DEFAULTS.mode);
  const remoteLanHost = env("UST_KYLIN_HOST", DEFAULTS.remoteLanHost);
  const remotePort = env("UST_KYLIN_DEVTOOLS_REMOTE_PORT", DEFAULTS.remotePort);
  const localHost = env("UST_KYLIN_DEVTOOLS_LOCAL_HOST", DEFAULTS.localHost);
  const localPort = env("UST_KYLIN_DEVTOOLS_LOCAL_PORT", DEFAULTS.localPort);
  return {
    sshTarget: env("UST_KYLIN_SSH_TARGET", DEFAULTS.sshTarget),
    remoteLanHost,
    remoteHost: env("UST_KYLIN_DEVTOOLS_REMOTE_HOST", DEFAULTS.remoteHost),
    remotePort,
    localHost,
    localPort,
    mode,
    localDebugUrl: env(
      "UST_REMOTE_DEBUG_URL",
      mode === "ssh-tunnel" ? `http://${localHost}:${localPort}` : `http://${remoteLanHost}:${remotePort}`
    ),
    firewallAllowHost: env("UST_KYLIN_FIREWALL_ALLOW_HOST", DEFAULTS.firewallAllowHost),
    sudoPassword: env("UST_KYLIN_SUDO_PASSWORD", ""),
    allowUnrestrictedLan: envFlag("UST_KYLIN_ALLOW_UNRESTRICTED_DEVTOOLS", DEFAULTS.allowUnrestrictedLan),
    headless: envFlag("UST_KYLIN_HEADLESS", DEFAULTS.headless),
    display: env("UST_KYLIN_DISPLAY", DEFAULTS.display),
    xauthority: env("UST_KYLIN_XAUTHORITY", DEFAULTS.xauthority),
    browserBin: env("UST_KYLIN_BROWSER_BIN", DEFAULTS.browserBin),
    remoteUserDataDir: env("UST_KYLIN_BROWSER_USER_DATA_DIR", DEFAULTS.remoteUserDataDir),
    legacyRemoteUserDataDirs: env("UST_KYLIN_LEGACY_BROWSER_USER_DATA_DIRS", DEFAULTS.legacyRemoteUserDataDirs)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    remoteLogPath: env("UST_KYLIN_BROWSER_LOG", DEFAULTS.remoteLogPath),
    statePath: env("UST_KYLIN_DEVTOOLS_STATE", DEFAULTS.statePath)
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-kylin-devtools.cjs start",
    "  node scripts/remote-kylin-devtools.cjs check",
    "  node scripts/remote-kylin-devtools.cjs stop",
    "  node scripts/remote-kylin-devtools.cjs run -- <command> [args...]",
    "",
    "Environment:",
    "  UST_KYLIN_SSH_TARGET              Default: xyzn@192.168.1.137",
    "  UST_KYLIN_HOST                    Default: 192.168.1.137",
    "  UST_KYLIN_DEVTOOLS_MODE           Default: lan; use ssh-tunnel only when sshd allows forwarding",
    "  UST_KYLIN_DEVTOOLS_LOCAL_PORT     Default: 9225",
    "  UST_KYLIN_DEVTOOLS_REMOTE_PORT    Default: 9334",
    "  UST_REMOTE_DEBUG_URL              Default: http://192.168.1.137:9334 in lan mode",
    "  UST_KYLIN_FIREWALL_ALLOW_HOST      Default: 192.168.1.118",
    "  UST_KYLIN_SUDO_PASSWORD            Optional; enables temporary iptables allow rule in lan mode",
    "  UST_KYLIN_ALLOW_UNRESTRICTED_DEVTOOLS",
    "                                      Default: false; true permits LAN mode without firewall rule",
    "  UST_KYLIN_HEADLESS                Default: true",
    "  UST_KYLIN_DISPLAY                 Default: :0",
    "  UST_KYLIN_XAUTHORITY              Default: /home/xyzn/.Xauthority",
    "  UST_KYLIN_BROWSER_BIN             Default: kylin-browser",
    "  UST_KYLIN_LEGACY_BROWSER_USER_DATA_DIRS",
    "                                      Comma-separated old user-data dirs to clean up",
    "  UST_KYLIN_DEVTOOLS_STATE          Default: test-results/remote-kylin-devtools/state.json"
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function remoteBashCommand(script) {
  return `bash -lc ${shellQuote(script)}`;
}

function cleanupMarkers(config) {
  return [...new Set([config.remoteUserDataDir, ...config.legacyRemoteUserDataDirs].map((item) => path.posix.basename(item)))];
}

function processFilter(config) {
  const commands = cleanupMarkers(config)
    .map(
      (marker) => `
marker=${shellQuote(marker)}
self_pid=$$
parent_pid=$PPID
ps -eo pid=,ppid=,comm=,args= | awk -v marker="$marker" -v self="$self_pid" -v parent="$parent_pid" '$1 != self && $1 != parent && $0 ~ marker && $3 !~ /awk/ {print $1}' | sort -rn | xargs -r kill
`.trim()
    )
    .join("\n");
  return `(\n${commands}\n) >/dev/null 2>&1 || true`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkDevTools(config, options = {}) {
  const url = `${config.localDebugUrl.replace(/\/$/, "")}/json/version`;
  try {
    const version = await fetchJson(url, options.timeoutMs || 5000);
    return { ok: true, url, version };
  } catch (error) {
    return { ok: false, url, error: error.message };
  }
}

function ensureStateDir(config) {
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
}

function readState(config) {
  try {
    return JSON.parse(fs.readFileSync(config.statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(config, state) {
  ensureStateDir(config);
  fs.writeFileSync(config.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeState(config) {
  try {
    fs.rmSync(config.statePath, { force: true });
  } catch {}
}

function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 && result.stdout.includes(`"${pid}"`);
}

function killProcessTree(pid) {
  if (!pid || !Number.isInteger(Number(pid))) return false;
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0;
}

function remoteBrowserScript(config, options = {}) {
  const killBrowser = processFilter(config);
  const bindHost = options.bindHost || config.remoteHost;
  const keepAlive = Boolean(options.keepAlive);
  return `
set -eu
browser_bin=${shellQuote(config.browserBin)}
remote_host=${shellQuote(bindHost)}
remote_port=${shellQuote(config.remotePort)}
headless_value=${shellQuote(config.headless ? "true" : "false")}
display_value=${shellQuote(config.display)}
xauthority_value=${shellQuote(config.xauthority)}
user_data_dir=${shellQuote(config.remoteUserDataDir)}
log_path=${shellQuote(config.remoteLogPath)}
${killBrowser}
rm -rf "$user_data_dir"
mkdir -p "$user_data_dir"
if [ "$headless_value" = "true" ]; then
  headless_arg="--headless"
else
  headless_arg=""
  export DISPLAY="$display_value"
  export XAUTHORITY="$xauthority_value"
fi
nohup "$browser_bin" \
  $headless_arg \
  --remote-debugging-address="$remote_host" \
  --remote-debugging-port="$remote_port" \
  --remote-allow-origins="*" \
  --user-data-dir="$user_data_dir" \
  --no-first-run \
  --no-default-browser-check \
  --disable-gpu \
  about:blank >"$log_path" 2>&1 &
deadline=$((SECONDS + 20))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl -sS "http://$remote_host:$remote_port/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! curl -sS "http://$remote_host:$remote_port/json/version" >/dev/null 2>&1; then
  cat "$log_path" >&2 || true
  exit 1
fi
${keepAlive ? "while true; do sleep 60; done" : ""}
`.trim();
}

function remoteCleanupScript(config) {
  return processFilter(config);
}

function spawnTunnel(config) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=2",
    "-L",
    `${config.localHost}:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
    config.sshTarget,
    remoteBashCommand(remoteBrowserScript(config, { bindHost: config.remoteHost, keepAlive: true }))
  ];
  const child = spawn("ssh", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  if (!child.pid) throw new Error("failed to start ssh tunnel process");
  child.unref();
  return child.pid;
}

function runRemoteBrowserStart(config) {
  return spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", config.sshTarget, remoteBashCommand(remoteBrowserScript(config, { bindHost: "0.0.0.0" }))], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
}

function runRemoteFirewall(config, action) {
  if (!config.sudoPassword) return { status: 0, skipped: true, stderr: "" };
  const flag = action === "add" ? "-I KSC_IN_PUBLIC_ALLOW 1" : "-D KSC_IN_PUBLIC_ALLOW";
  const command = [
    `echo ${shellQuote(config.sudoPassword)} | sudo -S iptables ${flag}`,
    `-s ${shellQuote(`${config.firewallAllowHost}/32`)}`,
    "-p tcp",
    `--dport ${shellQuote(config.remotePort)}`,
    "-j ACCEPT"
  ].join(" ");
  return spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", config.sshTarget, remoteBashCommand(command)], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
}

async function waitForReady(config, timeoutMs = 25000) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await checkDevTools(config, { timeoutMs: 2500 });
    if (last.ok) return last;
    await sleep(500);
  }
  throw new Error(`DevTools did not become ready at ${config.localDebugUrl}: ${last?.error || "timeout"}`);
}

async function start(config) {
  const existing = await checkDevTools(config, { timeoutMs: 1500 });
  if (existing.ok) {
    const state = readState(config);
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "start",
          alreadyRunning: true,
          localDebugUrl: config.localDebugUrl,
          statePath: config.statePath,
          sshPid: state?.sshPid || null,
          browser: existing.version.Browser
        },
        null,
        2
      )
    );
    return;
  }

  const previousState = readState(config);
  if (previousState?.sshPid && isProcessRunning(previousState.sshPid)) {
    killProcessTree(previousState.sshPid);
  }

  let sshPid = null;
  let firewallRuleAdded = false;
  if (config.mode === "ssh-tunnel") {
    sshPid = spawnTunnel(config);
  } else if (config.mode === "lan") {
    if (!config.sudoPassword && !config.allowUnrestrictedLan) {
      throw new Error(
        "lan mode requires UST_KYLIN_SUDO_PASSWORD for a temporary restricted firewall rule; " +
          "set UST_KYLIN_ALLOW_UNRESTRICTED_DEVTOOLS=true only in an isolated test LAN"
      );
    }
    const started = runRemoteBrowserStart(config);
    if (started.status !== 0) {
      throw new Error(`remote browser start failed: ${(started.stderr || started.stdout || "").trim()}`);
    }
    const firewall = runRemoteFirewall(config, "add");
    firewallRuleAdded = !firewall.skipped && firewall.status === 0;
    if (!firewall.skipped && firewall.status !== 0) {
      throw new Error(`temporary firewall allow failed: ${(firewall.stderr || firewall.stdout || "").trim()}`);
    }
  } else {
    throw new Error(`unsupported UST_KYLIN_DEVTOOLS_MODE: ${config.mode}`);
  }

  writeState(config, {
    sshPid,
    startedAt: new Date().toISOString(),
    localDebugUrl: config.localDebugUrl,
    sshTarget: config.sshTarget,
    mode: config.mode,
    remoteLanHost: config.remoteLanHost,
    remoteHost: config.remoteHost,
    remotePort: config.remotePort,
    localHost: config.localHost,
    localPort: config.localPort,
    firewallRuleAdded,
    firewallAllowHost: config.firewallAllowHost,
    headless: config.headless,
    display: config.display,
    xauthority: config.xauthority,
    browserBin: config.browserBin,
    remoteUserDataDir: config.remoteUserDataDir
  });

  const ready = await waitForReady(config);
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "start",
        alreadyRunning: false,
        localDebugUrl: config.localDebugUrl,
        statePath: config.statePath,
        sshPid,
        mode: config.mode,
        firewallRuleAdded,
        browser: ready.version.Browser
      },
      null,
      2
    )
  );
}

function runRemoteCleanup(config) {
  return spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", config.sshTarget, remoteBashCommand(remoteCleanupScript(config))], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
}

function stop(config) {
  const state = readState(config);
  let localStopped = false;
  if (state?.sshPid && isProcessRunning(state.sshPid)) {
    localStopped = killProcessTree(state.sshPid);
  }
  const cleanup = runRemoteCleanup(config);
  let firewallRuleRemoved = false;
  if (state?.firewallRuleAdded || (config.mode === "lan" && config.sudoPassword)) {
    const firewall = runRemoteFirewall(config, "delete");
    firewallRuleRemoved = firewall.status === 0;
  }
  removeState(config);
  console.log(
    JSON.stringify(
      {
        ok: cleanup.status === 0,
        action: "stop",
        localStopped,
        firewallRuleRemoved,
        remoteCleanupExitCode: cleanup.status,
        statePath: config.statePath,
        stderr: cleanup.status === 0 ? "" : cleanup.stderr.trim()
      },
      null,
      2
    )
  );
  const exitCode = cleanup.status === 0 ? 0 : cleanup.status || 1;
  if (exitCode !== 0) process.exitCode = exitCode;
  return exitCode;
}

async function check(config) {
  const result = await checkDevTools(config);
  const state = readState(config);
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        action: "check",
        localDebugUrl: config.localDebugUrl,
        statePath: config.statePath,
        sshPid: state?.sshPid || null,
        sshPidRunning: state?.sshPid ? isProcessRunning(state.sshPid) : false,
        browser: result.version?.Browser || "",
        error: result.ok ? "" : result.error
      },
      null,
      2
    )
  );
  if (!result.ok) process.exitCode = 1;
}

function runCommand(config, commandArgs) {
  if (!commandArgs.length) {
    throw new Error("run requires a command after --");
  }
  let [command, ...args] = commandArgs;
  if (process.platform === "win32") {
    command = "cmd.exe";
    args = ["/d", "/s", "/c", ...commandArgs];
  }
  const child = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      UST_REMOTE_DEBUG_URL: config.localDebugUrl
    },
    stdio: "inherit",
    windowsHide: false
  });
  if (child.error) {
    console.error(child.error.message);
    return 1;
  }
  return child.status ?? (child.signal ? 1 : 0);
}

function parse(argv) {
  const separatorIndex = argv.indexOf("--");
  const commandArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];
  const ownArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const action = ownArgs[0] || "help";
  return { action, commandArgs };
}

async function main(argv) {
  const { action, commandArgs } = parse(argv);
  const config = configFromEnv();
  if (action === "help" || action === "--help" || action === "-h") {
    console.log(usage());
    return;
  }
  if (action === "start") {
    await start(config);
    return;
  }
  if (action === "check") {
    await check(config);
    return;
  }
  if (action === "stop") {
    stop(config);
    return;
  }
  if (action === "run") {
    await start(config);
    const exitCode = runCommand(config, commandArgs);
    const stopExitCode = stop(config);
    process.exitCode = exitCode || stopExitCode;
    return;
  }
  throw new Error(`unknown action: ${action}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`Remote Kylin DevTools failed: ${error.message}`);
  process.exit(1);
});
