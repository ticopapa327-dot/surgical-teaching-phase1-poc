const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  sshTarget: "xyzn@192.168.1.137",
  webUrl: "http://192.168.1.118:5173/",
  signalingHealthUrl: "http://192.168.1.118:7077/health",
  sshTimeoutMs: "15000"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function stripLoginBanner(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && line.trim() !== "Kylin V10 SP1")
    .join("\n")
    .trim();
}

function runSsh(config, command, options = {}) {
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", config.sshTarget, command],
    {
      encoding: "utf8",
      timeout: options.timeoutMs || Number(config.sshTimeoutMs),
      windowsHide: true
    }
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: stripLoginBanner(result.stdout),
    stderr: stripLoginBanner(result.stderr),
    error: result.error?.message || ""
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function commandValue(result) {
  return result.stdout || result.stderr || result.error || "";
}

function configFromEnv() {
  return {
    sshTarget: env("UST_KYLIN_SSH_TARGET", DEFAULTS.sshTarget),
    webUrl: env("UST_KYLIN_WEB_URL", DEFAULTS.webUrl),
    signalingHealthUrl: env("UST_KYLIN_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    sshTimeoutMs: env("UST_KYLIN_SSH_TIMEOUT_MS", DEFAULTS.sshTimeoutMs)
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-kylin-probe.cjs",
    "",
    "Environment:",
    "  UST_KYLIN_SSH_TARGET             Default: xyzn@192.168.1.137",
    "  UST_KYLIN_WEB_URL                Default: http://192.168.1.118:5173/",
    "  UST_KYLIN_SIGNALING_HEALTH_URL   Default: http://192.168.1.118:7077/health",
    "  UST_KYLIN_SSH_TIMEOUT_MS         Default: 15000"
  ].join("\n");
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const config = configFromEnv();
  const ssh = runSsh(config, "uname -a");
  const webStatus = ssh.ok
    ? runSsh(config, `curl -sS -o /dev/null -w '%{http_code}' ${config.webUrl}`)
    : { ok: false, stdout: "", stderr: "ssh_unavailable" };
  const signalingHealth = ssh.ok
    ? runSsh(config, `curl -sS ${config.signalingHealthUrl}`)
    : { ok: false, stdout: "", stderr: "ssh_unavailable" };
  const browserPath = ssh.ok ? runSsh(config, "which kylin-browser") : { ok: false, stdout: "" };
  const browserVersion = ssh.ok
    ? runSsh(config, "kylin-browser --version 2>&1 | head -n 1")
    : { ok: false, stdout: "" };
  const runtime = ssh.ok
    ? runSsh(
        config,
        [
          "printf 'node='; which node 2>/dev/null || true; printf '\\n'",
          "printf 'nodeVersion='; node -v 2>/dev/null || true; printf '\\n'",
          "printf 'npm='; which npm 2>/dev/null || true; printf '\\n'",
          "printf 'npmVersion='; npm -v 2>/dev/null || true; printf '\\n'",
          "printf 'python3='; which python3 2>/dev/null || true; printf '\\n'",
          "printf 'python3Version='; python3 --version 2>&1 || true; printf '\\n'",
          "printf 'curl='; which curl 2>/dev/null || true; printf '\\n'",
          "printf 'curlVersion='; curl --version 2>/dev/null | head -n 1 || true; printf '\\n'"
        ].join("; ")
      )
    : { ok: false, stdout: "" };
  const desktop = ssh.ok
    ? runSsh(
        config,
        "printf 'DISPLAY='; printenv DISPLAY || true; printf '\\n'; ps -ef | grep -Ei 'kylin-browser|chrome|chromium|firefox' | grep -v grep | head -n 10"
      )
    : { ok: false, stdout: "" };

  const healthJson = parseJson(signalingHealth.stdout);
  const statusCode = Number(webStatus.stdout);
  const warnings = [];
  if (!runtime.stdout.includes("node=/")) warnings.push("node_not_found_on_kylin");
  if (!desktop.stdout.includes("DISPLAY=") || desktop.stdout.trim() === "DISPLAY=") {
    warnings.push("display_not_exported_in_ssh_session");
  }

  const ok =
    ssh.ok &&
    Number.isInteger(statusCode) &&
    statusCode >= 200 &&
    statusCode < 400 &&
    Boolean(healthJson?.ok) &&
    Boolean(browserPath.stdout);

  console.log(
    JSON.stringify(
      {
        ok,
        config,
        checks: {
          ssh: {
            ok: ssh.ok,
            value: commandValue(ssh)
          },
          web: {
            ok: Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 400,
            statusCode,
            stderr: webStatus.stderr
          },
          signalingHealth: {
            ok: Boolean(healthJson?.ok),
            value: healthJson || commandValue(signalingHealth)
          },
          browser: {
            ok: Boolean(browserPath.stdout),
            path: browserPath.stdout,
            version: commandValue(browserVersion)
          },
          runtime: runtime.stdout,
          desktop: desktop.stdout
        },
        warnings
      },
      null,
      2
    )
  );

  if (!ok) process.exitCode = 1;
}

main(process.argv.slice(2));
