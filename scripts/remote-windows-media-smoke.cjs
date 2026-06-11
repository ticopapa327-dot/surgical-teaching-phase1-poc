const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");

const DEFAULTS = {
  localWebUrl: "http://127.0.0.1:5173/",
  remoteWebUrl: "http://192.168.1.118:5173/",
  signalingUrl: "ws://192.168.1.118:7077/signal",
  signalingHealthUrl: "http://127.0.0.1:7077/health",
  remoteDebugUrl: "http://192.168.1.117:9222",
  requestMode: "view",
  expectAudio: "false",
  allowNonPublisherRuntimeWarn: "false",
  channels: "ch1,ch2,ch3,ch4",
  artifactDir: path.join("test-results", "remote-windows-media-smoke"),
  localEndpointIdPrefix: "or-media-118",
  localEndpointNamePrefix: "Media OR 118",
  remoteEndpointIdPrefix: "teach-media-117",
  remoteEndpointNamePrefix: "Media Teach 117",
  localSnapshotSuffix: "or-118",
  remoteSnapshotSuffix: "teach-117"
};

const LABELS = {
  signalingUrl: "\u4fe1\u4ee4\u5730\u5740",
  endpointId: "\u672c\u7aef ID",
  endpointName: "\u672c\u7aef\u540d\u79f0",
  endpointRole: "\u672c\u7aef\u89d2\u8272",
  requestMode: "\u53d1\u8d77\u6a21\u5f0f",
  connect: "\u8fde\u63a5\u4fe1\u4ee4",
  target: "\u4fe1\u4ee4\u76ee\u6807",
  callSelected: "\u4fe1\u4ee4\u547c\u53eb\u9009\u4e2d\u7ec8\u7aef",
  pendingCall: "\u5f85\u786e\u8ba4\u547c\u53eb",
  acceptCall: "\u63a5\u53d7\u547c\u53eb",
  registered: "\u5df2\u6ce8\u518c",
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

function envFlag(name, fallback) {
  const value = env(name, fallback).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeRequestMode(value) {
  return value === "interactive" ? "interactive" : "view";
}

function normalizeChannels(value) {
  const channels = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => CHANNEL_ORDER.includes(item));
  const unique = [...new Set(channels)];
  return unique.length ? unique : ["ch1"];
}

function metricHasVideo(metric) {
  const video = metric?.video || {};
  return [video.sendBitrateBps, video.receiveBitrateBps, video.packetsSent, video.packetsReceived].some(
    (value) => Number.isFinite(value) && value > 0
  );
}

function printConfig(config) {
  console.log("Remote Windows media smoke configuration");
  console.log(`  localWebUrl:        ${config.localWebUrl}`);
  console.log(`  remoteWebUrl:       ${config.remoteWebUrl}`);
  console.log(`  signalingUrl:       ${config.signalingUrl}`);
  console.log(`  signalingHealthUrl: ${config.signalingHealthUrl}`);
  console.log(`  remoteDebugUrl:     ${config.remoteDebugUrl}`);
  console.log(`  requestMode:        ${config.requestMode}`);
  console.log(`  expectAudio:        ${config.expectAudio}`);
  console.log(`  allowNonPublisherRuntimeWarn: ${config.allowNonPublisherRuntimeWarn}`);
  console.log(`  channels:           ${config.channels.join(",")}`);
  console.log(`  artifactDir:        ${config.artifactDir}`);
  console.log(`  localEndpoint:      ${config.localEndpointIdPrefix} / ${config.localEndpointNamePrefix}`);
  console.log(`  remoteEndpoint:     ${config.remoteEndpointIdPrefix} / ${config.remoteEndpointNamePrefix}`);
  console.log(`  snapshotSuffixes:   ${config.localSnapshotSuffix} / ${config.remoteSnapshotSuffix}`);
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

async function connectRemoteBrowser(remoteDebugUrl) {
  await requireHttpOk(`${remoteDebugUrl.replace(/\/$/, "")}/json/version`, "Remote browser debug endpoint");
  return chromium.connectOverCDP(remoteDebugUrl);
}

async function registerEndpoint(page, config, endpoint) {
  await page.getByLabel(LABELS.signalingUrl).fill(config.signalingUrl);
  await page.getByLabel(LABELS.endpointId).fill(endpoint.id);
  await page.getByLabel(LABELS.endpointName).fill(endpoint.name);
  await page.getByLabel(LABELS.endpointRole).selectOption(endpoint.role);
  await page.getByRole("button", { name: LABELS.connect }).click();
  await expect(page.getByText(`${LABELS.registered} ${endpoint.name}`)).toBeVisible({ timeout: 10000 });
}

async function startCall(localPage, remotePage, teachingEndpoint, requestMode) {
  await localPage.getByLabel(LABELS.requestMode).selectOption(requestMode);
  await expect(localPage.locator(`option[value="${teachingEndpoint.id}"]`)).toHaveCount(1, { timeout: 10000 });
  await localPage.getByLabel(LABELS.target).selectOption(teachingEndpoint.id);
  await localPage.getByRole("button", { name: LABELS.callSelected }).click();
  await expect(remotePage.getByText(LABELS.pendingCall)).toBeVisible({ timeout: 10000 });
  await remotePage.getByRole("button", { name: LABELS.acceptCall }).click();
}

async function assertSessionVisible(localPage, remotePage, operatingRoom, teachingRoom) {
  await expect(localPage.locator(".session-list dd").filter({ hasText: teachingRoom.name })).toBeVisible({
    timeout: 10000
  });
  await expect(remotePage.locator(".session-list dd").filter({ hasText: operatingRoom.name })).toBeVisible({
    timeout: 10000
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
    { timeout: 20000 }
  );
}

async function expectRemoteAudioTrackCount(page, count) {
  await page.waitForFunction(
    (expectedCount) => {
      const streams = [...document.querySelectorAll(".remote-audio-sinks audio")]
        .map((audio) => audio.srcObject)
        .filter((stream) => stream?.getAudioTracks?.().some((track) => track.readyState === "live"));
      return streams.length >= expectedCount;
    },
    count,
    { timeout: 20000 }
  );
}

async function copyDiagnosticSnapshot(page) {
  await page.getByRole("button", { name: LABELS.copyDiagnosticSnapshot }).click();
  const textarea = page.locator(".diagnostic-snapshot");
  await expect(textarea).toBeVisible({ timeout: 10000 });
  return JSON.parse(await textarea.inputValue());
}

async function waitForDiagnosticSnapshot(page, predicate, label) {
  const startedAt = Date.now();
  let lastSnapshot = null;
  while (Date.now() - startedAt < 25000) {
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

function safeSnapshotSuffix(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function runDiagnosticAnalyzer(localSnapshotPath, remoteSnapshotPath, options = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/analyze-diagnostics.cjs",
      "--fail-on-warn",
      "--allow-receive-only-runtime-warn",
      ...(options.allowNonPublisherRuntimeWarn ? ["--allow-non-publisher-runtime-warn"] : []),
      localSnapshotPath,
      remoteSnapshotPath
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

async function main() {
  const config = {
    localWebUrl: env("UST_LOCAL_WEB_URL", DEFAULTS.localWebUrl),
    remoteWebUrl: env("UST_REMOTE_WEB_URL", DEFAULTS.remoteWebUrl),
    signalingUrl: env("UST_SIGNALING_URL", DEFAULTS.signalingUrl),
    signalingHealthUrl: env("UST_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    remoteDebugUrl: env("UST_REMOTE_DEBUG_URL", DEFAULTS.remoteDebugUrl),
    requestMode: normalizeRequestMode(env("UST_REMOTE_REQUEST_MODE", DEFAULTS.requestMode)),
    expectAudio: envFlag("UST_REMOTE_EXPECT_AUDIO", DEFAULTS.expectAudio),
    allowNonPublisherRuntimeWarn: envFlag(
      "UST_REMOTE_ALLOW_NON_PUBLISHER_RUNTIME_WARN",
      DEFAULTS.allowNonPublisherRuntimeWarn
    ),
    channels: normalizeChannels(env("UST_REMOTE_MEDIA_CHANNELS", DEFAULTS.channels)),
    artifactDir: env("UST_REMOTE_ARTIFACT_DIR", DEFAULTS.artifactDir),
    localEndpointIdPrefix: env("UST_LOCAL_ENDPOINT_ID_PREFIX", DEFAULTS.localEndpointIdPrefix),
    localEndpointNamePrefix: env("UST_LOCAL_ENDPOINT_NAME_PREFIX", DEFAULTS.localEndpointNamePrefix),
    remoteEndpointIdPrefix: env("UST_REMOTE_ENDPOINT_ID_PREFIX", DEFAULTS.remoteEndpointIdPrefix),
    remoteEndpointNamePrefix: env("UST_REMOTE_ENDPOINT_NAME_PREFIX", DEFAULTS.remoteEndpointNamePrefix),
    localSnapshotSuffix: safeSnapshotSuffix(
      env("UST_LOCAL_SNAPSHOT_SUFFIX", DEFAULTS.localSnapshotSuffix),
      DEFAULTS.localSnapshotSuffix
    ),
    remoteSnapshotSuffix: safeSnapshotSuffix(
      env("UST_REMOTE_SNAPSHOT_SUFFIX", DEFAULTS.remoteSnapshotSuffix),
      DEFAULTS.remoteSnapshotSuffix
    )
  };
  printConfig(config);

  await requireHttpOk(config.localWebUrl, "Local web app");
  await requireHttpOk(config.remoteWebUrl, "Remote web app URL");
  await requireHttpOk(config.signalingHealthUrl, "Signaling health endpoint");

  let localBrowser;
  let remotePage;
  const suffix = Date.now().toString(36).slice(-6);
  const operatingRoom = {
    id: `${config.localEndpointIdPrefix}-${suffix}`,
    name: `${config.localEndpointNamePrefix} ${suffix}`,
    role: "operating-room"
  };
  const teachingRoom = {
    id: `${config.remoteEndpointIdPrefix}-${suffix}`,
    name: `${config.remoteEndpointNamePrefix} ${suffix}`,
    role: "teaching-room"
  };

  try {
    localBrowser = await chromium.launch({
      channel: process.env.CI ? undefined : "chrome",
      headless: true,
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
    });
    const localPage = await localBrowser.newPage({ viewport: { width: 1440, height: 1100 } });

    const remoteBrowser = await connectRemoteBrowser(config.remoteDebugUrl);
    const remoteContext = remoteBrowser.contexts()[0] || (await remoteBrowser.newContext());
    remotePage = await remoteContext.newPage();
    await remotePage.setViewportSize({ width: 1440, height: 1100 });

    await localPage.goto(config.localWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await remotePage.goto(config.remoteWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    await registerEndpoint(remotePage, config, teachingRoom);
    await registerEndpoint(localPage, config, operatingRoom);
    await startCall(localPage, remotePage, teachingRoom, config.requestMode);
    await assertSessionVisible(localPage, remotePage, operatingRoom, teachingRoom);
    await configureRemoteSubscriptions(remotePage, config.channels);

    await localPage.getByRole("button", { name: LABELS.publishSubscribedMedia }).click();
    await expectLiveRemoteVideoCount(remotePage, config.channels.length);
    await expect(remotePage.locator(".remote-health-live")).toHaveCount(config.channels.length, { timeout: 20000 });
    await expect(remotePage.locator(".diagnostic-state-live")).toHaveCount(config.channels.length, { timeout: 20000 });
    if (config.expectAudio) {
      await expectRemoteAudioTrackCount(remotePage, 1);
      await expect(remotePage.locator(".peer-diagnostic-list")).toContainText("远端1", { timeout: 20000 });
      await expect(localPage.locator(".peer-diagnostic-list")).toContainText("本地1", { timeout: 20000 });
    }

    const remoteSnapshot = await waitForDiagnosticSnapshot(
      remotePage,
      (snapshot) =>
        snapshot?.media?.diagnostics?.filter((item) => item.state === "live").length >= config.channels.length &&
        snapshot?.media?.statsMetrics?.some(metricHasVideo) &&
        (!config.expectAudio ||
          snapshot?.media?.peerConnections?.some((peer) => Number(peer.remoteAudioTrackCount) >= 1)),
      "remote"
    );
    const localSnapshot = await waitForDiagnosticSnapshot(
      localPage,
      (snapshot) =>
        snapshot?.media?.peerConnections?.length >= 1 &&
        snapshot?.media?.statsMetrics?.some(metricHasVideo) &&
        (!config.expectAudio ||
          snapshot?.media?.peerConnections?.some((peer) => Number(peer.localAudioTrackCount) >= 1)),
      "local"
    );

    const localSnapshotPath = path.join(config.artifactDir, `${suffix}-${config.localSnapshotSuffix}.json`);
    const remoteSnapshotPath = path.join(config.artifactDir, `${suffix}-${config.remoteSnapshotSuffix}.json`);
    saveJson(localSnapshotPath, localSnapshot);
    saveJson(remoteSnapshotPath, remoteSnapshot);
    runDiagnosticAnalyzer(localSnapshotPath, remoteSnapshotPath, {
      allowNonPublisherRuntimeWarn: config.allowNonPublisherRuntimeWarn
    });

    const health = await (await requireHttpOk(config.signalingHealthUrl, "Signaling health endpoint")).json();
    console.log(
      JSON.stringify(
        {
          ok: true,
          operatingRoomId: operatingRoom.id,
          teachingRoomId: teachingRoom.id,
          requestMode: config.requestMode,
          expectAudio: config.expectAudio,
          allowNonPublisherRuntimeWarn: config.allowNonPublisherRuntimeWarn,
          channels: config.channels,
          localSnapshotPath,
          remoteSnapshotPath,
          endpoints: health.endpoints,
          sessions: health.sessions,
          pendingCalls: health.pendingCalls
        },
        null,
        2
      )
    );
  } finally {
    if (remotePage) await remotePage.close().catch(() => {});
    if (localBrowser) await localBrowser.close().catch(() => {});
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`Remote Windows media smoke failed: ${error.message}`);
    process.exit(1);
  });
