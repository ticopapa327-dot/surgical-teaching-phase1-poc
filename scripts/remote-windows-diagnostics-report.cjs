const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULTS = {
  artifactDir: path.join("test-results", "remote-windows-media-smoke")
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-windows-diagnostics-report.cjs [snapshot-a.json snapshot-b.json ...]",
    "",
    "Options:",
    "  --artifact-dir <dir>    Find the latest remote media snapshot pair in this directory",
    "  --output <csv>          Write CSV report to this path",
    "  --allow-non-publisher-runtime-warn",
    "                          Downgrade receiver-side insecure capture warnings to INFO",
    "  --no-fail-on-warn      Do not fail when the analyzer emits WARN lines",
    "  --help                 Show this help",
    "",
    "Environment:",
    "  UST_REMOTE_ARTIFACT_DIR       Default artifact directory",
    "  UST_REMOTE_DIAGNOSTIC_CSV     Default CSV output path"
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    artifactDir: env("UST_REMOTE_ARTIFACT_DIR", DEFAULTS.artifactDir),
    outputPath: env("UST_REMOTE_DIAGNOSTIC_CSV", ""),
    failOnWarn: true,
    allowNonPublisherRuntimeWarn: false,
    snapshotPaths: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      options.help = true;
    } else if (item === "--artifact-dir") {
      index += 1;
      if (!argv[index]) throw new Error("--artifact-dir requires a directory path");
      options.artifactDir = argv[index];
    } else if (item.startsWith("--artifact-dir=")) {
      options.artifactDir = item.slice("--artifact-dir=".length);
    } else if (item === "--output") {
      index += 1;
      if (!argv[index]) throw new Error("--output requires a CSV file path");
      options.outputPath = argv[index];
    } else if (item.startsWith("--output=")) {
      options.outputPath = item.slice("--output=".length);
    } else if (item === "--allow-non-publisher-runtime-warn") {
      options.allowNonPublisherRuntimeWarn = true;
    } else if (item === "--no-fail-on-warn") {
      options.failOnWarn = false;
    } else if (item.startsWith("-")) {
      throw new Error(`unknown option: ${item}`);
    } else {
      options.snapshotPaths.push(item);
    }
  }

  return options;
}

function requireFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`snapshot file does not exist: ${filePath}`);
  }
}

function pairKey(fileName, kind) {
  const pattern = kind === "or" ? /^(.+)-or-[^.]+\.json$/ : /^(.+)-teach-[^.]+\.json$/;
  const match = fileName.match(pattern);
  return match ? match[1] : null;
}

function findLatestSnapshotPair(artifactDir) {
  if (!fs.existsSync(artifactDir) || !fs.statSync(artifactDir).isDirectory()) {
    throw new Error(`artifact directory does not exist: ${artifactDir}`);
  }

  const pairs = new Map();
  for (const entry of fs.readdirSync(artifactDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const localKey = pairKey(entry.name, "or");
    const remoteKey = pairKey(entry.name, "teach");
    if (!localKey && !remoteKey) continue;

    const key = localKey || remoteKey;
    const filePath = path.join(artifactDir, entry.name);
    const stat = fs.statSync(filePath);
    const pair = pairs.get(key) || { key, mtimeMs: 0 };
    pair.mtimeMs = Math.max(pair.mtimeMs, stat.mtimeMs);
    if (localKey) pair.localSnapshotPath = filePath;
    if (remoteKey) pair.remoteSnapshotPath = filePath;
    pairs.set(key, pair);
  }

  const completePairs = [...pairs.values()]
    .filter((pair) => pair.localSnapshotPath && pair.remoteSnapshotPath)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!completePairs.length) {
    throw new Error(`no complete remote media snapshot pair found in ${artifactDir}`);
  }

  return completePairs[0];
}

function defaultOutputPath(options, pair) {
  if (options.outputPath) return options.outputPath;
  if (pair?.key) return path.join(options.artifactDir, `${pair.key}-diagnostics.csv`);
  const suffix = Date.now().toString(36).slice(-6);
  return path.join(options.artifactDir, `${suffix}-diagnostics.csv`);
}

function runNodeScript(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) {
    if (result.stdout.trim()) console.log(result.stdout.trim());
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function writeCsv(snapshotPaths, outputPath) {
  const csv = runNodeScript(["scripts/summarize-diagnostics.cjs", ...snapshotPaths], "diagnostic CSV summary");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv.endsWith("\n") ? csv : `${csv}\n`, "utf8");
}

function runAnalyzer(snapshotPaths, options) {
  const args = [
    "scripts/analyze-diagnostics.cjs",
    "--allow-receive-only-runtime-warn",
    ...(options.allowNonPublisherRuntimeWarn ? ["--allow-non-publisher-runtime-warn"] : []),
    ...(options.failOnWarn ? ["--fail-on-warn"] : []),
    ...snapshotPaths
  ];
  const output = runNodeScript(args, "diagnostic analyzer").trim();
  if (output) console.log(output);
  return output.split(/\r?\n/).filter(Boolean);
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  let pair = null;
  let snapshotPaths = options.snapshotPaths;
  if (!snapshotPaths.length) {
    pair = findLatestSnapshotPair(options.artifactDir);
    snapshotPaths = [pair.localSnapshotPath, pair.remoteSnapshotPath];
  }

  snapshotPaths.forEach(requireFile);
  const outputPath = defaultOutputPath(options, pair);

  writeCsv(snapshotPaths, outputPath);
  const analyzerLines = runAnalyzer(snapshotPaths, options);

  console.log(
    JSON.stringify(
      {
        ok: true,
        snapshotPaths,
        csvPath: outputPath,
        failOnWarn: options.failOnWarn,
        allowNonPublisherRuntimeWarn: options.allowNonPublisherRuntimeWarn,
        analyzerLines
      },
      null,
      2
    )
  );
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Remote Windows diagnostics report failed: ${error.message}`);
  process.exit(1);
}
