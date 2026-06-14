const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium, expect } = require("@playwright/test");

const LABELS = {
  signalingUrl: "信令地址",
  endpointId: "本端 ID",
  endpointName: "本端名称",
  endpointRole: "本端角色",
  requestMode: "发起模式",
  connect: "连接信令",
  target: "信令目标",
  callSelected: "信令呼叫选中终端",
  pendingCall: "待确认呼叫",
  acceptCall: "接受呼叫",
  registered: "已注册",
  publishSubscribedMedia: "发布订阅通道媒体",
  stopMedia: "停止媒体链路",
  copyDiagnosticSnapshot: "复制诊断快照"
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
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function defaultOutputDir() {
  const oneDrive = fs.existsSync("D:\\OneDrive") ? "D:\\OneDrive" : path.join(os.homedir(), "OneDrive");
  return path.join(oneDrive, `UST-local-publisher-118-${timestampForPath()}`);
}

function configFromEnv() {
  return {
    localWebUrl: env("UST_LOCAL_PUBLISHER_WEB_URL", "http://127.0.0.1:5173/"),
    signalingUrl: env("UST_LOCAL_PUBLISHER_SIGNALING_URL", "ws://192.168.1.118:7077/signal"),
    signalingHealthUrl: env("UST_LOCAL_PUBLISHER_SIGNALING_HEALTH_URL", "http://127.0.0.1:7077/health"),
    outputDir: env("UST_LOCAL_PUBLISHER_OUTPUT_DIR", defaultOutputDir()),
    targetEndpointId: env("UST_LOCAL_PUBLISHER_TARGET_ENDPOINT_ID", "teaching-117"),
    endpointId: env("UST_LOCAL_PUBLISHER_ENDPOINT_ID", `or-118-local-${Date.now().toString(36).slice(-6)}`),
    endpointName: env("UST_LOCAL_PUBLISHER_ENDPOINT_NAME", "手术室-118 本地发布"),
    excludeCameraRegex: env("UST_LOCAL_PUBLISHER_EXCLUDE_CAMERA_REGEX", "\\bHD Webcam\\b"),
    holdSeconds: envNumber("UST_LOCAL_PUBLISHER_HOLD_SECONDS", "1800"),
    sampleIntervalSeconds: envNumber("UST_LOCAL_PUBLISHER_SAMPLE_INTERVAL_SECONDS", "15"),
    cpuLimitPercent: envNumber("UST_LOCAL_PUBLISHER_CPU_LIMIT_PERCENT", "80"),
    captureWidth: envPositiveInteger("UST_LOCAL_PUBLISHER_CAPTURE_WIDTH", "1280"),
    captureHeight: envPositiveInteger("UST_LOCAL_PUBLISHER_CAPTURE_HEIGHT", "720"),
    captureFrameRate: envPositiveInteger("UST_LOCAL_PUBLISHER_CAPTURE_FRAME_RATE", "30"),
    reducedCaptureWidth: envPositiveInteger("UST_LOCAL_PUBLISHER_REDUCED_CAPTURE_WIDTH", "640"),
    reducedCaptureHeight: envPositiveInteger("UST_LOCAL_PUBLISHER_REDUCED_CAPTURE_HEIGHT", "360"),
    reducedCaptureFrameRate: envPositiveInteger("UST_LOCAL_PUBLISHER_REDUCED_CAPTURE_FRAME_RATE", "15")
  };
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cpuSample() {
  const command = "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average";
  const value = execFileSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000
  }).trim();
  return Number(value);
}

async function requireHttpOk(url, label) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response;
}

function captureConstraints(config, reduced = false) {
  return {
    width: reduced ? config.reducedCaptureWidth : config.captureWidth,
    height: reduced ? config.reducedCaptureHeight : config.captureHeight,
    frameRate: reduced ? config.reducedCaptureFrameRate : config.captureFrameRate
  };
}

async function enumerateVideoInputs(page) {
  return page.evaluate(async () => {
    let stream = null;
    let permissionError = "";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (error) {
      permissionError = `${error.name}: ${error.message}`;
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

async function testCameraSet(page, cameras, constraints) {
  return page.evaluate(async ({ cameras: cameraInputs, constraints: capture }) => {
    const streams = [];
    const outputs = [];
    for (const camera of cameraInputs) {
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
        outputs.push({ label: camera.label, ok: true, settings: track.getSettings() });
      } catch (error) {
        outputs.push({ label: camera.label, ok: false, error: `${error.name}: ${error.message}` });
      }
    }
    streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { ok: outputs.every((item) => item.ok), outputs };
  }, { cameras, constraints });
}

async function selectWorkingCameraSet(page, videos, excludeCameraRegex, constraints) {
  if (videos.length < 4) throw new Error(`only ${videos.length} video input(s) available; 4 are required`);
  const exclude = new RegExp(excludeCameraRegex, "i");
  const candidates = combinations(videos, 4)
    .map((items, index) => ({ index, items, preferredCount: items.filter((item) => !exclude.test(item.label)).length }))
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
        error: item.error || "",
        width: item.settings?.width || null,
        height: item.settings?.height || null,
        frameRate: item.settings?.frameRate || null
      }))
    };
    results.push(result);
    if (test.ok) return { selected: candidate.items, results };
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
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) done();
        else {
          video.onloadeddata = done;
          video.oncanplay = done;
        }
      });
    });
    previewResults.push({ channel: CHANNELS[index], camera });
  }
  return previewResults;
}

async function applyCaptureConstraints(page, constraints) {
  return page.evaluate(async (capture) => {
    const outputs = [];
    for (const [index, video] of [...document.querySelectorAll(".channel-card video")].entries()) {
      const track = video.srcObject?.getVideoTracks?.()[0];
      if (!track?.applyConstraints) {
        outputs.push({ index: index + 1, ok: false, error: "no video track" });
        continue;
      }
      try {
        await track.applyConstraints({
          width: { ideal: capture.width },
          height: { ideal: capture.height },
          frameRate: { ideal: capture.frameRate }
        });
        outputs.push({ index: index + 1, ok: true, settings: track.getSettings() });
      } catch (error) {
        outputs.push({ index: index + 1, ok: false, error: `${error.name}: ${error.message}` });
      }
    }
    return outputs;
  }, constraints);
}

async function registerEndpoint(page, config) {
  await page.getByLabel(LABELS.signalingUrl).fill(config.signalingUrl);
  await page.getByLabel(LABELS.endpointId).fill(config.endpointId);
  await page.getByLabel(LABELS.endpointName).fill(config.endpointName);
  await page.getByLabel(LABELS.endpointRole).selectOption("operating-room");
  await page.getByRole("button", { name: LABELS.connect }).click();
  await expect(page.getByText(`${LABELS.registered} ${config.endpointName}`)).toBeVisible({ timeout: 10000 });
}

async function callOrAccept(page, config, report) {
  const pending = page.getByText(LABELS.pendingCall);
  if ((await pending.count()) > 0 && (await pending.first().isVisible().catch(() => false))) {
    await page.getByRole("button", { name: LABELS.acceptCall }).click();
    report.actions.push({ at: new Date().toISOString(), action: "accept-inbound-call" });
  }

  const targetOption = page.locator(`option[value="${config.targetEndpointId}"]`);
  if (!report.callAttempted && (await targetOption.count()) > 0) {
    await page.getByLabel(LABELS.requestMode).selectOption("view");
    await page.getByLabel(LABELS.target).selectOption(config.targetEndpointId);
    await page.getByRole("button", { name: LABELS.callSelected }).click();
    report.callAttempted = true;
    report.actions.push({ at: new Date().toISOString(), action: "call-target", target: config.targetEndpointId });
  }
}

async function publishSubscribed(page, report) {
  const button = page.getByRole("button", { name: LABELS.publishSubscribedMedia });
  if ((await button.count()) === 0) return;
  try {
    await button.click({ timeout: 3000 });
    report.lastPublishAttemptAt = new Date().toISOString();
  } catch (error) {
    report.lastPublishError = error.message;
  }
}

async function localVideoStats(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".channel-card video")].map((video, index) => ({
      index: index + 1,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentTime: video.currentTime,
      liveTracks: video.srcObject?.getVideoTracks?.().filter((track) => track.readyState === "live").length || 0,
      settings: video.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || null
    }))
  );
}

async function snapshot(page) {
  try {
    await page.getByRole("button", { name: LABELS.copyDiagnosticSnapshot }).click({ timeout: 3000 });
    const textarea = page.locator(".diagnostic-snapshot");
    await expect(textarea).toBeVisible({ timeout: 5000 });
    return JSON.parse(await textarea.inputValue());
  } catch (error) {
    return { error: error.message };
  }
}

async function main() {
  const config = configFromEnv();
  fs.mkdirSync(config.outputDir, { recursive: true });
  await requireHttpOk(config.localWebUrl, "local web app");
  await requireHttpOk(config.signalingHealthUrl, "signaling health");

  const report = {
    ok: false,
    startedAt: new Date().toISOString(),
    config,
    actions: [],
    samples: [],
    screenshots: []
  };
  const reportPath = path.join(config.outputDir, "report.json");

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--use-fake-ui-for-media-stream"]
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1200 },
      permissions: ["camera", "microphone"]
    });
    const page = await context.newPage();
    await page.goto(config.localWebUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    const full = captureConstraints(config, false);
    const reduced = captureConstraints(config, true);
    const enumerated = await enumerateVideoInputs(page);
    const selection = await selectWorkingCameraSet(page, enumerated.videos, config.excludeCameraRegex, full);
    await requestDeviceRefresh(page);
    const selected = await configureAndStartPreviews(page, selection.selected, full);
    await applyCaptureConstraints(page, full);
    await registerEndpoint(page, config);

    const previewPath = path.join(config.outputDir, "118-local-four-usb-previews.png");
    await page.locator(".video-grid").screenshot({ path: previewPath });
    report.screenshots.push(previewPath);
    report.enumeratedVideos = enumerated.videos.map((item) => ({ index: item.index, label: item.label }));
    report.cameraPreflight = selection.results;
    report.selectedCameras = selected.map((item) => ({ channel: item.channel, label: item.camera.label }));
    report.localVideoStats = await localVideoStats(page);
    report.localDiagnostic = await snapshot(page);
    saveJson(reportPath, report);

    const startedAt = Date.now();
    let reducedMode = false;
    while (Date.now() - startedAt < config.holdSeconds * 1000) {
      await callOrAccept(page, config, report);
      await publishSubscribed(page, report);

      const cpu = cpuSample();
      if (cpu > config.cpuLimitPercent && !reducedMode) {
        const results = await applyCaptureConstraints(page, reduced);
        reducedMode = true;
        report.actions.push({
          at: new Date().toISOString(),
          action: "lower-capture-constraints",
          cpu,
          results
        });
      } else if (cpu > config.cpuLimitPercent && reducedMode) {
        await page.getByRole("button", { name: LABELS.stopMedia }).click().catch(() => {});
        report.actions.push({ at: new Date().toISOString(), action: "stop-on-high-cpu", cpu });
        break;
      }

      const sample = {
        at: new Date().toISOString(),
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        mode: reducedMode ? "reduced" : "full",
        localCpuPercent: cpu,
        signalingHealth: await fetch(config.signalingHealthUrl).then((res) => res.json()).catch((error) => ({
          error: error.message
        })),
        localVideoStats: await localVideoStats(page)
      };
      report.samples.push(sample);
      saveJson(reportPath, report);
      await sleep(config.sampleIntervalSeconds * 1000);
    }

    report.ok = true;
    report.finishedAt = new Date().toISOString();
    report.finalDiagnostic = await snapshot(page);
    saveJson(reportPath, report);
    console.log(JSON.stringify({ ok: true, outputDir: config.outputDir, samples: report.samples.length }, null, 2));
  } catch (error) {
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    report.error = error.stack || error.message;
    saveJson(reportPath, report);
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`Local real USB publisher failed: ${error.message}`);
  process.exit(1);
});
