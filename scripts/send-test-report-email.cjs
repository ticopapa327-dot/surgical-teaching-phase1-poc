const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_TO = "2012@mvbs.com.cn";
const DEFAULT_REPORT_DIR = path.join("validation-results", "cross-machine-validation");
const DEFAULT_MAILER = "C:\\Users\\wangm\\.codex\\tools\\send-default-mail.ps1";
const DEFAULT_OUTLOOK_FROM = "wangmaohua0303@outlook.com";
const DEFAULT_FOXMAIL_FROM = "2012@mvbs.com.cn";
const DEFAULT_FOXMAIL_PATH = "D:\\Foxmail 7.2\\Foxmail.exe";

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
    "  --from <address>      Sender account for outlook/foxmail transport",
    "  --transport <name>    Mail transport: default, outlook or foxmail; defaults to default",
    "  --attach <path>       Extra attachment; can be repeated",
    "  --dry-run             Validate input and print the send plan without sending",
    "  --help                Show this help",
    "",
    "Environment:",
    "  UST_TEST_REPORT_PATH           Default report file or directory",
    "  UST_TEST_REPORT_TO             Recipient override",
    "  UST_TEST_REPORT_FROM           Outlook sender account override",
    "  UST_TEST_REPORT_SUBJECT        Subject override",
    "  UST_TEST_REPORT_TRANSPORT      default, outlook or foxmail",
    "  UST_TEST_REPORT_FOXMAIL_PATH   Foxmail executable path; default D:\\Foxmail 7.2\\Foxmail.exe",
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
  const transport = (readArg(argv, "--transport") || env("UST_TEST_REPORT_TRANSPORT", "default")).toLowerCase();
  if (!["default", "outlook", "foxmail"].includes(transport)) {
    throw new Error(`Unsupported mail transport: ${transport}`);
  }
  const reportFile = chooseReportFile(readArg(argv, "--report") || env("UST_TEST_REPORT_PATH", DEFAULT_REPORT_DIR));
  const mailerScript = path.resolve(readArg(argv, "--mailer") || env("UST_TEST_REPORT_MAILER_SCRIPT", DEFAULT_MAILER));
  if (transport === "default" && !fs.existsSync(mailerScript)) {
    throw new Error(`Mailer script does not exist: ${mailerScript}`);
  }
  const to = parseRecipient(readArg(argv, "--to") || env("UST_TEST_REPORT_TO", DEFAULT_TO));
  const defaultFrom = transport === "foxmail" ? DEFAULT_FOXMAIL_FROM : DEFAULT_OUTLOOK_FROM;
  const from = readArg(argv, "--from") || env("UST_TEST_REPORT_FROM", defaultFrom);
  const foxmailPath = path.resolve(readArg(argv, "--foxmail") || env("UST_TEST_REPORT_FOXMAIL_PATH", DEFAULT_FOXMAIL_PATH));
  const subject =
    readArg(argv, "--subject") ||
    env("UST_TEST_REPORT_SUBJECT") ||
    `UST test report - ${path.basename(reportFile)} - ${new Date().toISOString().slice(0, 10)}`;
  const body = readArg(argv, "--body") || readReportBody(reportFile);
  const attachments = resolveAttachments(reportFile, readRepeatedArgs(argv, "--attach"));

  return {
    transport,
    mailerScript,
    foxmailPath,
    to,
    from,
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

function sendWithOutlookClient(config) {
  const configPath = path.join(os.tmpdir(), `ust-outlook-mail-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        to: config.to,
        from: config.from,
        subject: config.subject,
        body: config.body,
        attachments: config.attachments
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$configPath = $env:UST_OUTLOOK_MAIL_CONFIG
if (-not $configPath) {
  throw "UST_OUTLOOK_MAIL_CONFIG is required"
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$outlookType = [type]::GetTypeFromProgID("Outlook.Application")
if (-not $outlookType) {
  throw "Classic Outlook COM interface is not registered. Install classic Outlook desktop and configure the sender account, or use another transport."
}
$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.Session
$mail = $outlook.CreateItem(0)
if ($config.from) {
  $accounts = @($namespace.Accounts)
  $account = $accounts | Where-Object {
    ($_.SmtpAddress -and $_.SmtpAddress -ieq [string]$config.from) -or
    ($_.DisplayName -and $_.DisplayName -ieq [string]$config.from)
  } | Select-Object -First 1
  if (-not $account) {
    $available = ($accounts | ForEach-Object { if ($_.SmtpAddress) { $_.SmtpAddress } else { $_.DisplayName } }) -join ", "
    throw "Outlook sender account not found: $($config.from). Available accounts: $available"
  }
  $mail.SendUsingAccount = $account
}
$mail.To = [string]$config.to
$mail.Subject = [string]$config.subject
$mail.Body = [string]$config.body
foreach ($attachment in @($config.attachments)) {
  if (-not (Test-Path -LiteralPath $attachment -PathType Leaf)) {
    throw "Attachment not found: $attachment"
  }
  [void]$mail.Attachments.Add($attachment)
}
$mail.Send()
"SENT"
`.trim();
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, UST_OUTLOOK_MAIL_CONFIG: configPath },
        timeout: Number(env("UST_TEST_REPORT_EMAIL_TIMEOUT_MS", "120000")),
        windowsHide: true
      }
    );
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new Error(
          "Outlook COM send did not return before timeout. Confirm classic Outlook is configured with the sender account and is not blocked by an interactive sign-in or security prompt."
        );
      }
      throw result.error;
    }
    if (result.status !== 0) {
      const output = (result.stderr || result.stdout || `outlook mailer exited with ${result.status}`).trim();
      if (/Outlook\.Application|REGDB_E_CLASSNOTREG|NoCOMClassIdentified|Class not registered|COM interface is not registered/i.test(output)) {
        throw new Error(
          "Classic Outlook COM interface is not registered on this machine. The installed new Outlook app cannot be used for silent COM sending."
        );
      }
      throw new Error(output);
    }
    return (result.stdout || "").trim();
  } finally {
    fs.rmSync(configPath, { force: true });
  }
}

function assertFoxmailAccount(config) {
  if (!fs.existsSync(config.foxmailPath)) {
    throw new Error(`Foxmail executable does not exist: ${config.foxmailPath}`);
  }
  const storageList = path.join(path.dirname(config.foxmailPath), "FMStorage.list");
  if (!fs.existsSync(storageList)) {
    throw new Error(`Foxmail storage list does not exist: ${storageList}`);
  }
  const storageBuffer = fs.readFileSync(storageList);
  const storageTexts = [storageBuffer.toString("utf8"), storageBuffer.toString("utf16le"), storageBuffer.toString("latin1")];
  if (!storageTexts.some((text) => text.toLowerCase().includes(config.from.toLowerCase()))) {
    throw new Error(`Foxmail sender account was not found in FMStorage.list: ${config.from}`);
  }
}

function sendWithFoxmailClient(config) {
  assertFoxmailAccount(config);
  const wow64PowerShell = path.join(process.env.WINDIR || "C:\\Windows", "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
  const powerShell = fs.existsSync(wow64PowerShell) ? wow64PowerShell : "powershell.exe";
  const configPath = path.join(os.tmpdir(), `ust-foxmail-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        to: config.to,
        from: config.from,
        subject: config.subject,
        body: config.body,
        attachments: config.attachments
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$configPath = $env:UST_FOXMAIL_CONFIG
if (-not $configPath) {
  throw "UST_FOXMAIL_CONFIG is required"
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public sealed class SimpleMapiSender
{
    private const int MAPI_TO = 1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct MapiMessage
    {
        public int ulReserved;
        public string lpszSubject;
        public string lpszNoteText;
        public string lpszMessageType;
        public string lpszDateReceived;
        public string lpszConversationID;
        public int flFlags;
        public IntPtr lpOriginator;
        public int nRecipCount;
        public IntPtr lpRecips;
        public int nFileCount;
        public IntPtr lpFiles;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct MapiRecipDesc
    {
        public int ulReserved;
        public int ulRecipClass;
        public string lpszName;
        public string lpszAddress;
        public int ulEIDSize;
        public IntPtr lpEntryID;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    private struct MapiFileDesc
    {
        public int ulReserved;
        public int flFlags;
        public int nPosition;
        public string lpszPathName;
        public string lpszFileName;
        public IntPtr lpFileType;
    }

    [DllImport("MAPI32.DLL", CharSet = CharSet.Ansi)]
    private static extern int MAPISendMail(IntPtr session, IntPtr uiParam, MapiMessage message, int flags, int reserved);

    public static int Send(string from, string to, string subject, string body, string[] attachments)
    {
        IntPtr originatorPtr = IntPtr.Zero;
        IntPtr recipientPtr = IntPtr.Zero;
        IntPtr filesPtr = IntPtr.Zero;
        try
        {
            MapiRecipDesc originator = new MapiRecipDesc
            {
                ulRecipClass = 0,
                lpszName = from,
                lpszAddress = "SMTP:" + from
            };
            originatorPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(MapiRecipDesc)));
            Marshal.StructureToPtr(originator, originatorPtr, false);

            MapiRecipDesc recipient = new MapiRecipDesc
            {
                ulRecipClass = MAPI_TO,
                lpszName = to,
                lpszAddress = "SMTP:" + to
            };
            recipientPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(MapiRecipDesc)));
            Marshal.StructureToPtr(recipient, recipientPtr, false);

            int fileCount = attachments == null ? 0 : attachments.Length;
            if (fileCount > 0)
            {
                int fileSize = Marshal.SizeOf(typeof(MapiFileDesc));
                filesPtr = Marshal.AllocHGlobal(fileSize * fileCount);
                for (int i = 0; i < fileCount; i++)
                {
                    MapiFileDesc file = new MapiFileDesc
                    {
                        nPosition = -1,
                        lpszPathName = attachments[i],
                        lpszFileName = System.IO.Path.GetFileName(attachments[i])
                    };
                    Marshal.StructureToPtr(file, IntPtr.Add(filesPtr, i * fileSize), false);
                }
            }

            MapiMessage message = new MapiMessage
            {
                lpszSubject = subject,
                lpszNoteText = body,
                lpOriginator = originatorPtr,
                nRecipCount = 1,
                lpRecips = recipientPtr,
                nFileCount = fileCount,
                lpFiles = filesPtr
            };
            return MAPISendMail(IntPtr.Zero, IntPtr.Zero, message, 0, 0);
        }
        finally
        {
            if (filesPtr != IntPtr.Zero)
            {
                int fileCount = attachments == null ? 0 : attachments.Length;
                int fileSize = Marshal.SizeOf(typeof(MapiFileDesc));
                for (int i = 0; i < fileCount; i++)
                {
                    Marshal.DestroyStructure(IntPtr.Add(filesPtr, i * fileSize), typeof(MapiFileDesc));
                }
                Marshal.FreeHGlobal(filesPtr);
            }
            if (recipientPtr != IntPtr.Zero)
            {
                Marshal.DestroyStructure(recipientPtr, typeof(MapiRecipDesc));
                Marshal.FreeHGlobal(recipientPtr);
            }
            if (originatorPtr != IntPtr.Zero)
            {
                Marshal.DestroyStructure(originatorPtr, typeof(MapiRecipDesc));
                Marshal.FreeHGlobal(originatorPtr);
            }
        }
    }
}
"@
$attachments = @($config.attachments | ForEach-Object { [string]$_ })
$code = [SimpleMapiSender]::Send([string]$config.from, [string]$config.to, [string]$config.subject, [string]$config.body, [string[]]$attachments)
if ($code -ne 0) {
  throw "MAPISendMail failed with code $code"
}
"SENT"
`.trim();
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  try {
    const result = spawnSync(
      powerShell,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, UST_FOXMAIL_CONFIG: configPath },
        timeout: Number(env("UST_TEST_REPORT_EMAIL_TIMEOUT_MS", "120000")),
        windowsHide: true
      }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `foxmail mailer exited with ${result.status}`).trim());
    }
    return (result.stdout || "").trim();
  } finally {
    fs.rmSync(configPath, { force: true });
  }
}

function publicPlan(config) {
  return {
    transport: config.transport,
    mailerScript: config.mailerScript,
    foxmailPath: config.transport === "foxmail" ? config.foxmailPath : "",
    to: config.to,
    from: ["outlook", "foxmail"].includes(config.transport) ? config.from : "",
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
  const result =
    config.transport === "outlook"
      ? sendWithOutlookClient(config)
      : config.transport === "foxmail"
        ? sendWithFoxmailClient(config)
        : sendWithDefaultMailer(config);
  console.log(JSON.stringify({ ok: true, result, ...publicPlan(config) }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`send-test-report-email failed: ${error.message}`);
  process.exitCode = 1;
}
