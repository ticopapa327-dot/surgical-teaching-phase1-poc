const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");

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
  stopMedia: "\u505c\u6b62\u5a92\u4f53\u94fe\u8def",
  copyDiagnosticSnapshot: "\u590d\u5236\u8bca\u65ad\u5feb\u7167"
};

const CHANNELS = ["ch1", "ch2", "ch3", "ch4"];

function env(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function envNumber(name, fallback) {
  const value = Number(env(name, fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

function envPositiveInteger(name, fallback) {
  const value = envNumber(name, fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function timestampForPath(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function defaultOutputDir() {
  const oneDrive = fs.existsSync("D:\\OneDrive") ? "D:\\OneDrive" : path.join(os.homedir(), "OneDrive");
  return path.join(oneDrive, `UST-real-usb-video-117-layout-${timestampForPath()}`);
}

function configFromEnv() {
  return {
    localWebUrl: env("UST_REAL_USB_LOCAL_WEB_URL", "http://127.0.0.1:5173/"),
    remoteWebUrl: env("UST_REAL_USB_REMOTE_WEB_URL", "http://192.168.1.118:5173/"),
    signalingUrl: env("UST_REAL_USB_SIGNALING_URL", "ws://192.168.1.118:7077/signal"),
    signalingHealthUrl: env("UST_REAL_USB_SIGNALING_HEALTH_URL", "http://127.0.0.1:7077/health"),
    remoteDebugUrl: env("UST_REAL_USB_REMOTE_DEBUG_URL", "http://192.168.1.117:9222"),
    remoteSshTarget: env("UST_REAL_USB_REMOTE_SSH_TARGET", "HUAWEI@192.168.1.117"),
    outputDir: env("UST_REAL_USB_OUTPUT_DIR", defaultOutputDir()),
    excludeCameraRegex: env("UST_REAL_USB_EXCLUDE_CAMERA_REGEX", "\\bHD Webcam\\b"),
    holdSeconds: envNumber("UST_REAL_USB_HOLD_SECONDS", "0"),
    sampleIntervalSeconds: envNumber("UST_REAL_USB_SAMPLE_INTERVAL_SECONDS", "30"),
    cpuLimitPercent: envNumber("UST_REAL_USB_CPU_LIMIT_PERCENT", "80"),
    degradedChannelCount: envPositiveInteger("UST_REAL_USB_DEGRADED_CHANNEL_COUNT", "2"),
    captureWidth: envPositiveInteger("UST_REAL_USB_CAPTURE_WIDTH", "1280"),
    captureHeight: envPositiveInteger("UST_REAL_USB_CAPTURE_HEIGHT", "720"),
    captureFrameRate: envPositiveInteger("UST_REAL_USB_CAPTURE_FRAME_RATE", "30"),
    reducedCaptureWidth: envPositiveInteger("UST_REAL_USB_REDUCED_CAPTURE_WIDTH", "640"),
    reducedCaptureHeight: envPositiveInteger("UST_REAL_USB_REDUCED_CAPTURE_HEIGHT", "360"),
    reducedCaptureFrameRate: envPositiveInteger("UST_REAL_USB_REDUCED_CAPTURE_FRAME_RATE", "15"),
    localEndpointIdPrefix: env("UST_REAL_USB_LOCAL_ENDPOINT_ID_PREFIX", "or-real-usb-118"),
    localEndpointNamePrefix: env("UST_REAL_USB_LOCAL_ENDPOINT_NAME_PREFIX", "OR 118 Real USB"),
    remoteEndpointIdPrefix: env("UST_REAL_USB_REMOTE_ENDPOINT_ID_PREFIX", "teach-real-usb-117"),
    remoteEndpointNamePrefix: env("UST_REAL_USB_REMOTE_ENDPOINT_NAME_PREFIX", "Teach 117 Real USB")
  };
}

function runNodeScript(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true
  });
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status !== 0 || result.error) {
    throw new Error(`${label} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  return result;
}

async function requireHttpOk(url, label) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response;
}

async function connectRemoteBrowser(remoteDebugUrl) {
  await requireHttpOk(`${remoteDebugUrl.replace(/\/$/, "")}/json/version`, "117 DevTools");
  return chromium.connectOverCDP(remoteDebugUrl);
}

async function selectRemotePage(browser) {
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages().find((item) => !item.isClosed()) || (await context.newPage());
  await page.bringToFront().catch(() => {});
  return page;
}

async function enumerateVideoInputs(page) {
  return page.evaluate(async () => {
    let permissionError = "";
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (error) {
      permissionError = error.message;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (stream) stream.getTracks().forEach((track) => track.stop());
    return {
      permissionError,
      videos: devices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
          index: index + 1,
          label: device.label || `Video input ${index + 1}`,
          deviceId: device.deviceId
        }))
    };
  });
}

function pickUsbCameras(videos, excludeCameraRegex) {
  const exclude = new RegExp(excludeCameraRegex, "i");
  const preferred = videos.filter((device) => !exclude.test(device.label));
  const selected = (preferred.length >= 4 ? preferred : videos).slice(0, 4);
  if (selected.length < 4) {
    throw new Error(`only ${selected.length} video input(s) available; 4 are required`);
  }
  return selected;
}

function combinations(items, count, start = 0, current = [], output = []) {
  if (current.length === count) {
    output.push([...current]);
    return output;
  }
  for (let index = start; index < items.length; index += 1) {
    combinations(items, count, index + 1, [...current, items[index]], output);
  }
  return output;
}

function captureConstraints(config, reduced = false) {
  return {
    width: reduced ? config.reducedCaptureWidth : config.captureWidth,
    height: reduced ? config.reducedCaptureHeight : config.captureHeight,
    frameRate: reduced ? config.reducedCaptureFrameRate : config.captureFrameRate
  };
}

async function testCameraSet(page, cameras, constraints) {
  return page.evaluate(async ({ cameraIds, constraints: capture }) => {
    const streams = [];
    const outputs = [];
    for (const camera of cameraIds) {
      const startedAt = performance.now();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: camera.deviceId },
            width: { ideal: capture.width },
            height: { ideal: capture.height },
            frameRate: { ideal: capture.frameRate }
          },
          audio: false
        });
        streams.push(stream);
        const track = stream.getVideoTracks()[0];
        outputs.push({
          label: camera.label,
          ok: true,
          elapsedMs: Math.round(performance.now() - startedAt),
          settings: track.getSettings()
        });
      } catch (error) {
        outputs.push({
          label: camera.label,
          ok: false,
          elapsedMs: Math.round(performance.now() - startedAt),
          error: `${error.name}: ${error.message}`
        });
      }
    }
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      ok: outputs.every((item) => item.ok),
      outputs
    };
  }, {
    cameraIds: cameras.map((camera) => ({ label: camera.label, deviceId: camera.deviceId })),
    constraints
  });
}

async function selectWorkingCameraSet(page, videos, excludeCameraRegex, constraints) {
  pickUsbCameras(videos, excludeCameraRegex);
  const exclude = new RegExp(excludeCameraRegex, "i");
  const candidates = combinations(videos, 4)
    .map((items, index) => ({
      index,
      items,
      preferredCount: items.filter((item) => !exclude.test(item.label)).length
    }))
    .sort((a, b) => b.preferredCount - a.preferredCount || a.index - b.index);
  const results = [];
  for (const candidate of candidates) {
    const test = await testCameraSet(page, candidate.items, constraints);
    const result = {
      labels: candidate.items.map((item) => item.label),
      preferredCount: candidate.preferredCount,
      ok: test.ok,
      outputs: test.outputs.map((item) => ({
        label: item.label,
        ok: item.ok,
        elapsedMs: item.elapsedMs,
        error: item.error || "",
        width: item.settings?.width || null,
        height: item.settings?.height || null,
        frameRate: item.settings?.frameRate || null
      }))
    };
    results.push(result);
    if (test.ok) {
      return { selected: candidate.items, results };
    }
  }
  throw new Error("no working 4-camera combination was found");
}

async function requestDeviceRefresh(page) {
  await page.locator(".top-actions button").nth(0).click();
  await page.waitForFunction(
    () => [...document.querySelectorAll(".channel-card select:nth-of-type(2) option")].length >= 5,
    null,
    { timeout: 20000 }
  );
}

async function configureAndStartPreviews(page, selectedCameras, constraints) {
  const previewResults = [];
  for (const [index, camera] of selectedCameras.entries()) {
    const card = page.locator(".channel-card").nth(index);
    await card.locator(".channel-controls select").nth(0).selectOption("device");
    await card.locator(".channel-controls select").nth(1).selectOption(camera.deviceId);
    await card.locator("video").evaluate((video, capture) => {
      video.dataset.ustTargetWidth = String(capture.width);
      video.dataset.ustTargetHeight = String(capture.height);
      video.dataset.ustTargetFrameRate = String(capture.frameRate);
    }, constraints);
    await card.locator(".channel-controls button").nth(0).click();
    await card.locator("video").evaluate(async (video) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("preview video timed out")), 15000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          done();
        } else {
          video.onloadeddata = done;
          video.oncanplay = done;
        }
      });
    });
    await card.locator("video").evaluate(async (video, capture) => {
      const track = video.srcObject?.getVideoTracks?.()[0];
      if (track?.applyConstraints) {
        await track.applyConstraints({
          width: { ideal: capture.width },
          height: { ideal: capture.height },
          frameRate: { ideal: capture.frameRate }
        });
      }
    }, constraints);
    const stats = await card.locator("video").evaluate((video) => ({
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentTime: video.currentTime,
      trackSettings: video.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || null
    }));
    previewResults.push({ channel: CHANNELS[index], camera, stats });
  }
  return previewResults;
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
  await localPage.getByLabel(LABELS.requestMode).selectOption("view");
  await expect(localPage.locator(`option[value="${teachingEndpoint.id}"]`)).toHaveCount(1, { timeout: 10000 });
  await localPage.getByLabel(LABELS.target).selectOption(teachingEndpoint.id);
  await localPage.getByRole("button", { name: LABELS.callSelected }).click();
  await expect(remotePage.getByText(LABELS.pendingCall)).toBeVisible({ timeout: 10000 });
  await remotePage.getByRole("button", { name: LABELS.acceptCall }).click();
}

async function configureRemoteQuad(remotePage) {
  return configureRemoteChannels(remotePage, 4);
}

async function configureRemoteChannels(remotePage, channelCount) {
  const count = Math.min(Math.max(Number(channelCount) || 1, 1), CHANNELS.length);
  await expect(remotePage.locator(".channel-pulls input")).toHaveCount(4, { timeout: 10000 });
  for (let index = 0; index < 4; index += 1) {
    const checkbox = remotePage.locator(".channel-pulls input").nth(index);
    if (index < count) {
      await checkbox.check();
    } else {
      await checkbox.uncheck();
    }
  }
  if (count >= 3) {
    await remotePage.getByRole("button", { name: LABELS.quadLayout }).click();
  } else if (count === 2) {
    await remotePage.getByRole("button", { name: LABELS.dualLayout }).click();
  } else {
    await remotePage.getByRole("button", { name: LABELS.singleLayout }).click();
  }
  await expect(remotePage.locator(".remote-video-tile")).toHaveCount(count, { timeout: 10000 });
  return CHANNELS.slice(0, count);
}

async function waitForLiveRemoteVideos(remotePage, count) {
  await remotePage.waitForFunction(
    (expectedCount) => {
      const videos = [...document.querySelectorAll(".remote-video-tile video")];
      if (videos.length < expectedCount) return false;
      const liveVideos = videos.filter((video) => {
        const stream = video.srcObject;
        return (
          video.readyState >= 2 &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          stream?.getVideoTracks?.().some((track) => track.readyState === "live")
        );
      });
      return liveVideos.length >= expectedCount;
    },
    count,
    { timeout: 40000 }
  );
}

async function videoPixelStats(page, selector) {
  return page.evaluate((videoSelector) => {
    return [...document.querySelectorAll(videoSelector)].map((video, index) => {
      const canvas = document.createElement("canvas");
      const width = Math.min(160, video.videoWidth || 160);
      const height = Math.min(90, video.videoHeight || 90);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      let mean = null;
      let variance = null;
      let drawError = "";
      try {
        context.drawImage(video, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        const values = [];
        for (let offset = 0; offset < data.length; offset += 4) {
          values.push((data[offset] + data[offset + 1] + data[offset + 2]) / 3);
        }
        mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        variance =
          values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
      } catch (error) {
        drawError = error.message;
      }
      const stream = video.srcObject;
      return {
        index: index + 1,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        currentTime: video.currentTime,
        liveTracks: stream?.getVideoTracks?.().filter((track) => track.readyState === "live").length || 0,
        mean: mean === null ? null : Math.round(mean * 10) / 10,
        variance: variance === null ? null : Math.round(variance * 10) / 10,
        drawError
      };
    });
  }, selector);
}

async function copyDiagnosticSnapshot(page) {
  await page.getByRole("button", { name: LABELS.copyDiagnosticSnapshot }).click();
  const textarea = page.locator(".diagnostic-snapshot");
  await expect(textarea).toBeVisible({ timeout: 10000 });
  return JSON.parse(await textarea.inputValue());
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseJsonFromOutput(text) {
  const value = String(text || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

function resourceProbeScript() {
  return `
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$os = Get-CimInstance Win32_OperatingSystem
$cpuLoad = @(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$processes = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { @("chrome", "msedge", "node", "electron") -contains $_.ProcessName } |
  Sort-Object WorkingSet64 -Descending |
  Select-Object -First 10 Id, ProcessName,
    @{Name="WorkingSetMiB"; Expression={ [math]::Round($_.WorkingSet64 / 1MB, 1) }},
    @{Name="CpuSeconds"; Expression={ if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 } }})
[ordered]@{
  ok = $true
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  computerName = $env:COMPUTERNAME
  cpu = [ordered]@{
    logicalProcessors = [int]$env:NUMBER_OF_PROCESSORS
    loadPercent = if ($null -ne $cpuLoad) { [math]::Round([double]$cpuLoad, 1) } else { $null }
  }
  memory = [ordered]@{
    totalGiB = if ($os.TotalVisibleMemorySize) { [math]::Round(([double]$os.TotalVisibleMemorySize * 1KB) / 1GB, 2) } else { 0 }
    freeGiB = if ($os.FreePhysicalMemory) { [math]::Round(([double]$os.FreePhysicalMemory * 1KB) / 1GB, 2) } else { 0 }
    freePercent = if ($os.TotalVisibleMemorySize) { [math]::Round(([double]$os.FreePhysicalMemory / [double]$os.TotalVisibleMemorySize) * 100, 1) } else { 0 }
  }
  processes = $processes
} | ConvertTo-Json -Depth 6
`.trim();
}

function runPowerShellJson(script, timeout = 15000) {
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout,
    windowsHide: true
  });
  return (
    parseJsonFromOutput(result.stdout) || {
      ok: false,
      error: result.error?.message || result.stderr || `PowerShell exit ${result.status}`
    }
  );
}

function runRemotePowerShellJson(sshTarget, script, timeout = 20000) {
  const result = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", sshTarget, "powershell", "-NoProfile", "-EncodedCommand", encodePowerShell(script)],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout,
      windowsHide: true
    }
  );
  return (
    parseJsonFromOutput(result.stdout) || {
      ok: false,
      error: result.error?.message || result.stderr || `ssh PowerShell exit ${result.status}`
    }
  );
}

function captureResources(config) {
  return {
    local118: runPowerShellJson(resourceProbeScript()),
    remote117: runRemotePowerShellJson(config.remoteSshTarget, resourceProbeScript())
  };
}

function cpuLoads(resources) {
  return [
    { host: "118", value: Number(resources?.local118?.cpu?.loadPercent) },
    { host: "117", value: Number(resources?.remote117?.cpu?.loadPercent) }
  ].filter((item) => Number.isFinite(item.value));
}

function highCpuLoads(resources, limitPercent) {
  return cpuLoads(resources).filter((item) => item.value >= limitPercent);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyCaptureConstraints(page, channelCount, constraints) {
  return page.evaluate(async ({ channelCount, constraints: capture }) => {
    const results = [];
    const videos = [...document.querySelectorAll(".channel-card video")].slice(0, channelCount);
    for (const [index, video] of videos.entries()) {
      const track = video.srcObject?.getVideoTracks?.()[0];
      if (!track) {
        results.push({ channel: index + 1, ok: false, error: "missing video track" });
        continue;
      }
      try {
        await track.applyConstraints({
          width: { ideal: capture.width },
          height: { ideal: capture.height },
          frameRate: { ideal: capture.frameRate }
        });
        results.push({ channel: index + 1, ok: true, settings: track.getSettings?.() || {} });
      } catch (error) {
        results.push({ channel: index + 1, ok: false, error: `${error.name}: ${error.message}` });
      }
    }
    return results;
  }, { channelCount, constraints });
}

async function waitForRemoteHealth(remotePage, channelCount) {
  await expect(remotePage.locator(".remote-video-tile")).toHaveCount(channelCount, { timeout: 20000 });
  await waitForLiveRemoteVideos(remotePage, channelCount);
  await expect(remotePage.locator(".remote-health-live")).toHaveCount(channelCount, { timeout: 25000 });
  await expect(remotePage.locator(".diagnostic-state-live")).toHaveCount(channelCount, { timeout: 25000 });
}

async function republishChannels(localPage, remotePage, channelCount) {
  const activeChannels = await configureRemoteChannels(remotePage, channelCount);
  await sleep(1000);
  await localPage.getByRole("button", { name: LABELS.stopMedia }).click().catch(() => {});
  await sleep(1000);
  await localPage.getByRole("button", { name: LABELS.publishSubscribedMedia }).click();
  await waitForRemoteHealth(remotePage, channelCount);
  return activeChannels;
}

async function stopMediaIfPossible(localPage) {
  await localPage.getByRole("button", { name: LABELS.stopMedia }).click().catch(() => {});
}

async function collectStabilitySample(localPage, remotePage, config, index, startedAtMs, activeChannelCount, mode) {
  const resources = captureResources(config);
  const remoteVideoStats = await videoPixelStats(remotePage, ".remote-video-tile video");
  const localVideoStats = await videoPixelStats(localPage, ".channel-card video");
  const remoteSnapshot = await copyDiagnosticSnapshot(remotePage);
  const liveDiagnostics = (remoteSnapshot?.media?.diagnostics || []).filter((item) => item?.state === "live").length;
  const peerConnections = remoteSnapshot?.media?.peerConnections || [];
  const failures = [];
  if (liveDiagnostics < activeChannelCount) {
    failures.push(`117 live diagnostics ${liveDiagnostics}/${activeChannelCount}`);
  }
  for (const peer of peerConnections) {
    if (peer.connectionState !== "connected") {
      failures.push(`peer ${peer.endpointId || "unknown"} connectionState=${peer.connectionState}`);
    }
    if (peer.iceConnectionState !== "connected") {
      failures.push(`peer ${peer.endpointId || "unknown"} iceConnectionState=${peer.iceConnectionState}`);
    }
  }
  return {
    index,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    mode,
    activeChannelCount,
    resources,
    highCpu: highCpuLoads(resources, config.cpuLimitPercent),
    remoteVideoStats,
    localVideoStats,
    liveDiagnostics,
    peerConnections: peerConnections.map((peer) => ({
      endpointId: peer.endpointId || "",
      connectionState: peer.connectionState || "",
      iceConnectionState: peer.iceConnectionState || "",
      signalingState: peer.signalingState || ""
    })),
    failures
  };
}

async function runStabilityLoop(localPage, remotePage, config, report, reportPath) {
  if (config.holdSeconds <= 0) return report;
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + config.holdSeconds * 1000;
  const intervalMs = Math.max(5000, config.sampleIntervalSeconds * 1000);
  let mode = "full";
  let activeChannelCount = 4;
  report.stability = {
    ok: false,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    requestedHoldSeconds: config.holdSeconds,
    sampleIntervalSeconds: config.sampleIntervalSeconds,
    cpuLimitPercent: config.cpuLimitPercent,
    degradedChannelCount: config.degradedChannelCount,
    actions: [],
    samples: []
  };
  saveJson(reportPath, report);

  while (Date.now() < deadlineMs) {
    const sample = await collectStabilitySample(
      localPage,
      remotePage,
      config,
      report.stability.samples.length + 1,
      startedAtMs,
      activeChannelCount,
      mode
    );
    report.stability.samples.push(sample);
    if (sample.failures.length) {
      report.stability.actions.push({
        at: new Date().toISOString(),
        action: "stop-on-media-failure",
        reason: sample.failures.join("; ")
      });
      await stopMediaIfPossible(localPage);
      report.stability.ok = false;
      report.stability.finishedAt = new Date().toISOString();
      saveJson(reportPath, report);
      return report;
    }

    if (sample.highCpu.length) {
      if (mode === "full") {
        const constraints = captureConstraints(config, true);
        const constraintResults = await applyCaptureConstraints(localPage, activeChannelCount, constraints);
        mode = "reduced-capture";
        report.stability.actions.push({
          at: new Date().toISOString(),
          action: "lower-capture-constraints",
          reason: sample.highCpu,
          constraints,
          results: constraintResults
        });
        saveJson(reportPath, report);
        await sleep(10000);
      } else if (activeChannelCount > config.degradedChannelCount) {
        activeChannelCount = Math.min(config.degradedChannelCount, activeChannelCount);
        mode = "reduced-channels";
        const activeChannels = await republishChannels(localPage, remotePage, activeChannelCount);
        report.stability.actions.push({
          at: new Date().toISOString(),
          action: "reduce-channel-count",
          reason: sample.highCpu,
          activeChannels
        });
        saveJson(reportPath, report);
        await sleep(10000);
      } else {
        await stopMediaIfPossible(localPage);
        mode = "stopped";
        report.stability.actions.push({
          at: new Date().toISOString(),
          action: "stop-on-high-cpu",
          reason: sample.highCpu
        });
        report.stability.ok = false;
        report.stability.finishedAt = new Date().toISOString();
        saveJson(reportPath, report);
        return report;
      }
    }

    saveJson(reportPath, report);
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs > 0) await sleep(Math.min(intervalMs, remainingMs));
  }

  report.stability.ok = true;
  report.stability.finishedAt = new Date().toISOString();
  saveJson(reportPath, report);
  return report;
}

function writeNotes(filePath, report) {
  const selected = report.selectedCameras
    .map((item, index) => `${index + 1}. ${item.channel}: ${item.camera.label}`)
    .join("\n");
  const screenshots = report.screenshots.map((item) => `- ${path.basename(item.path)}: ${item.note}`).join("\n");
  const stability = report.stability
    ? `\n\u957f\u7a33\u6d4b:\n- \u8bf7\u6c42\u65f6\u957f: ${report.stability.requestedHoldSeconds} \u79d2\n- \u91c7\u6837\u95f4\u9694: ${report.stability.sampleIntervalSeconds} \u79d2\n- CPU \u4e0a\u9650: ${report.stability.cpuLimitPercent}%\n- \u7ed3\u679c: ${report.stability.ok ? "PASS" : "STOPPED/FAILED"}\n- \u91c7\u6837\u6570: ${report.stability.samples.length}\n- \u964d\u7ea7/\u505c\u6b62\u52a8\u4f5c: ${
        report.stability.actions.length
          ? report.stability.actions.map((item) => `${item.action} @ ${item.at}`).join("; ")
          : "\u65e0"
      }\n`
    : "\n\u957f\u7a33\u6d4b: \u672a\u542f\u7528\uff08UST_REAL_USB_HOLD_SECONDS=0\uff09\n";
  const body = `# 118 USB \u6444\u50cf\u5934\u5230 117 \u8fdc\u7aef\u56db\u753b\u9762\u6d4b\u8bd5\u8bf4\u660e

\u6d4b\u8bd5\u65f6\u95f4: ${report.startedAt}

\u6d4b\u8bd5\u673a\u5668:
- 118 \u624b\u672f\u5ba4\u7aef: ${report.config.localWebUrl}
- 117 \u793a\u6559\u5ba4\u7aef: ${report.config.remoteWebUrl}
- \u4fe1\u4ee4: ${report.config.signalingUrl}
- 117 DevTools: ${report.config.remoteDebugUrl}

\u672c\u6b21\u9009\u7528\u7684 4 \u8def\u771f\u5b9e\u89c6\u9891\u8f93\u5165:
${selected}

\u6444\u50cf\u5934\u5e76\u53d1\u9884\u68c0:
${report.cameraPreflight
  .map(
    (item, index) =>
      `${index + 1}. ${item.ok ? "PASS" : "FAIL"} - ${item.labels.join(" / ")}${
        item.ok ? "" : ` - ${item.outputs.filter((output) => !output.ok).map((output) => output.error).join("; ")}`
      }`
  )
  .join("\n")}

\u622a\u56fe:
${screenshots}

\u9a8c\u8bc1\u8981\u70b9:
- 118 \u7aef\u4f7f\u7528\u771f\u5b9e USB \u6444\u50cf\u5934\uff0c\u672a\u542f\u7528 --use-fake-device-for-media-stream\u3002
- 117 \u7aef\u901a\u8fc7 WebRTC \u63a5\u6536 4 \u8def\u89c6\u9891\uff0c\u5e76\u5207\u5230\u56db\u753b\u9762\u5e03\u5c40\u3002
- \u8fdc\u7aef\u89c6\u9891\u68c0\u6d4b\u5230 ${report.remoteVideoStats.length} \u4e2a video \u5143\u7d20\uff0c\u5747\u6709 live video track\u3002
- \u8bca\u65ad\u5feb\u7167\u548c\u50cf\u7d20\u7edf\u8ba1\u5df2\u53e6\u5b58\u4e3a JSON\u3002
${stability}

\u5907\u6ce8:
- \u679a\u4e3e\u5230\u7684\u5168\u90e8\u89c6\u9891\u8f93\u5165\u89c1 report.json\u3002
- \u9ed8\u8ba4\u6392\u9664\u89c4\u5219: ${report.config.excludeCameraRegex}
`;
  fs.writeFileSync(filePath, body, "utf8");
}

async function main() {
  const config = configFromEnv();
  fs.mkdirSync(config.outputDir, { recursive: true });
  await requireHttpOk(config.localWebUrl, "local web app");
  await requireHttpOk(config.remoteWebUrl, "remote web app URL");
  await requireHttpOk(config.signalingHealthUrl, "signaling health");

  runNodeScript(["scripts/remote-windows-real-mic-devtools.cjs", "stop"], "117 DevTools pre-clean");
  runNodeScript(["scripts/remote-windows-real-mic-devtools.cjs", "start"], "117 DevTools start");

  let localBrowser;
  let remoteBrowser;
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
  const screenshots = [];
  const startedAt = new Date().toISOString();

  try {
    localBrowser = await chromium.launch({
      channel: "chrome",
      headless: false,
      args: ["--use-fake-ui-for-media-stream"]
    });
    const localContext = await localBrowser.newContext({
      viewport: { width: 1600, height: 1200 },
      permissions: ["camera", "microphone"]
    });
    const localPage = await localContext.newPage();

    remoteBrowser = await connectRemoteBrowser(config.remoteDebugUrl);
    const remotePage = await selectRemotePage(remoteBrowser);
    await remotePage.setViewportSize({ width: 1600, height: 1200 });

    await localPage.goto(config.localWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await remotePage.goto(config.remoteWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    const fullConstraints = captureConstraints(config, false);
    const enumerated = await enumerateVideoInputs(localPage);
    const cameraSelection = await selectWorkingCameraSet(
      localPage,
      enumerated.videos,
      config.excludeCameraRegex,
      fullConstraints
    );
    const selectedCameras = cameraSelection.selected;
    await requestDeviceRefresh(localPage);
    const previewResults = await configureAndStartPreviews(localPage, selectedCameras, fullConstraints);

    const localPreviewPath = path.join(config.outputDir, "01-118-local-four-real-usb-previews.png");
    await localPage.locator(".video-grid").screenshot({ path: localPreviewPath });
    screenshots.push({
      path: localPreviewPath,
      note: "118 \u672c\u673a 4 \u8def\u771f\u5b9e USB \u6444\u50cf\u5934\u9884\u89c8\u753b\u9762"
    });

    await registerEndpoint(remotePage, config, teachingRoom);
    await registerEndpoint(localPage, config, operatingRoom);
    await startCall(localPage, remotePage, teachingRoom);
    await configureRemoteQuad(remotePage);
    await localPage.getByRole("button", { name: LABELS.publishSubscribedMedia }).click();
    await waitForRemoteHealth(remotePage, 4);

    const remoteVideoStats = await videoPixelStats(remotePage, ".remote-video-tile video");
    const localVideoStats = await videoPixelStats(localPage, ".channel-card video");
    const remoteStagePath = path.join(config.outputDir, "02-117-remote-quad-layout-four-streams.png");
    await remotePage.locator(".remote-grid").screenshot({ path: remoteStagePath });
    screenshots.push({
      path: remoteStagePath,
      note: "117 \u8fdc\u7aef\u56db\u753b\u9762\u5e03\u5c40\u63a5\u6536 118 \u56db\u8def\u771f\u5b9e\u89c6\u9891\u6d41"
    });

    const remoteWorkbenchPath = path.join(config.outputDir, "03-117-diagnostics-and-layout-controls.png");
    await remotePage.locator(".interaction-workbench").screenshot({ path: remoteWorkbenchPath });
    screenshots.push({
      path: remoteWorkbenchPath,
      note: "117 \u7aef\u4f1a\u8bdd\u72b6\u6001\u3001\u5e03\u5c40\u63a7\u5236\u548c\u5a92\u4f53\u8bca\u65ad\u533a"
    });

    const localSnapshot = await copyDiagnosticSnapshot(localPage);
    const remoteSnapshot = await copyDiagnosticSnapshot(remotePage);
    const report = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      config,
      operatingRoom,
      teachingRoom,
      captureConstraints: {
        full: fullConstraints,
        reduced: captureConstraints(config, true)
      },
      enumeratedVideos: enumerated.videos.map((item) => ({ index: item.index, label: item.label })),
      cameraPreflight: cameraSelection.results,
      selectedCameras: previewResults.map((item) => ({
        channel: item.channel,
        camera: { label: item.camera.label },
        previewStats: item.stats
      })),
      localVideoStats,
      remoteVideoStats,
      screenshots,
      diagnosticFiles: {
        local: "diagnostic-118.json",
        remote: "diagnostic-117.json"
      },
      stability: null
    };
    const reportPath = path.join(config.outputDir, "report.json");
    saveJson(path.join(config.outputDir, "diagnostic-118.json"), localSnapshot);
    saveJson(path.join(config.outputDir, "diagnostic-117.json"), remoteSnapshot);
    saveJson(reportPath, report);
    await runStabilityLoop(localPage, remotePage, config, report, reportPath);
    report.finishedAt = new Date().toISOString();
    saveJson(reportPath, report);
    writeNotes(path.join(config.outputDir, "README.md"), report);
    console.log(
      JSON.stringify(
        {
          ok: true,
          outputDir: config.outputDir,
          screenshots,
          remoteVideoStats,
          stability: report.stability
            ? {
                ok: report.stability.ok,
                samples: report.stability.samples.length,
                actions: report.stability.actions
              }
            : null
        },
        null,
        2
      )
    );
  } finally {
    if (remoteBrowser) await remoteBrowser.close().catch(() => {});
    if (localBrowser) await localBrowser.close().catch(() => {});
    runNodeScript(["scripts/remote-windows-real-mic-devtools.cjs", "stop"], "117 DevTools stop");
  }
}

main().catch((error) => {
  console.error(`Real USB video layout capture failed: ${error.message}`);
  process.exit(1);
});
