const { chromium, expect } = require("@playwright/test");

const DEFAULTS = {
  localWebUrl: "http://127.0.0.1:5173/",
  remoteWebUrl: "http://192.168.1.118:5173/",
  signalingUrl: "ws://192.168.1.118:7077/signal",
  signalingHealthUrl: "http://127.0.0.1:7077/health",
  remoteDebugUrl: "http://192.168.1.117:9222",
  localEndpointIdPrefix: "or-118",
  localEndpointNamePrefix: "OR 118",
  remoteEndpointIdPrefix: "teach-117",
  remoteEndpointNamePrefix: "Teach 117"
};

const LABELS = {
  signalingUrl: "\u4fe1\u4ee4\u5730\u5740",
  endpointId: "\u672c\u7aef ID",
  endpointName: "\u672c\u7aef\u540d\u79f0",
  endpointRole: "\u672c\u7aef\u89d2\u8272",
  connect: "\u8fde\u63a5\u4fe1\u4ee4",
  target: "\u4fe1\u4ee4\u76ee\u6807",
  callSelected: "\u4fe1\u4ee4\u547c\u53eb\u9009\u4e2d\u7ec8\u7aef",
  pendingCall: "\u5f85\u786e\u8ba4\u547c\u53eb",
  acceptCall: "\u63a5\u53d7\u547c\u53eb",
  registered: "\u5df2\u6ce8\u518c"
};

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function printConfig(config) {
  console.log("Remote Windows signal smoke configuration");
  console.log(`  localWebUrl:        ${config.localWebUrl}`);
  console.log(`  remoteWebUrl:       ${config.remoteWebUrl}`);
  console.log(`  signalingUrl:       ${config.signalingUrl}`);
  console.log(`  signalingHealthUrl: ${config.signalingHealthUrl}`);
  console.log(`  remoteDebugUrl:     ${config.remoteDebugUrl}`);
  console.log(`  localEndpoint:      ${config.localEndpointIdPrefix} / ${config.localEndpointNamePrefix}`);
  console.log(`  remoteEndpoint:     ${config.remoteEndpointIdPrefix} / ${config.remoteEndpointNamePrefix}`);
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

async function startCall(localPage, remotePage, teachingEndpoint) {
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

async function main() {
  const config = {
    localWebUrl: env("UST_LOCAL_WEB_URL", DEFAULTS.localWebUrl),
    remoteWebUrl: env("UST_REMOTE_WEB_URL", DEFAULTS.remoteWebUrl),
    signalingUrl: env("UST_SIGNALING_URL", DEFAULTS.signalingUrl),
    signalingHealthUrl: env("UST_SIGNALING_HEALTH_URL", DEFAULTS.signalingHealthUrl),
    remoteDebugUrl: env("UST_REMOTE_DEBUG_URL", DEFAULTS.remoteDebugUrl),
    localEndpointIdPrefix: env("UST_LOCAL_ENDPOINT_ID_PREFIX", DEFAULTS.localEndpointIdPrefix),
    localEndpointNamePrefix: env("UST_LOCAL_ENDPOINT_NAME_PREFIX", DEFAULTS.localEndpointNamePrefix),
    remoteEndpointIdPrefix: env("UST_REMOTE_ENDPOINT_ID_PREFIX", DEFAULTS.remoteEndpointIdPrefix),
    remoteEndpointNamePrefix: env("UST_REMOTE_ENDPOINT_NAME_PREFIX", DEFAULTS.remoteEndpointNamePrefix)
  };
  printConfig(config);

  await requireHttpOk(config.localWebUrl, "Local web app");
  await requireHttpOk(config.remoteWebUrl, "Remote web app URL");
  await requireHttpOk(config.signalingHealthUrl, "Signaling health endpoint");

  let localBrowser;
  let remoteBrowser;
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

    remoteBrowser = await connectRemoteBrowser(config.remoteDebugUrl);
    const remoteContext = remoteBrowser.contexts()[0] || (await remoteBrowser.newContext());
    remotePage = await remoteContext.newPage();
    await remotePage.setViewportSize({ width: 1440, height: 1100 });

    await localPage.goto(config.localWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await remotePage.goto(config.remoteWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    await registerEndpoint(remotePage, config, teachingRoom);
    await registerEndpoint(localPage, config, operatingRoom);
    await startCall(localPage, remotePage, teachingRoom);
    await assertSessionVisible(localPage, remotePage, operatingRoom, teachingRoom);

    const health = await (await requireHttpOk(config.signalingHealthUrl, "Signaling health endpoint")).json();
    console.log(
      JSON.stringify(
        {
          ok: true,
          operatingRoomId: operatingRoom.id,
          teachingRoomId: teachingRoom.id,
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
    // Do not call remoteBrowser.close(); this script connects to an existing browser on PC-B.
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`Remote Windows signal smoke failed: ${error.message}`);
    process.exit(1);
  });
