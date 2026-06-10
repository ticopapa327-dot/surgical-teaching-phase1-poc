import { expect, test } from "@playwright/test";

test("phase 2 call workflow renders and reaches active interaction state", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "手术示教 Phase 3 PoC" })).toBeVisible();
  await expect(page.locator(".channel-card")).toHaveCount(4);
  await expect(page.getByLabel("信令地址")).toHaveValue("ws://127.0.0.1:7077/signal");
  await expect(page.getByLabel("本端 ID")).toHaveValue(/^ust-[a-f0-9-]+$/);
  await expect(page.locator(".status-list div").filter({ hasText: "ICE 服务" })).toContainText("未配置");
  await page.getByRole("button", { name: "通道 1 云台左" }).click();
  await expect(page.locator(".footer")).toContainText("请先切换为 USB/摄像头设备并启动预览");

  await page.getByRole("button", { name: "启动全部预览" }).click();
  await page.getByRole("button", { name: "模拟 HIS 查询" }).click();
  await expect(page.getByText("患者 001 / HIS-001 / 普外科")).toBeVisible();

  await page.getByRole("button", { name: "开始选中通道录制" }).click();
  await page.waitForTimeout(600);
  await page.locator(".top-actions button.danger").click();
  await expect(page.locator(".recording-item")).toHaveCount(1);
  await expect(page.locator(".recording-item").filter({ hasText: "患者：患者 001 / HIS-001" })).toBeVisible();
  await page.locator(".recording-main").first().click();
  await page.getByRole("button", { name: "加入 AI 队列" }).click();
  await expect(page.getByText("AI 队列：1")).toBeVisible();
  await expect(page.locator(".ai-job-item")).toContainText("queued");
  await expect(page.locator(".ai-job-item")).toContainText("患者 001 / HIS-001");
  await expect(page.locator(".footer")).toContainText("AI 处理任务已加入本地模拟队列");

  await expect(page.getByText("阶段 2 呼叫控制")).toBeVisible();

  await page.getByRole("button", { name: "示教室呼叫手术室" }).click();
  await expect(page.getByText("待确认呼叫")).toBeVisible();

  await page.getByRole("button", { name: "接受呼叫" }).click();
  await expect(page.getByText("最终模式", { exact: true })).toBeVisible();
  await expect(page.locator(".session-list dd").filter({ hasText: "交互模式" })).toBeVisible();
  await expect(page.getByText("通道 1 全景").first()).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "扩展窗口" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "通道 1 全景" })).toBeVisible();
  await popup.close();

  await page.getByRole("button", { name: "建立音频通话" }).click();
  await expect(page.locator(".status-list dd").filter({ hasText: "低延迟本地音频轨道" })).toBeVisible();
  await page.getByRole("button", { name: "停止音频" }).click();

  await page.getByLabel("通道 2 术野").check();
  await page.getByRole("button", { name: "双画面" }).click();
  await expect(page.locator(".remote-video-tile")).toHaveCount(2);

  await page.getByLabel("手术室端标注远端可见").check();
  await expect(page.locator(".annotation").first()).toBeVisible();

  await page.getByRole("button", { name: "模拟新增参会者" }).click();
  await expect(page.locator(".notice").filter({ hasText: "已达到手术室端设置的" })).toBeVisible();
});

test("phase 2 remote popout can target an Electron display", async ({ page }) => {
  await page.addInitScript(() => {
    window.surgicalApi = {
      getAppInfo: async () => ({
        appName: "browser-display-test",
        appVersion: "0.1.0",
        recordingsDir: ""
      }),
      displays: {
        list: async () => [
          {
            id: 1,
            label: "Primary",
            primary: true,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            workArea: { x: 0, y: 0, width: 1920, height: 1040 },
            scaleFactor: 1
          },
          {
            id: 2,
            label: "Teaching Display",
            primary: false,
            bounds: { x: 1920, y: 0, width: 1280, height: 720 },
            workArea: { x: 1920, y: 0, width: 1280, height: 720 },
            scaleFactor: 1
          }
        ]
      },
      recordings: {
        create: async () => ({ id: "stub-recording", fileName: "stub.webm", filePath: "" }),
        writeChunk: async () => ({ ok: true, bytes: 0 }),
        close: async () => ({ ok: true, item: null }),
        list: async () => [],
        delete: async () => ({ ok: true }),
        reveal: async () => ({ ok: true }),
        export: async () => ({ ok: true }),
        openRoot: async () => ({ ok: true })
      }
    };
  });

  await page.goto("/");
  await page.getByLabel("扩展显示器").selectOption("2");

  await page.getByRole("button", { name: "示教室呼叫手术室" }).click();
  await page.getByRole("button", { name: "接受呼叫" }).click();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "扩展窗口" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "通道 1 全景" })).toBeVisible();
  await expect(page.locator(".footer")).toContainText("目标：扩展显示器 Teaching Display");
  await popup.close();
});

test("phase 3 audio panel can select a playback device", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      configurable: true,
      value: async () => [
        { kind: "videoinput", deviceId: "video-1", label: "USB Capture 1" },
        { kind: "audioinput", deviceId: "mic-1", label: "USB Mic" },
        { kind: "audiooutput", deviceId: "speaker-1", label: "Teaching Speaker" }
      ]
    });
  });

  await page.goto("/");
  const audioDiagnostics = page.locator(".status-list div", { hasText: "音频诊断" }).locator("dd");
  await expect(page.getByLabel("音频输出设备")).toBeVisible();
  await expect(audioDiagnostics).toContainText("支持采集");
  await expect(audioDiagnostics).toContainText("安全上下文");
  await page.getByRole("button", { name: "授权并刷新设备" }).click();
  await expect(page.locator(".footer")).toContainText("1 个音频输出");
  await expect(audioDiagnostics).toContainText("输入 1");
  await expect(audioDiagnostics).toContainText("输出 1");
  await expect(page.getByLabel("音频输出设备")).toContainText("Teaching Speaker");
  await page.getByLabel("音频输出设备").selectOption("speaker-1");
  await expect(audioDiagnostics).toContainText("回放 Teaching Speaker");
  await expect(page.locator(".footer")).toContainText("远端音频输出将使用：Teaching Speaker");
});

test("runtime config normalizes WebRTC ICE servers", async ({ page }) => {
  await page.route("**/config.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        signalingUrl: "ws://127.0.0.1:7077/signal",
        localEndpoint: {
          id: "config-or",
          name: "Config OR",
          role: "operating-room"
        },
        webrtc: {
          iceServers: [
            {
              urls: ["stun:stun.example.test:3478", "stun:stun.example.test:3478", "http://invalid"],
              username: " ignored-empty-url-check "
            },
            { urls: "turn:turn.example.test:3478", username: "turn-user", credential: "turn-pass" },
            { urls: ["ftp://bad.example.test"] },
            null
          ]
        }
      })
    })
  );

  await page.goto("/");
  await expect(page.getByLabel("本端 ID")).toHaveValue("config-or");
  await expect(page.getByLabel("本端名称")).toHaveValue("Config OR");
  await expect(page.locator(".status-list div").filter({ hasText: "ICE 服务" })).toContainText("2 组");
});

test("phase 1 UVC PTZ controls apply video track constraints", async ({ page }) => {
  await page.addInitScript(() => {
    window.__ptzApplied = [];
    Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
      configurable: true,
      value: async () => [
        { kind: "videoinput", deviceId: "ptz-cam", label: "UVC PTZ Camera" },
        { kind: "audioinput", deviceId: "mic-1", label: "USB Mic" }
      ]
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints = {}) => {
        if (!constraints.video) return new MediaStream();
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext("2d");
        context.fillStyle = "#123";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        const settings = { pan: 0, tilt: 0, zoom: 1 };
        track.getCapabilities = () => ({
          pan: { min: -10, max: 10, step: 1 },
          tilt: { min: -5, max: 5, step: 1 },
          zoom: { min: 1, max: 4, step: 0.5 }
        });
        track.getSettings = () => ({ ...settings });
        track.applyConstraints = async (nextConstraints = {}) => {
          const next = nextConstraints.advanced?.[0] || {};
          Object.assign(settings, next);
          window.__ptzApplied.push(next);
        };
        return stream;
      }
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "授权并刷新设备" }).click();
  const channel = page.locator(".channel-card").first();
  await channel.locator("select").first().selectOption("device");
  await channel.locator("select").nth(1).selectOption("ptz-cam");
  await channel.getByRole("button", { name: "预览" }).click();

  await page.getByRole("button", { name: "通道 1 云台右" }).click();
  await expect(page.locator(".footer")).toContainText("通道 1 云台水平已调整至 1");
  await page.getByRole("button", { name: "通道 1 镜头放大" }).click();
  await expect(page.locator(".footer")).toContainText("通道 1 镜头变倍已调整至 1.5");
  await expect
    .poll(() => page.evaluate(() => window.__ptzApplied))
    .toEqual([{ pan: 1 }, { zoom: 1.5 }]);
});
