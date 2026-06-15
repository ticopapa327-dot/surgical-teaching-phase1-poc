const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULTS = {
  reportDir: path.join("validation-results", "local-118-validation"),
  outputPath: path.join("validation-results", "local-118-validation", "status.json"),
  maxAgeMinutes: 720,
  preferredAddress: "192.168.1.118",
  cpuMaxPercent: 80,
  profile: "full"
};

const REQUIRED_STEPS = {
  full: ["build", "script-tests", "ui-smoke", "signaling-contract"],
  quick: ["script-tests"]
};

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function parseNonNegativeNumber(value, fallback, name) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return number;
}

function normalizeProfile(value) {
  const profile = String(value || DEFAULTS.profile).trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(REQUIRED_STEPS, profile)) {
    throw new Error("--profile must be full or quick");
  }
  return profile;
}

function defaultOutputPath(profile) {
  if (profile === "quick") {
    return path.join(DEFAULTS.reportDir, "status-quick.json");
  }
  return DEFAULTS.outputPath;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/local-118-status.cjs [options]",
    "",
    "Options:",
    "  --profile <full|quick>        full requires build/scripts/smoke/signaling; quick requires script-tests",
    "  --json                        Print full status JSON",
    "  --no-write                    Do not write status.json",
    "  --max-age-minutes <minutes>   Fail when latest matching report is older than this; 0 disables",
    "  --cpu-max-percent <percent>   Fail when sampled CPU load exceeds this; default 80",
    "  --preferred-address <address> Fail when this address is absent; default 192.168.1.118",
    "  --help                        Show this help",
    "",
    "Environment:",
    "  UST_LOCAL_118_REPORT_DIR            Default validation report directory",
    "  UST_LOCAL_118_STATUS_PATH           Default status JSON output path",
    "  UST_LOCAL_118_STATUS_PROFILE        full or quick",
    "  UST_LOCAL_118_STATUS_MAX_AGE_MINUTES Default freshness limit",
    "  UST_LOCAL_118_CPU_MAX_PERCENT       Default CPU load ceiling",
    "  UST_LOCAL_118_PREFERRED_ADDRESS     Default 192.168.1.118"
  ].join("\n");
}

function parseArgs(argv) {
  const profile = normalizeProfile(readArg(argv, "--profile") || env("UST_LOCAL_118_STATUS_PROFILE", DEFAULTS.profile));
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json"),
    noWrite: argv.includes("--no-write"),
    profile,
    reportDir: path.resolve(env("UST_LOCAL_118_REPORT_DIR", DEFAULTS.reportDir)),
    outputPath: path.resolve(env("UST_LOCAL_118_STATUS_PATH", defaultOutputPath(profile))),
    maxAgeMinutes: parseNonNegativeNumber(
      readArg(argv, "--max-age-minutes") || env("UST_LOCAL_118_STATUS_MAX_AGE_MINUTES", DEFAULTS.maxAgeMinutes),
      DEFAULTS.maxAgeMinutes,
      "--max-age-minutes"
    ),
    cpuMaxPercent: parseNonNegativeNumber(
      readArg(argv, "--cpu-max-percent") || env("UST_LOCAL_118_CPU_MAX_PERCENT", DEFAULTS.cpuMaxPercent),
      DEFAULTS.cpuMaxPercent,
      "--cpu-max-percent"
    ),
    preferredAddress:
      readArg(argv, "--preferred-address") ||
      env("UST_LOCAL_118_PREFERRED_ADDRESS", DEFAULTS.preferredAddress)
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(textOrBuffer) {
  return crypto.createHash("sha256").update(textOrBuffer).digest("hex");
}

function readChecksum(reportPath) {
  const checksumPath = reportPath.replace(/\.json$/i, ".sha256");
  if (!fs.existsSync(checksumPath)) {
    return { ok: false, checksumPath, expected: "", actual: "", error: "local report checksum file missing" };
  }
  const expected = fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0] || "";
  const actual = sha256(fs.readFileSync(reportPath));
  return {
    ok: expected.toLowerCase() === actual.toLowerCase(),
    checksumPath,
    expected,
    actual,
    error: expected.toLowerCase() === actual.toLowerCase() ? "" : "local report checksum mismatch"
  };
}

function requiredSteps(profile) {
  return REQUIRED_STEPS[profile] || REQUIRED_STEPS.full;
}

function stepStatus(report, profile) {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const required = requiredSteps(profile);
  const missing = required.filter((id) => !byId.has(id));
  const failed = steps.filter((step) => step.ok === false).map((step) => step.id);
  const planned = steps.filter((step) => step.planned === true).map((step) => step.id);
  const requiredNotPassed = required.filter((id) => byId.get(id)?.ok !== true);
  return {
    ok: missing.length === 0 && failed.length === 0 && planned.length === 0 && requiredNotPassed.length === 0,
    required,
    missing,
    failed,
    planned,
    requiredNotPassed,
    count: steps.length
  };
}

function reportMatchesProfile(report, profile) {
  const status = stepStatus(report, profile);
  return status.missing.length === 0;
}

function collectReports(reportDir, profile) {
  if (!fs.existsSync(reportDir) || !fs.statSync(reportDir).isDirectory()) return [];
  return fs
    .readdirSync(reportDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => entry.name !== "status.json")
    .map((entry) => {
      const reportPath = path.join(reportDir, entry.name);
      try {
        const report = readJson(reportPath);
        return { reportPath, report, checksum: readChecksum(reportPath) };
      } catch (error) {
        return { reportPath, report: null, checksum: null, error: error.message };
      }
    })
    .filter((item) => item.report?.schema === "ust-local-118-validation-v1")
    .filter((item) => reportMatchesProfile(item.report, profile))
    .sort((left, right) =>
      String(right.report.finishedAt || right.report.startedAt || "").localeCompare(
        String(left.report.finishedAt || left.report.startedAt || "")
      )
    );
}

function ageStatus(finishedAt, maxAgeMinutes) {
  if (!maxAgeMinutes) {
    return { ok: true, disabled: true, ageMinutes: null, maxAgeMinutes, error: "" };
  }
  const finishedMs = Date.parse(finishedAt || "");
  if (!Number.isFinite(finishedMs)) {
    return { ok: false, disabled: false, ageMinutes: null, maxAgeMinutes, error: "latest local 118 report has no valid finishedAt" };
  }
  const ageMinutes = Math.max(0, (Date.now() - finishedMs) / 60000);
  return {
    ok: ageMinutes <= maxAgeMinutes,
    disabled: false,
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    maxAgeMinutes,
    error: ageMinutes <= maxAgeMinutes ? "" : "latest local 118 report is stale"
  };
}

function addressStatus(report, preferredAddress) {
  const addresses = Array.isArray(report?.network?.addresses) ? report.network.addresses : [];
  const matched = addresses.find((item) => item.address === preferredAddress) || null;
  return {
    ok: Boolean(matched),
    preferredAddress,
    matched,
    addresses: addresses.map((item) => ({ name: item.name, address: item.address, interfaceIndex: item.interfaceIndex })),
    error: matched ? "" : `preferred local address missing: ${preferredAddress}`
  };
}

function resourceStatus(report, cpuMaxPercent) {
  const before = report?.resources?.before || null;
  const after = report?.resources?.after || null;
  const samples = [
    { name: "before", sample: before },
    { name: "after", sample: after }
  ];
  const errors = [];
  for (const item of samples) {
    if (!item.sample?.ok) {
      errors.push(`${item.name} resource snapshot missing or failed`);
      continue;
    }
    const load = item.sample?.cpu?.loadPercent;
    if (Number.isFinite(load) && load > cpuMaxPercent) {
      errors.push(`${item.name} CPU load ${load}% exceeds ${cpuMaxPercent}%`);
    }
  }
  return {
    ok: errors.length === 0,
    cpuMaxPercent,
    before: before
      ? {
          ok: before.ok === true,
          capturedAt: before.capturedAt || "",
          cpuLoadPercent: before.cpu?.loadPercent ?? null,
          memoryFreeGiB: before.memory?.freeGiB ?? null
        }
      : null,
    after: after
      ? {
          ok: after.ok === true,
          capturedAt: after.capturedAt || "",
          cpuLoadPercent: after.cpu?.loadPercent ?? null,
          memoryFreeGiB: after.memory?.freeGiB ?? null
        }
      : null,
    errors
  };
}

function buildStatus(options) {
  const reports = collectReports(options.reportDir, options.profile);
  const latest = reports[0] || null;
  if (!latest) {
    return {
      ok: false,
      profile: options.profile,
      generatedAt: new Date().toISOString(),
      reportDir: options.reportDir,
      failures: [`no local 118 ${options.profile} report found`],
      latestReport: null
    };
  }

  const report = latest.report;
  const steps = stepStatus(report, options.profile);
  const age = ageStatus(report.finishedAt || report.startedAt || "", options.maxAgeMinutes);
  const address = addressStatus(report, options.preferredAddress);
  const resources = resourceStatus(report, options.cpuMaxPercent);

  const failures = [];
  if (!latest.checksum?.ok) failures.push(latest.checksum?.error || "local report checksum invalid");
  if (!report.ok) failures.push("latest local 118 report result is not ok");
  if (report.dryRun) failures.push("latest local 118 report is a dry run");
  if (!steps.ok) failures.push("latest local 118 report did not pass every required step");
  if (!address.ok) failures.push(address.error);
  if (!resources.ok) failures.push(...resources.errors);
  if (!age.ok) failures.push(age.error);

  return {
    ok: failures.length === 0,
    profile: options.profile,
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    failures,
    freshness: age,
    latestReport: {
      id: path.basename(latest.reportPath, ".json"),
      reportPath: latest.reportPath,
      startedAt: report.startedAt || "",
      finishedAt: report.finishedAt || "",
      ok: report.ok === true,
      dryRun: report.dryRun === true,
      checksum: latest.checksum,
      host: report.host || {},
      steps,
      address,
      resources
    }
  };
}

function writeStatus(status, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const status = buildStatus(options);
  if (!options.noWrite) writeStatus(status, options.outputPath);
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          ok: status.ok,
          profile: status.profile,
          outputPath: options.noWrite ? "" : options.outputPath,
          latestReport: status.latestReport?.id || "",
          failures: status.failures
        },
        null,
        2
      )
    );
  }
  if (!status.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`local-118-status failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  addressStatus,
  buildStatus,
  collectReports,
  parseArgs,
  resourceStatus,
  stepStatus
};
