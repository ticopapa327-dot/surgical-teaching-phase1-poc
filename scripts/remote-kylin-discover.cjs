const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  knownHost: "192.168.1.137",
  knownHostsPath: path.join(os.homedir(), ".ssh", "known_hosts"),
  subnet: "192.168.1.0/24",
  localAddress: "192.168.1.118",
  sshUser: "xyzn",
  port: 22,
  timeoutMs: 600,
  concurrency: 64,
  artifactDir: path.join("test-results", "remote-kylin-discovery")
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function envAllowEmpty(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? String(process.env[name]).trim()
    : String(fallback).trim();
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function parsePositiveInteger(value, fallback, name) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function parseHostPattern(pattern) {
  const text = String(pattern || "").trim();
  const match = text.match(/^\[([^\]]+)\]:(\d+)$/);
  if (match) return { host: match[1], port: Number(match[2]) };
  return { host: text, port: null };
}

function hostPatternMatches(pattern, host, port) {
  const parsed = parseHostPattern(pattern);
  if (parsed.host !== host) return false;
  return parsed.port === null ? Number(port) === 22 : parsed.port === Number(port);
}

function fingerprintKey(keyBase64) {
  const digest = crypto.createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

function parseKnownHostsText(text, knownHost, port = 22) {
  const records = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("@revoked ")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostsText, keyType, keyBase64] = parts;
    const hosts = hostsText.split(",");
    if (!hosts.some((host) => hostPatternMatches(host, knownHost, port))) continue;
    records.push({
      hosts,
      keyType,
      keyBase64,
      fingerprint: fingerprintKey(keyBase64)
    });
  }
  return records;
}

function parseKeyscanText(text) {
  const records = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostText, keyType, keyBase64] = parts;
    records.push({
      hostText,
      keyType,
      keyBase64,
      fingerprint: fingerprintKey(keyBase64)
    });
  }
  return records;
}

function ipToNumber(ip) {
  const parts = String(ip).split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return parts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
}

function numberToIp(number) {
  return [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join(".");
}

function hostsFromCidr(cidr) {
  const [ipText, prefixText] = String(cidr || "").split("/");
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 24 || prefix > 30) {
    throw new Error("--subnet only supports IPv4 CIDR prefixes from /24 to /30");
  }
  const base = ipToNumber(ipText);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = base & mask;
  const broadcast = network | (~mask >>> 0);
  const hosts = [];
  for (let value = network + 1; value < broadcast; value += 1) {
    hosts.push(numberToIp(value >>> 0));
  }
  return hosts;
}

function probeTcp(host, port, localAddress, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok, error = "") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ host, ok, error });
    };
    socket.setTimeout(timeoutMs, () => done(false, "timeout"));
    socket.once("error", (error) => done(false, error.code || error.message));
    const connectOptions = { host, port };
    if (localAddress) connectOptions.localAddress = localAddress;
    socket.connect(connectOptions, () => done(true));
  });
}

async function scanTcp(hosts, options) {
  const candidates = [];
  let next = 0;
  async function worker() {
    while (next < hosts.length) {
      const host = hosts[next];
      next += 1;
      const result = await probeTcp(host, options.port, options.localAddress, options.timeoutMs);
      if (result.ok) candidates.push(host);
    }
  }
  const workers = Array.from({ length: Math.min(options.concurrency, hosts.length) }, () => worker());
  await Promise.all(workers);
  return candidates.sort((a, b) => ipToNumber(a) - ipToNumber(b));
}

function scanKeys(host, options) {
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  const result = spawnSync(
    "ssh-keyscan",
    ["-T", String(timeoutSeconds), "-p", String(options.port), host],
    {
      encoding: "utf8",
      timeout: Math.max(3000, timeoutSeconds * 2500),
      windowsHide: true
    }
  );
  return {
    host,
    status: result.status,
    error: result.error?.message || "",
    stderr: String(result.stderr || "").trim(),
    keys: parseKeyscanText(result.stdout)
  };
}

function compareKeys(candidateKeys, expectedKeys) {
  const expected = new Set(expectedKeys.map((key) => `${key.keyType} ${key.keyBase64}`));
  const matched = candidateKeys.filter((key) => expected.has(`${key.keyType} ${key.keyBase64}`));
  return {
    ok: matched.length > 0,
    matchedKeyTypes: matched.map((key) => key.keyType),
    matchedFingerprints: matched.map((key) => key.fingerprint)
  };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeArtifact(report, artifactDir) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, `${nowStamp()}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return artifactPath;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-kylin-discover.cjs [options]",
    "",
    "Options:",
    "  --subnet <cidr>            Scan IPv4 CIDR, /24 to /30 only",
    "  --known-host <host>        Host entry to match in known_hosts",
    "  --known-hosts <path>       known_hosts file path",
    "  --local-address <ip>       Bind TCP probes to this local address; empty disables binding",
    "  --port <port>              SSH port",
    "  --timeout-ms <ms>          Per-host TCP timeout",
    "  --concurrency <count>      TCP scan concurrency",
    "  --no-write                 Do not write discovery artifact",
    "  --help                     Show this help",
    "",
    "Environment:",
    "  UST_KYLIN_DISCOVERY_SUBNET       Default: 192.168.1.0/24",
    "  UST_KYLIN_DISCOVERY_KNOWN_HOST   Default: 192.168.1.137",
    "  UST_KYLIN_KNOWN_HOSTS_PATH       Default: ~/.ssh/known_hosts",
    "  UST_KYLIN_SSH_BIND_ADDRESS       Default: 192.168.1.118; set empty to let the OS choose",
    "  UST_KYLIN_SSH_TARGET             Used for suggested user, default xyzn@192.168.1.137"
  ].join("\n");
}

function parseArgs(argv) {
  const sshTarget = env("UST_KYLIN_SSH_TARGET", `${DEFAULTS.sshUser}@${DEFAULTS.knownHost}`);
  const sshUser = sshTarget.includes("@") ? sshTarget.split("@")[0] : DEFAULTS.sshUser;
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    noWrite: argv.includes("--no-write"),
    knownHost:
      readArg(argv, "--known-host") || env("UST_KYLIN_DISCOVERY_KNOWN_HOST", DEFAULTS.knownHost),
    knownHostsPath:
      readArg(argv, "--known-hosts") || env("UST_KYLIN_KNOWN_HOSTS_PATH", DEFAULTS.knownHostsPath),
    subnet: readArg(argv, "--subnet") || env("UST_KYLIN_DISCOVERY_SUBNET", DEFAULTS.subnet),
    localAddress: readArg(argv, "--local-address") || envAllowEmpty("UST_KYLIN_SSH_BIND_ADDRESS", DEFAULTS.localAddress),
    sshUser,
    port: parsePositiveInteger(readArg(argv, "--port") || env("UST_KYLIN_DISCOVERY_PORT", DEFAULTS.port), DEFAULTS.port, "--port"),
    timeoutMs: parsePositiveInteger(
      readArg(argv, "--timeout-ms") || env("UST_KYLIN_DISCOVERY_TIMEOUT_MS", DEFAULTS.timeoutMs),
      DEFAULTS.timeoutMs,
      "--timeout-ms"
    ),
    concurrency: parsePositiveInteger(
      readArg(argv, "--concurrency") || env("UST_KYLIN_DISCOVERY_CONCURRENCY", DEFAULTS.concurrency),
      DEFAULTS.concurrency,
      "--concurrency"
    ),
    artifactDir: env("UST_KYLIN_DISCOVERY_ARTIFACT_DIR", DEFAULTS.artifactDir)
  };
}

async function buildDiscovery(options) {
  const knownHostsText = fs.existsSync(options.knownHostsPath)
    ? fs.readFileSync(options.knownHostsPath, "utf8")
    : "";
  const expectedKeys = parseKnownHostsText(knownHostsText, options.knownHost, options.port);
  const hosts = hostsFromCidr(options.subnet);
  const tcpCandidates = await scanTcp(hosts, options);
  const candidates = tcpCandidates.map((host) => {
    const keyscan = scanKeys(host, options);
    const comparison = compareKeys(keyscan.keys, expectedKeys);
    return {
      host,
      tcpOpen: true,
      keyscanStatus: keyscan.status,
      keyscanError: keyscan.error || keyscan.stderr,
      keyCount: keyscan.keys.length,
      fingerprints: keyscan.keys.map((key) => ({ keyType: key.keyType, fingerprint: key.fingerprint })),
      keyMatchesKnownHost: comparison.ok,
      matchedKeyTypes: comparison.matchedKeyTypes,
      matchedFingerprints: comparison.matchedFingerprints,
      suggestedSshTarget: comparison.ok ? `${options.sshUser}@${host}` : ""
    };
  });
  const matches = candidates.filter((candidate) => candidate.keyMatchesKnownHost);
  return {
    ok: matches.length > 0,
    generatedAt: new Date().toISOString(),
    config: {
      knownHost: options.knownHost,
      knownHostsPath: options.knownHostsPath,
      subnet: options.subnet,
      localAddress: options.localAddress,
      port: options.port,
      timeoutMs: options.timeoutMs,
      concurrency: options.concurrency
    },
    expectedKnownHostKeys: expectedKeys.map((key) => ({
      keyType: key.keyType,
      fingerprint: key.fingerprint
    })),
    tcpCandidateCount: tcpCandidates.length,
    matchCount: matches.length,
    recommendedTargets: matches.map((candidate) => candidate.suggestedSshTarget),
    candidates,
    warnings: expectedKeys.length ? [] : [`no known host keys found for ${options.knownHost}`]
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await buildDiscovery(options);
  if (!options.noWrite) {
    report.artifactPath = writeArtifact(report, options.artifactDir);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Kylin discovery failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  compareKeys,
  fingerprintKey,
  hostsFromCidr,
  parseKeyscanText,
  parseKnownHostsText
};
