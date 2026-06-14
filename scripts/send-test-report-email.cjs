const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_TO = "2012@mvbs.com.cn";
const DEFAULT_REPORT_DIR = path.join("validation-results", "cross-machine-validation");
const DEFAULT_MAILER = "C:\\Users\\wangm\\.codex\\tools\\send-default-mail.ps1";

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return argv[index + 1] || "";
}

function readRepeatedArgs(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function usage() {
  return [
    "Usage:",
    "  node scripts/send-test-report-email.cjs [options]",
    "",
    "Options:",
    "  --report <path>       Report file or directory; defaults to validation-results/cross-machine-validation",
    "  --subject <text>      Mail subject",
    "  --body <text>         Mail body override; defaults to the report text",
    "  --to <address>        Recipient; defaults to 2012@mvbs.com.cn",
    "  --attach <path>       Extra attachment; can be repeated",
    "  --dry-run             Validate input and print the send plan without sending",
    "  --help                Show this help",
    "",
    "Environment:",
    "  UST_TEST_REPORT_PATH           Default report file or directory",
    "  UST_TEST_REPORT_TO             Recipient override",
    "  UST_TEST_REPORT_SUBJECT        Subject override",
    "  UST_TEST_REPORT_BODY_MAX_CHARS Body truncation limit; default 30000",
    "  UST_TEST_REPORT_MAILER_SCRIPT  Mailer script override; default C:\\Users\\wangm\\.codex\\tools\\send-default-mail.ps1",
    "  UST_TEST_REPORT_EMAIL_TIMEOUT_MS Mailer timeout; default 120000",
    "",
    "Transport:",
    "  Uses the machine-level default outbound mailer backed by the sh-medvision.com server-local SMTP config.",
    "  Do not place SMTP passwords in this project."
  ].join("\n");
}

function parseRecipient(value) {
  const recipients = String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!recipients.length) {
    throw new Error("recipient address is required");
  }
  if (recipients.length > 1) {
    throw new Error("The default mailer supports one recipient per send; run the command once per recipient");
  }
  return recipients[0];
}

function newestFile(files) {
  return files
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath || "";
}

function chooseReportFile(reportPath) {
  const absolutePath = path.resolve(reportPath || DEFAULT_REPORT_DIR);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Report path does not exist: ${absolutePath}`);
  }
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return absolutePath;
  if (!stat.isDirectory()) {
    throw new Error(`Report path is neither a file nor a directory: ${absolutePath}`);
  }

  const preferred = [
    path.join(absolutePath, "status.md"),
    path.join(absolutePath, "index.md"),
    path.join(absolutePath, "summary.md")
  ].find((filePath) => fs.existsSync(filePath));
  if (preferred) return preferred;

  const entries = fs
    .readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(absolutePath, entry.name));
  const markdown = newestFile(entries.filter((filePath) => filePath.toLowerCase().endsWith(".md")));
  if (markdown) return markdown;
  const json = newestFile(entries.filter((filePath) => filePath.toLowerCase().endsWith(".json")));
  if (json) return json;
  throw new Error(`No .md or .json report found in: ${absolutePath}`);
}

function readReportBody(reportFile) {
  const text = fs.readFileSync(reportFile, "utf8");
  const maxLength = Number(env("UST_TEST_REPORT_BODY_MAX_CHARS", "30000"));
  if (!Number.isFinite(maxLength) || maxLength < 1000) {
    throw new Error("UST_TEST_REPORT_BODY_MAX_CHARS must be at least 1000");
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[truncated: original report length ${text.length} chars]`;
}

function resolveAttachments(reportFile, attachmentArgs) {
  const attachments = [reportFile, ...attachmentArgs.map((item) => path.resolve(item))];
  const unique = [...new Set(attachments)];
  for (const attachment of unique) {
    if (!fs.existsSync(attachment)) {
      throw new Error(`Attachment does not exist: ${attachment}`);
    }
    if (!fs.statSync(attachment).isFile()) {
      throw new Error(`Attachment is not a file: ${attachment}`);
    }
  }
  return unique;
}

function buildConfig(argv) {
  const reportFile = chooseReportFile(readArg(argv, "--report") || env("UST_TEST_REPORT_PATH", DEFAULT_REPORT_DIR));
  const mailerScript = path.resolve(readArg(argv, "--mailer") || env("UST_TEST_REPORT_MAILER_SCRIPT", DEFAULT_MAILER));
  if (!fs.existsSync(mailerScript)) {
    throw new Error(`Mailer script does not exist: ${mailerScript}`);
  }
  const to = parseRecipient(readArg(argv, "--to") || env("UST_TEST_REPORT_TO", DEFAULT_TO));
  const subject =
    readArg(argv, "--subject") ||
    env("UST_TEST_REPORT_SUBJECT") ||
    `UST test report - ${path.basename(reportFile)} - ${new Date().toISOString().slice(0, 10)}`;
  const body = readArg(argv, "--body") || readReportBody(reportFile);
  const attachments = resolveAttachments(reportFile, readRepeatedArgs(argv, "--attach"));

  return {
    mailerScript,
    to,
    subject,
    body,
    reportFile,
    attachments
  };
}

function sendWithDefaultMailer(config) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      config.mailerScript,
      "-To",
      config.to,
      "-Subject",
      config.subject,
      "-Body",
      config.body,
      "-Attachments",
      ...config.attachments
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: Number(env("UST_TEST_REPORT_EMAIL_TIMEOUT_MS", "120000"))
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `mailer exited with ${result.status}`).trim());
  }
  return (result.stdout || "").trim();
}

function publicPlan(config) {
  return {
    mailerScript: config.mailerScript,
    to: config.to,
    subject: config.subject,
    reportFile: config.reportFile,
    attachments: config.attachments,
    bodyChars: config.body.length
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const dryRun = argv.includes("--dry-run");
  const config = buildConfig(argv);
  if (dryRun) {
    console.log(JSON.stringify(publicPlan(config), null, 2));
    return;
  }
  const result = sendWithDefaultMailer(config);
  console.log(JSON.stringify({ ok: true, result, ...publicPlan(config) }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`send-test-report-email failed: ${error.message}`);
  process.exitCode = 1;
}
