const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");

const DEFAULTS = {
  localWebUrl: "http://127.0.0.1:5173/",
  remoteWebUrl: "http://192.168.1.118:5173/",
  signalingUrl: "ws://192.168.1.118:7077/signal",
  signalingHealthUrl: "http://127.0.0.1:7077/health",
  windowsDebugUrl: "http://127.0.0.1:9224",
  kylinDebugUrl: "http://192.168.1.137:9334",
  artifactDir: path.join("test-results", "remote-cross-conference-smoke")
};

const LABELS = {
  signalingUrl: "\u4fe1\u4ee4\u5730\u5740",
  endpointId: "\u672c\u7aef ID",
  endpointName: "\u672c\u7aef\u540d\u79f0",
  endpointRole: "\u672c\u7aef\u89d2\u8272",
  requestMode: "\u53d1\u8d77\u6a21\u5f0f",
  participantLimit: "\u624b\u672f\u5ba4\u53c2\u4e0e\u4e0a\u9650",
  connect: "\u8fde\u63a5\u4fe1\u4ee4",
  target: "\u4fe1\u4ee4\u76ee\u6807",
  callSelected: "\u4fe1\u4ee4\u547c\u53eb\u9009\u4e2d\u7ec8\u7aef",
  pendingCall: "\u5f85\u786e\u8ba4\u547c\u53eb",
  acceptCall: "\u63a5\u53d7\u547c\u53eb",
  registered: "\u5df2\u6ce8\u518c",
  joinSessionId: "\u52a0\u5165\u4f1a\u8bdd ID",
  joinSignalingSession: "\u52a0\u5165\u4fe1\u4ee4\u4f1a\u8bdd",
  singleLayout: "\u5355\u753b\u9762",
  dualLayout: "\u53cc\u753b\u9762",
  quadLayout: "\u56db\u753b\u9762",
  publishSubscribedMedia: "\u53d1\u5e03\u8ba2\u9605\u901a\u9053\u5a92\u4f53",
  copyDiagnosticSnapshot: "\u590d\u5236\u8bca\u65ad\u5feb\u7167"
};

const CHANNEL_ORDER = ["ch1", "ch2", "ch3", "ch4"];

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/remote-cross-conference-smoke.cjs [--manage-devtools]",
    "",
    "Environment:",
    "  UST_LOCAL_WEB_URL              Default: http://127.0.0.1:5173/",
    "  UST_REMOTE_WEB_URL             Default: http://192.168.1.118:5173/",
    "  UST_SIGNALING_URL              Default: ws://192.168.1.118:7077/signal",
    "  UST_SIGNALING_HEALTH_URL       Default: http://127.0.0.1:7077/health",
    "  UST_WINDOWS_DEBUG_URL          Default: http://127.0.0.1:9224",
    "  UST_KYLIN_DEBUG_URL            Default: http://192.168.1.137:9334",
    "  UST_REMOTE_CONFERENCE_ARTIFACT_DIR"
  ].join("\n");
}

function configFromEnv(argv) {
  return {
    manageDevtools: hasArg(argv, "--manage-devtools"),
    localWebUrl: env("UST_LOCAL_WEB_URL", DEFAULTS.localWebUrl),
    remoteWebUrl: env("UST_REMOTE_WEB_URL", DEFAULTS.remoteWebUrl),
    signalingUrl: env("UST_SIGNALING_URL", DEFAULTS.signalingUrl),
    signalingHealthUrl: env("UST_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    windowsDebugUrl: env("UST_WINDOWS_DEBUG_URL", env("UST_REMOTE_WINDOWS_DEBUG_URL", DEFAULTS.windowsDebugUrl)),
    kylinDebugUrl: env("UST_KYLIN_DEBUG_URL", env("UST_REMOTE_KYLIN_DEBUG_URL", DEFAULTS.kylinDebugUrl)),
    artifactDir: env("UST_REMOTE_CONFERENCE_ARTIFACT_DIR", DEFAULTS.artifactDir)
  };
}

function printConfig(config) {
  console.log("Remote cross-machine conference smoke configuration");
  console.log(`  localWebUrl:        ${config.localWebUrl}`);
  console.log(`  remoteWebUrl:       ${config.remoteWebUrl}`);
  console.log(`  signalingUrl:       ${config.signalingUrl}`);
  console.log(`  signalingHealthUrl: ${config.signalingHealthUrl}`);
  console.log(`  windowsDebugUrl:    ${config.windowsDebugUrl}`);
  console.log(`  kylinDebugUrl:      ${config.kylinDebugUrl}`);
  console.log(`  manageDevtools:     ${config.manageDevtools}`);
  console.log(`  artifactDir:        ${config.artifactDir}`);
}

async function requireHttpOk(url, label) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    throw new Error(`${label} is not reachable at ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status} at ${url}`);
  }
  return response;
}

async function connectRemoteBrowser(remoteDebugUrl, label) {
  await requireHttpOk(`${remoteDebugUrl.replace(/\/$/, "")}/json/version`, `${label} browser debug endpoint`);
  return chromium.connectOverCDP(remoteDebugUrl);
}

function runManagedDevtools(scriptPath, action, remoteDebugUrl) {
  const result = spawnSync(process.execPath, [scriptPath, action], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      UST_REMOTE_DEBUG_URL: remoteDebugUrl
    },
    encoding: "utf8",
    timeout: action === "start" ? 45000 : 20000,
    windowsHide: true
  });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) {
    throw new Error(`${path.basename(scriptPath)} ${action} failed with exit code ${result.status}`);
  }
}

function startManagedDevtools(config) {
  runManagedDevtools(path.join("scripts", "remote-windows-devtools.cjs"), "start", config.windowsDebugUrl);
  runManagedDevtools(path.join("scripts", "remote-kylin-devtools.cjs"), "start", config.kylinDebugUrl);
}

function stopManagedDevtools(config) {
  let exitCode = 0;
  for (const item of [
    [path.join("scripts", "remote-kylin-devtools.cjs"), config.kylinDebugUrl],
    [path.join("scripts", "remote-windows-devtools.cjs"), config.windowsDebugUrl]
  ]) {
    const result = spawnSync(process.execPath, [item[0], "stop"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        UST_REMOTE_DEBUG_URL: item[1]
      },
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true
    });
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
    if (result.status !== 0) exitCode = exitCode || result.status || 1;
  }
  return exitCode;
}

async function newRemotePage(browser, viewport = { width: 1440, height: 1100 }) {
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  return page;
}

async function registerEndpoint(page, config, endpoint) {
  await page.getByLabel(LABELS.signalingUrl).fill(config.signalingUrl);
  await page.getByLabel(LABELS.endpointId).fill(endpoint.id);
  await page.getByLabel(LABELS.endpointName).fill(endpoint.name);
  await page.getByLabel(LABELS.endpointRole).selectOption(endpoint.role);
  await page.getByRole("button", { name: LABELS.connect }).click();
  await expect(page.getByText(`${LABELS.registered} ${endpoint.name}`)).toBeVisible({ timeout: 10000 });
}

async function configureOperatingRoom(page, participantLimit) {
  await page.getByLabel(LABELS.requestMode).selectOption("view");
  await page.getByLabel(LABELS.participantLimit).fill(String(participantLimit));
}

async function startCall(localPage, remotePage, teachingEndpoint) {
  await expect(localPage.locator(`option[value="${teachingEndpoint.id}"]`)).toHaveCount(1, { timeout: 10000 });
  await localPage.getByLabel(LABELS.target).selectOption(teachingEndpoint.id);
  await localPage.getByRole("button", { name: LABELS.callSelected }).click();
  await expect(remotePage.getByText(LABELS.pendingCall)).toBeVisible({ timeout: 10000 });
  await remotePage.getByRole("button", { name: LABELS.acceptCall }).click();
}

async function sessionIdFromPage(page) {
  const value = await page.locator(".session-list dd").first().textContent({ timeout: 10000 });
  const sessionId = String(value || "").trim();
  if (!sessionId) throw new Error("active session id was not visible");
  return sessionId;
}

async function joinExistingSession(page, sessionId) {
  await page.getByLabel(LABELS.joinSessionId).fill(sessionId);
  await page.getByRole("button", { name: LABELS.joinSignalingSession }).click();
}

async function expectParticipantCount(page, count, limit) {
  await expect(page.locator(".session-list dd").filter({ hasText: `${count} / ${limit}` })).toBeVisible({
    timeout: 15000
  });
}

async function configureRemoteSubscriptions(remotePage, channels) {
  await expect(remotePage.locator(".channel-pulls input")).toHaveCount(4, { timeout: 10000 });
  const wanted = new Set(channels);
  for (const [index, channelId] of CHANNEL_ORDER.entries()) {
    const checkbox = remotePage.locator(".channel-pulls input").nth(index);
    if (wanted.has(channelId)) {
      await checkbox.check();
    } else {
      await checkbox.uncheck();
    }
  }
  if (channels.length >= 3) {
    await remotePage.getByRole("button", { name: LABELS.quadLayout }).click();
  } else if (channels.length === 2) {
    await remotePage.getByRole("button", { name: LABELS.dualLayout }).click();
  } else {
    await remotePage.getByRole("button", { name: LABELS.singleLayout }).click();
  }
  await expect(remotePage.locator(".remote-video-tile")).toHaveCount(channels.length, { timeout: 10000 });
}

async function expectLiveRemoteVideoCount(page, count) {
  await page.waitForFunction(
    (expectedCount) => {
      const streams = [...document.querySelectorAll(".remote-video-tile video")]
        .map((video) => video.srcObject)
        .filter((stream) => stream?.getVideoTracks?.().some((track) => track.readyState === "live"));
      return streams.length >= expectedCount && new Set(streams.map((stream) => stream.id)).size >= expectedCount;
    },
    count,
    { timeout: 25000 }
  );
}

async function copyDiagnosticSnapshot(page) {
  await page.getByRole("button", { name: LABELS.copyDiagnosticSnapshot }).click();
  const textarea = page.locator(".diagnostic-snapshot");
  await expect(textarea).toBeVisible({ timeout: 10000 });
  return JSON.parse(await textarea.inputValue());
}

function metricHasVideo(metric) {
  const video = metric?.video || {};
  return [video.sendBitrateBps, video.receiveBitrateBps, video.packetsSent, video.packetsReceived].some(
    (value) => Number.isFinite(value) && value > 0
  );
}

async function waitForDiagnosticSnapshot(page, predicate, label) {
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < 30000) {
    lastSnapshot = await copyDiagnosticSnapshot(page);
    if (predicate(lastSnapshot)) return lastSnapshot;
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label} diagnostic snapshot did not reach expected state: ${JSON.stringify(lastSnapshot?.media || {})}`);
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runDiagnosticAnalyzer(snapshotPaths) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/analyze-diagnostics.cjs",
      "--fail-on-warn",
      "--allow-receive-only-runtime-warn",
      "--allow-non-publisher-runtime-warn",
      ...snapshotPaths
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) {
    throw new Error(`diagnostic analyzer failed with exit code ${result.status}`);
  }
}

async function waitForHealthClean(url) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 15000) {
    last = await (await requireHttpOk(url, "Signaling health endpoint")).json();
    if (
      last?.ok === true &&
      Number(last.endpoints) === 0 &&
      Number(last.sessions) === 0 &&
      Number(last.pendingCalls) === 0
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`signaling health did not become clean: ${JSON.stringify(last)}`);
}

async function closePage(page) {
  if (page) await page.close().catch(() => {});
}

async function main(argv) {
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    console.log(usage());
    return;
  }

  const config = configFromEnv(argv);
  printConfig(config);

  let devtoolsStarted = false;
  let localBrowser;
  let localPage;
  let windowsPage;
  let kylinPage;
  let closedPages = false;
  const suffix = Date.now().toString(36).slice(-6);
  const operatingRoom = {
    id: `or-conference-118-${suffix}`,
    name: `Conference OR 118 ${suffix}`,
    role: "operating-room"
  };
  const windowsTeaching = {
    id: `teach-conference-117-${suffix}`,
    name: `Conference Teach 117 ${suffix}`,
    role: "teaching-room"
  };
  const kylinObserver = {
    id: `observer-conference-137-${suffix}`,
    name: `Conference Observer 137 ${suffix}`,
    role: "observer"
  };

  async function closePages() {
    if (closedPages) return;
    closedPages = true;
    await closePage(kylinPage);
    await closePage(windowsPage);
    if (localBrowser) await localBrowser.close().catch(() => {});
  }

  try {
    await requireHttpOk(config.localWebUrl, "Local web app");
    await requireHttpOk(config.remoteWebUrl, "Remote web app URL");
    await requireHttpOk(config.signalingHealthUrl, "Signaling health endpoint");

    if (config.manageDevtools) {
      devtoolsStarted = true;
      startManagedDevtools(config);
    }

    localBrowser = await chromium.launch({
      channel: process.env.CI ? undefined : "chrome",
      headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
    });
    localPage = await localBrowser.newPage({ viewport: { width: 1440, height: 1100 } });

    const windowsBrowser = await connectRemoteBrowser(config.windowsDebugUrl, "117 Windows");
    const kylinBrowser = await connectRemoteBrowser(config.kylinDebugUrl, "137 Kylin");
    windowsPage = await newRemotePage(windowsBrowser);
    kylinPage = await newRemotePage(kylinBrowser);

    await localPage.goto(config.localWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await windowsPage.goto(config.remoteWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await kylinPage.goto(config.remoteWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    await registerEndpoint(windowsPage, config, windowsTeaching);
    await registerEndpoint(kylinPage, config, kylinObserver);
    await registerEndpoint(localPage, config, operatingRoom);
    await configureOperatingRoom(localPage, 3);

    await startCall(localPage, windowsPage, windowsTeaching);
    await expectParticipantCount(localPage, 2, 3);
    await expect(windowsPage.locator(".session-list dd").filter({ hasText: operatingRoom.name })).toBeVisible({
      timeout: 10000
    });

    const sessionId = await sessionIdFromPage(localPage);
    await joinExistingSession(kylinPage, sessionId);
    await expectParticipantCount(localPage, 3, 3);
    await expect(windowsPage.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible({
      timeout: 15000
    });
    await expect(kylinPage.locator(".session-list dd").filter({ hasText: operatingRoom.name })).toBeVisible({
      timeout: 15000
    });

    await configureRemoteSubscriptions(windowsPage, ["ch1", "ch2"]);
    await configureRemoteSubscriptions(kylinPage, ["ch1"]);

    await localPage.getByRole("button", { name: LABELS.publishSubscribedMedia }).click();
    await expectLiveRemoteVideoCount(windowsPage, 2);
    await expectLiveRemoteVideoCount(kylinPage, 1);
    await expect(windowsPage.locator(".remote-health-live")).toHaveCount(2, { timeout: 20000 });
    await expect(kylinPage.locator(".remote-health-live")).toHaveCount(1, { timeout: 20000 });

    const windowsSnapshot = await waitForDiagnosticSnapshot(
      windowsPage,
      (snapshot) =>
        snapshot?.media?.diagnostics?.filter((item) => item.state === "live").length >= 2 &&
        snapshot?.media?.statsMetrics?.some(metricHasVideo),
      "117 Windows"
    );
    const kylinSnapshot = await waitForDiagnosticSnapshot(
      kylinPage,
      (snapshot) =>
        snapshot?.media?.diagnostics?.filter((item) => item.state === "live").length >= 1 &&
        snapshot?.media?.statsMetrics?.some(metricHasVideo),
      "137 Kylin"
    );
    const localSnapshot = await waitForDiagnosticSnapshot(
      localPage,
      (snapshot) =>
        snapshot?.media?.peerConnections?.length >= 2 &&
        snapshot?.media?.statsMetrics?.some(metricHasVideo),
      "118 local"
    );

    const localSnapshotPath = path.join(config.artifactDir, `${suffix}-or-118.json`);
    const windowsSnapshotPath = path.join(config.artifactDir, `${suffix}-teach-117.json`);
    const kylinSnapshotPath = path.join(config.artifactDir, `${suffix}-observer-137.json`);
    saveJson(localSnapshotPath, localSnapshot);
    saveJson(windowsSnapshotPath, windowsSnapshot);
    saveJson(kylinSnapshotPath, kylinSnapshot);
    runDiagnosticAnalyzer([localSnapshotPath, windowsSnapshotPath, kylinSnapshotPath]);

    await closePages();
    const healthAfter = await waitForHealthClean(config.signalingHealthUrl);
    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId,
          operatingRoomId: operatingRoom.id,
          windowsTeachingId: windowsTeaching.id,
          kylinObserverId: kylinObserver.id,
          windowsChannels: ["ch1", "ch2"],
          kylinChannels: ["ch1"],
          localSnapshotPath,
          windowsSnapshotPath,
          kylinSnapshotPath,
          healthAfter
        },
        null,
        2
      )
    );
  } finally {
    await closePages();
    if (devtoolsStarted) {
      const stopExitCode = stopManagedDevtools(config);
      if (stopExitCode !== 0) {
        process.exitCode = process.exitCode || stopExitCode;
      }
    }
  }
}

main(process.argv.slice(2))
  .then(() => {
    if (!process.exitCode) process.exit(0);
  })
  .catch((error) => {
    console.error(`Remote cross-machine conference smoke failed: ${error.message}`);
    process.exit(1);
  });
