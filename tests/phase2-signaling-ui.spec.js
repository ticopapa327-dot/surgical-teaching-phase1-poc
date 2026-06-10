import assert from "node:assert/strict";
import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import signalingModule from "../server/signaling-server.cjs";

const { createSignalingServer } = signalingModule;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function send(ws, type, payload = {}, requestId = crypto.randomUUID()) {
  ws.send(JSON.stringify({ type, payload, requestId }));
}

function waitFor(ws, type, predicate = () => true) {
  return new Promise((resolve) => {
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type && predicate(message)) {
        ws.off("message", handler);
        resolve(message);
      }
    };
    ws.on("message", handler);
  });
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
    { timeout: 15000 }
  );
}

async function expectRemoteHealthLiveCount(page, count) {
  await expect(page.locator(".remote-health-live")).toHaveCount(count, { timeout: 15000 });
}

async function expectDiagnosticLiveCount(page, count) {
  await expect(page.locator(".diagnostic-state-live")).toHaveCount(count, { timeout: 15000 });
}

async function expectPeerDiagnosticLiveCount(page, count) {
  await expect(page.locator(".peer-diagnostic-state-live")).toHaveCount(count, { timeout: 15000 });
}

async function expectNoRemoteAudioTracks(page) {
  await expect
    .poll(async () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".remote-audio-sinks audio")].every((audio) => {
          const stream = audio.srcObject;
          return !stream?.getAudioTracks?.().some((track) => track.readyState === "live");
        })
      )
    )
    .toBe(true);
}

async function expectMediaStatsIncludesVideo(page) {
  const mediaStats = page.locator(".status-list div", { hasText: "媒体统计" }).locator("dd");
  await expect(mediaStats).toContainText("视频", { timeout: 15000 });
  await expect(mediaStats).toContainText("发送", { timeout: 15000 });
  await expect(mediaStats).toContainText("接收", { timeout: 15000 });
  await expect(mediaStats).toContainText("包", { timeout: 15000 });
  await expect(mediaStats).toContainText("ICE", { timeout: 15000 });
}

test("phase 2 UI connects to signaling server and enters accepted session", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-remote",
      role: "teaching-room",
      name: "Teaching Remote",
      address: "192.168.10.33",
      capabilities: ["subscribe-video", "interactive-audio"],
      channels: [
        { id: "remote-ch1", label: "Teaching View", role: "overview" },
        { id: "remote-ch2", label: "Panel Return", role: "return" }
      ]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.addInitScript(() => {
      window.__copiedDiagnosticText = "";
      Object.defineProperty(Navigator.prototype, "clipboard", {
        configurable: true,
        get() {
          return {
            writeText: async (text) => {
              window.__copiedDiagnosticText = text;
            }
          };
        }
      });
    });
    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();

    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await expect(page.getByLabel("信令地址")).toBeDisabled();
    await expect(page.getByLabel("本端 ID")).toBeDisabled();
    await expect(page.getByLabel("本端角色")).toBeDisabled();
    await page.getByRole("button", { name: "检查健康" }).click();
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "2 终端 / 0 会话 / 0 呼叫" })).toBeVisible();
    await page.getByRole("button", { name: "刷新事件" }).click();
    await expect(page.locator(".status-list.compact div", { hasText: "事件日志" }).locator("dd")).toContainText("显示");
    await expect(page.locator(".signal-event").filter({ hasText: "endpoint.registered" }).first()).toBeVisible();
    await expect(page.getByLabel("信令目标")).toBeEnabled();
    await page.getByLabel("信令目标").selectOption("teach-remote");
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "remote-ch1 Teaching View" })).toBeVisible();
    await page.getByLabel("手术室参与上限").fill("4");

    const incomingCall = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    const incoming = await incomingCall;
    assert.equal(incoming.payload.call.toEndpointId, "teach-remote");
    assert.equal(incoming.payload.call.requestedMode, "interactive");
    await page.getByRole("button", { name: "刷新事件" }).click();
    await expect(
      page
        .locator(".signal-event")
        .filter({ hasText: "call.requested" })
        .filter({ hasText: "or-ui -> teach-remote" })
        .filter({ hasText: "请求 interactive" })
        .first()
    ).toBeVisible();

    send(teachingClient, "call.accept", {
      callId: incoming.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });

    await expect(page.locator(".session-list dd").filter({ hasText: "交互模式" })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "Teaching Remote" })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 4" })).toBeVisible();
    await expect(page.getByText("信令会话已建立")).toBeVisible();

    const subscriptionUpdate = waitFor(
      teachingClient,
      "session.updated",
      (message) => message.payload.session.subscriptions["or-ui"]?.includes("ch2")
    );
    const channelTwoPull = page.locator(".channel-pulls").getByLabel("通道 2 术野");
    await channelTwoPull.click();
    const subscription = await subscriptionUpdate;
    assert.deepEqual(subscription.payload.session.subscriptions["or-ui"], ["ch1", "ch2"]);
    await expect(channelTwoPull).toBeChecked();

    const annotationUpdate = waitFor(
      teachingClient,
      "session.updated",
      (message) => message.payload.session.annotation?.visible === true
    );
    await page.getByLabel("标注内容").fill("Needle entry");
    await page.getByLabel("手术室端标注远端可见").check();
    const annotation = await annotationUpdate;
    assert.equal(annotation.payload.session.annotation.text, "Needle entry");
    assert.equal(annotation.payload.session.annotation.updatedByEndpointId, "or-ui");

    await page.getByRole("button", { name: "复制诊断快照" }).click();
    await expect(page.locator(".footer")).toContainText("诊断快照已复制");
    const copiedText = await page.evaluate(() => window.__copiedDiagnosticText);
    const snapshot = JSON.parse(copiedText);
    assert.equal(snapshot.diagnostic.eventRefresh, "ok");
    assert.equal(snapshot.session.id, annotation.payload.session.sessionId);
    assert.equal(snapshot.session.mediaRoomId, annotation.payload.session.mediaRoomId);
    assert(snapshot.recentEvents.some((event) => event.type === "call.accepted"));
    assert(snapshot.recentEvents.some((event) => event.type === "session.started"));
    assert(snapshot.recentEvents.some((event) => event.type === "session.subscription.updated"));
    assert(snapshot.recentEvents.some((event) => event.type === "session.annotation.updated"));

    const endedByUi = waitFor(teachingClient, "session.ended");
    await page.getByRole("button", { name: "结束连接" }).click();
    const ended = await endedByUi;
    assert.equal(ended.payload.endedByEndpointId, "or-ui");
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI accepts incoming signaling call", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-inbound",
      role: "teaching-room",
      name: "Inbound Teaching Room",
      address: "192.168.10.34",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();

    send(teachingClient, "call.request", { toEndpointId: "or-ui", mode: "view" });
    await waitFor(teachingClient, "call.requested");
    await expect(page.getByText("待确认呼叫")).toBeVisible();
    await expect(page.locator(".call-banner").filter({ hasText: "Inbound Teaching Room" })).toBeVisible();

    const started = waitFor(teachingClient, "session.started");
    await page.getByRole("button", { name: "接受呼叫" }).click();
    const session = await started;
    assert.equal(session.payload.session.mode, "view");
    await expect(page.locator(".session-list dd").filter({ hasText: "仅收看" })).toBeVisible();
    await expect(page.getByRole("button", { name: "建立音频通话" })).toBeDisabled();
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI can confirm an incoming interactive call as view only", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-confirm-view",
      role: "teaching-room",
      name: "Confirm View Teaching Room",
      address: "192.168.10.70",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();

    send(teachingClient, "call.request", { toEndpointId: "or-ui", mode: "interactive" });
    await waitFor(teachingClient, "call.requested");
    await expect(page.getByText("待确认呼叫")).toBeVisible();
    await page.getByLabel("接受确认").selectOption("view");

    const started = waitFor(teachingClient, "session.started");
    await page.getByRole("button", { name: "接受呼叫" }).click();
    const session = await started;
    assert.equal(session.payload.session.mode, "view");
    await expect(page.locator(".session-list dd").filter({ hasText: "仅收看" })).toBeVisible();
    await expect(page.getByRole("button", { name: "建立音频通话" })).toBeDisabled();
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI updates participant list after observer joins signaling session", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);
  const observerClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-host",
      role: "teaching-room",
      name: "Teaching Host",
      address: "192.168.10.35",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    send(observerClient, "endpoint.register", {
      endpointId: "observer-ui",
      role: "observer",
      name: "Observer Remote",
      address: "192.168.10.45",
      capabilities: ["subscribe-video"]
    });
    await waitFor(observerClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-host");
    await page.getByLabel("手术室参与上限").fill("3");

    const incomingCall = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    const incoming = await incomingCall;
    send(teachingClient, "call.accept", {
      callId: incoming.payload.call.callId,
      mode: "interactive",
      participantLimit: 3
    });
    const started = await waitFor(teachingClient, "session.started");
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 3" })).toBeVisible();

    send(observerClient, "session.join", { sessionId: started.payload.session.sessionId });
    await waitFor(observerClient, "session.joined");
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "Observer Remote" })).toBeVisible();
  } finally {
    teachingClient.close();
    observerClient.close();
    await server.stop();
  }
});

test("phase 2 UI leaves a signaling session without ending the remaining meeting", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const orClient = await connect(url);
  const observerClient = await connect(url);

  try {
    send(orClient, "endpoint.register", {
      endpointId: "or-leave-host",
      role: "operating-room",
      name: "Leave Host OR",
      address: "192.168.10.52",
      capabilities: ["call-control", "publish-video", "interactive-audio"]
    });
    await waitFor(orClient, "endpoint.registered");

    send(observerClient, "endpoint.register", {
      endpointId: "observer-leave",
      role: "observer",
      name: "Leave Observer",
      address: "192.168.10.53",
      capabilities: ["subscribe-video"]
    });
    await waitFor(observerClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("teach-ui");
    await page.getByLabel("本端名称").fill("Teaching UI");
    await page.getByLabel("本端角色").selectOption("teaching-room");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Teaching UI")).toBeVisible();

    send(orClient, "call.request", { toEndpointId: "teach-ui", mode: "interactive", participantLimit: 3 });
    await waitFor(orClient, "call.requested");
    await expect(page.getByText("待确认呼叫")).toBeVisible();

    const startedForOr = waitFor(orClient, "session.started");
    await page.getByRole("button", { name: "接受呼叫" }).click();
    const started = await startedForOr;
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 3" })).toBeVisible();
    await expect(page.getByLabel("标注内容")).toBeDisabled();
    await expect(page.getByLabel("手术室端标注远端可见")).toBeDisabled();

    send(observerClient, "session.join", { sessionId: started.payload.session.sessionId });
    await waitFor(observerClient, "session.joined");
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();
    await expect(page.getByRole("button", { name: "结束连接" })).toBeDisabled();

    const remainingUpdate = waitFor(
      orClient,
      "session.updated",
      (message) =>
        message.payload.session.sessionId === started.payload.session.sessionId &&
        message.payload.session.participants.length === 2 &&
        !message.payload.session.participants.includes("teach-ui")
    );
    await page.getByRole("button", { name: "离开会话" }).click();
    const update = await remainingUpdate;
    assert.deepEqual(update.payload.session.participants.sort(), ["observer-leave", "or-leave-host"]);
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
    await expect(page.locator(".footer")).toContainText("已离开信令会话");
  } finally {
    orClient.close();
    observerClient.close();
    await server.stop();
  }
});

test("phase 2 UI joins an existing signaling session by session id", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const orClient = await connect(url);
  const teachingClient = await connect(url);

  try {
    send(orClient, "endpoint.register", {
      endpointId: "or-join-host",
      role: "operating-room",
      name: "Join Host OR",
      address: "192.168.10.54",
      capabilities: ["call-control", "publish-video", "interactive-audio"]
    });
    await waitFor(orClient, "endpoint.registered");

    send(teachingClient, "endpoint.register", {
      endpointId: "teach-join-host",
      role: "teaching-room",
      name: "Join Teaching Host",
      address: "192.168.10.55",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    const incoming = waitFor(teachingClient, "call.incoming");
    send(orClient, "call.request", { toEndpointId: "teach-join-host", mode: "interactive", participantLimit: 3 });
    const incomingCall = await incoming;
    const startedForOr = waitFor(orClient, "session.started");
    send(teachingClient, "call.accept", {
      callId: incomingCall.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });
    const started = await startedForOr;

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("observer-ui");
    await page.getByLabel("本端名称").fill("Observer UI");
    await page.getByLabel("本端角色").selectOption("observer");
    await page.getByLabel("加入会话 ID").fill(started.payload.session.sessionId);
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Observer UI")).toBeVisible();

    const joinedUpdate = waitFor(
      orClient,
      "session.updated",
      (message) => message.payload.session.participants.includes("observer-ui")
    );
    await page.getByRole("button", { name: "加入信令会话" }).click();
    const update = await joinedUpdate;
    assert.equal(update.payload.session.sessionId, started.payload.session.sessionId);
    assert.equal(update.payload.session.participants.length, 3);
    await expect(page.locator(".session-list dd").filter({ hasText: started.payload.session.sessionId })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "Join Host OR" })).toBeVisible();
  } finally {
    orClient.close();
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI discovers joinable sessions from the signaling directory", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const orClient = await connect(url);
  const teachingClient = await connect(url);

  try {
    send(orClient, "endpoint.register", {
      endpointId: "or-directory-host",
      role: "operating-room",
      name: "Directory Host OR",
      address: "192.168.10.68",
      capabilities: ["call-control", "publish-video", "interactive-audio"]
    });
    await waitFor(orClient, "endpoint.registered");

    send(teachingClient, "endpoint.register", {
      endpointId: "teach-directory-host",
      role: "teaching-room",
      name: "Directory Teaching Host",
      address: "192.168.10.69",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    const incoming = waitFor(teachingClient, "call.incoming");
    send(orClient, "call.request", { toEndpointId: "teach-directory-host", mode: "interactive", participantLimit: 3 });
    const incomingCall = await incoming;
    const startedForOr = waitFor(orClient, "session.started");
    send(teachingClient, "call.accept", {
      callId: incomingCall.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });
    const started = await startedForOr;

    const observerDirectoryUpdate = waitFor(
      orClient,
      "directory.updated",
      (message) => message.payload.endpoints.some((endpoint) => endpoint.endpointId === "observer-directory")
    );
    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("observer-directory");
    await page.getByLabel("本端名称").fill("Observer Directory UI");
    await page.getByLabel("本端角色").selectOption("observer");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Observer Directory UI")).toBeVisible();
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "1 个会话" })).toBeVisible();
    const directoryUpdate = await observerDirectoryUpdate;
    const observerEndpoint = directoryUpdate.payload.endpoints.find(
      (endpoint) => endpoint.endpointId === "observer-directory"
    );
    assert.deepEqual(observerEndpoint.capabilities, ["subscribe-video"]);
    assert.deepEqual(observerEndpoint.channels, []);

    await page.getByLabel("会话目录").selectOption(started.payload.session.sessionId);
    await expect(page.getByLabel("加入会话 ID")).toHaveValue(started.payload.session.sessionId);

    const joinedUpdate = waitFor(
      orClient,
      "session.updated",
      (message) => message.payload.session.participants.includes("observer-directory")
    );
    await page.getByRole("button", { name: "加入信令会话" }).click();
    const update = await joinedUpdate;
    assert.equal(update.payload.session.sessionId, started.payload.session.sessionId);
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "Directory Host OR" })).toBeVisible();
  } finally {
    orClient.close();
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI reports participant limit when joining a full signaling session", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const orClient = await connect(url);
  const teachingClient = await connect(url);

  try {
    send(orClient, "endpoint.register", {
      endpointId: "or-limit-host",
      role: "operating-room",
      name: "Limit Host OR",
      address: "192.168.10.65",
      capabilities: ["call-control", "publish-video"]
    });
    await waitFor(orClient, "endpoint.registered");

    send(teachingClient, "endpoint.register", {
      endpointId: "teach-limit-host",
      role: "teaching-room",
      name: "Limit Teaching Host",
      address: "192.168.10.66",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    const incoming = waitFor(teachingClient, "call.incoming");
    send(orClient, "call.request", { toEndpointId: "teach-limit-host", mode: "interactive", participantLimit: 2 });
    const incomingCall = await incoming;
    const startedForOr = waitFor(orClient, "session.started");
    send(teachingClient, "call.accept", {
      callId: incomingCall.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });
    const started = await startedForOr;

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("observer-limit");
    await page.getByLabel("本端名称").fill("Observer Limit UI");
    await page.getByLabel("本端角色").selectOption("observer");
    await page.getByLabel("加入会话 ID").fill(started.payload.session.sessionId);
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Observer Limit UI")).toBeVisible();
    await page.getByRole("button", { name: "加入信令会话" }).click();

    await expect(page.getByText("信令服务器拒绝加入：已达到参与上限。")).toBeVisible();
    await expect(page.locator(".footer")).toContainText("信令错误：已达到参与上限");
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
  } finally {
    orClient.close();
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI rejects incoming signaling call", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-reject",
      role: "teaching-room",
      name: "Reject Teaching Room",
      address: "192.168.10.36",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();

    send(teachingClient, "call.request", { toEndpointId: "or-ui", mode: "interactive" });
    await waitFor(teachingClient, "call.requested");
    await expect(page.getByText("待确认呼叫")).toBeVisible();

    const rejected = waitFor(teachingClient, "call.rejected");
    await page.getByRole("button", { name: "拒绝" }).click();
    const rejection = await rejected;
    assert.equal(rejection.payload.byEndpointId, "or-ui");
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI can cancel outgoing signaling call", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-outgoing-cancel",
      role: "teaching-room",
      name: "Outgoing Cancel Teaching Room",
      address: "192.168.10.39",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-outgoing-cancel");

    const incoming = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    const incomingCall = await incoming;
    await expect(page.getByText("待确认呼叫")).toBeVisible();
    await expect(page.getByRole("button", { name: "接受呼叫" })).toBeDisabled();

    const canceled = waitFor(teachingClient, "call.canceled");
    await page.getByRole("button", { name: "取消呼叫" }).click();
    const canceledCall = await canceled;
    assert.equal(canceledCall.payload.callId, incomingCall.payload.call.callId);
    await expect(page.getByText("待确认呼叫")).toHaveCount(0);
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI clears a timed-out outgoing signaling call", async ({ page }) => {
  const server = createSignalingServer({ port: 0, callTimeoutMs: 1000 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-timeout",
      role: "teaching-room",
      name: "Timeout Teaching Room",
      address: "192.168.10.63",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-timeout");

    const incoming = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await incoming;
    await expect(page.locator(".footer")).toContainText("信令呼叫已取消：超时", { timeout: 5000 });
    await expect(page.locator(".call-banner")).toHaveCount(0);
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI reports a busy signaling target", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);
  const otherClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-busy",
      role: "teaching-room",
      name: "Busy Teaching Room",
      address: "192.168.10.39",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    send(otherClient, "endpoint.register", {
      endpointId: "other-caller",
      role: "observer",
      name: "Other Caller",
      address: "192.168.10.49",
      capabilities: ["subscribe-video"]
    });
    await waitFor(otherClient, "endpoint.registered");

    const busyIncoming = waitFor(teachingClient, "call.incoming");
    send(otherClient, "call.request", { toEndpointId: "teach-busy", mode: "view" });
    await waitFor(otherClient, "call.requested");
    await busyIncoming;

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-busy");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();

    await expect(page.locator(".footer")).toContainText("本端或目标终端忙线");
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
  } finally {
    teachingClient.close();
    otherClient.close();
    await server.stop();
  }
});

test("phase 2 UI clears canceled incoming signaling call", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-cancel",
      role: "teaching-room",
      name: "Cancel Teaching Room",
      address: "192.168.10.37",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();

    send(teachingClient, "call.request", { toEndpointId: "or-ui", mode: "interactive" });
    const requested = await waitFor(teachingClient, "call.requested");
    await expect(page.getByText("待确认呼叫")).toBeVisible();
    send(teachingClient, "call.cancel", { callId: requested.payload.call.callId });
    await waitFor(teachingClient, "call.canceled");
    await expect(page.getByText("待确认呼叫")).toHaveCount(0);
    await expect(page.locator(".footer")).toContainText("信令呼叫已取消");
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI clears a timed-out incoming signaling call", async ({ page }) => {
  const server = createSignalingServer({ port: 0, callTimeoutMs: 1000 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-incoming-timeout",
      role: "teaching-room",
      name: "Incoming Timeout Teaching Room",
      address: "192.168.10.64",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();

    send(teachingClient, "call.request", { toEndpointId: "or-ui", mode: "interactive" });
    await waitFor(teachingClient, "call.requested");
    await expect(page.getByText("待确认呼叫")).toBeVisible();
    await expect(page.locator(".footer")).toContainText("信令呼叫已取消：超时", { timeout: 5000 });
    await expect(page.locator(".call-banner")).toHaveCount(0);
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI reports invalid signaling URL", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("信令地址").fill("not-a-websocket-url");
  await page.getByRole("button", { name: "连接信令" }).click();
  await expect(page.getByText("连接错误")).toBeVisible();
  await expect(page.locator(".footer")).toContainText("信令地址无效");
});

test("phase 2 UI reports invalid signaling token", async ({ page }) => {
  const server = createSignalingServer({ port: 0, authToken: "shared-secret" });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;

  try {
    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("信令令牌").fill("wrong-secret");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.locator(".footer")).toContainText("信令鉴权失败");
    await expect(page.getByText("已注册")).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("phase 2 UI updates directory after remote endpoint disconnects", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-offline",
      role: "teaching-room",
      name: "Offline Teaching Room",
      address: "192.168.10.40",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "2 个终端" })).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-offline");

    teachingClient.close();
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "1 个终端" })).toBeVisible();
    await expect(page.getByLabel("信令目标")).toBeDisabled();
  } finally {
    await server.stop();
  }
});

test("phase 2 UI reports when its signaling endpoint id is replaced", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const replacementClient = await connect(url);

  try {
    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();

    send(replacementClient, "endpoint.register", {
      endpointId: "or-ui",
      role: "operating-room",
      name: "Replacement OR",
      address: "192.168.10.60",
      capabilities: ["call-control"]
    });
    await waitFor(replacementClient, "endpoint.registered");

    await expect(page.locator(".footer")).toContainText("已被其他连接接管");
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "未连接" })).toBeVisible();
  } finally {
    replacementClient.close();
    await server.stop();
  }
});

test("phase 2 UI resumes an existing signaling session after endpoint replacement", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const orClient = await connect(url);
  const teachingClient = await connect(url);

  try {
    send(orClient, "endpoint.register", {
      endpointId: "or-resume",
      role: "operating-room",
      name: "Resume OR",
      address: "192.168.10.61",
      capabilities: ["call-control", "publish-video"]
    });
    await waitFor(orClient, "endpoint.registered");

    send(teachingClient, "endpoint.register", {
      endpointId: "teach-resume",
      role: "teaching-room",
      name: "Resume Teaching Room",
      address: "192.168.10.62",
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    const incoming = waitFor(teachingClient, "call.incoming");
    send(orClient, "call.request", { toEndpointId: "teach-resume", mode: "interactive", participantLimit: 2 });
    const incomingCall = await incoming;
    const startedForOr = waitFor(orClient, "session.started");
    send(teachingClient, "call.accept", {
      callId: incomingCall.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });
    const started = await startedForOr;
    const replaced = waitFor(teachingClient, "endpoint.replaced");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("teach-resume");
    await page.getByLabel("本端名称").fill("Resume Teaching UI");
    await page.getByLabel("本端角色").selectOption("teaching-room");
    await page.getByRole("button", { name: "连接信令" }).click();
    await replaced;

    await expect(page.locator(".footer")).toContainText("信令会话已恢复");
    await expect(page.locator(".session-list dd").filter({ hasText: started.payload.session.sessionId })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 2" })).toBeVisible();
    await expect(page.locator(".session-list dd").filter({ hasText: "Resume OR" })).toBeVisible();
  } finally {
    orClient.close();
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI clears signaling session when the user disconnects signaling", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-user-disconnect",
      role: "teaching-room",
      name: "User Disconnect Teaching Room",
      address: "192.168.10.67",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-user-disconnect");

    const incomingCall = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    const incoming = await incomingCall;
    send(teachingClient, "call.accept", {
      callId: incoming.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });
    await expect(page.locator(".session-list dd").filter({ hasText: "交互模式" })).toBeVisible();

    await page.getByRole("button", { name: "建立音频通话" }).click();
    await expect(page.locator(".status-list dd").filter({ hasText: "低延迟本地音频轨道" })).toBeVisible();

    await page.getByRole("button", { name: "断开" }).click();
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
    await expect(page.locator(".status-list div", { hasText: "交互音频" }).locator("dd")).toHaveText("未建立");
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "未连接" })).toBeVisible();
    await expect(page.locator(".footer")).toContainText("已清理信令会话状态");
  } finally {
    teachingClient.close();
    await server.stop();
  }
});

test("phase 2 UI clears signaling session when server disconnects", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingClient = await connect(url);
  let stopped = false;

  try {
    send(teachingClient, "endpoint.register", {
      endpointId: "teach-server-stop",
      role: "teaching-room",
      name: "Server Stop Teaching Room",
      address: "192.168.10.41",
      capabilities: ["subscribe-video"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByLabel("信令目标").selectOption("teach-server-stop");

    const incoming = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    const incomingCall = await incoming;
    send(teachingClient, "call.accept", {
      callId: incomingCall.payload.call.callId,
      mode: "interactive",
      participantLimit: 2
    });
    await expect(page.locator(".session-list dd").filter({ hasText: "交互模式" })).toBeVisible();

    await page.getByRole("button", { name: "建立音频通话" }).click();
    await expect(page.locator(".status-list dd").filter({ hasText: "低延迟本地音频轨道" })).toBeVisible();
    await page.getByRole("button", { name: "检查健康" }).click();
    const healthMetric = page.locator(".status-list.compact div", { hasText: "健康检查" }).locator("dd");
    await expect(healthMetric).toContainText("2 终端 / 1 会话 / 0 呼叫");
    await expect(healthMetric).toContainText("事件");

    await server.stop();
    stopped = true;
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
    await expect(page.locator(".status-list div", { hasText: "交互音频" }).locator("dd")).toHaveText("未建立");
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "0 个终端" })).toBeVisible();
    await expect(healthMetric).toHaveText("-");
    await expect(page.getByLabel("信令目标")).toBeDisabled();
    await expect(page.locator(".footer")).toContainText("信令连接已断开");
  } finally {
    teachingClient.close();
    if (!stopped) await server.stop();
  }
});

test("phase 3 UI sends subscribed videos over WebRTC signaling", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingPage = await page.context().newPage();

  try {
    await page.goto("/");
    await teachingPage.goto("/");

    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-media-ui");
    await page.getByLabel("本端名称").fill("Media OR");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Media OR")).toBeVisible();

    await teachingPage.getByLabel("信令地址").fill(url);
    await teachingPage.getByLabel("本端 ID").fill("teach-media-ui");
    await teachingPage.getByLabel("本端名称").fill("Media Teaching");
    await teachingPage.getByLabel("本端角色").selectOption("teaching-room");
    await teachingPage.getByRole("button", { name: "连接信令" }).click();
    await expect(teachingPage.getByText("已注册 Media Teaching")).toBeVisible();
    await expect(page.locator("option[value='teach-media-ui']")).toHaveCount(1);

    await page.getByLabel("信令目标").selectOption("teach-media-ui");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await expect(teachingPage.getByText("待确认呼叫")).toBeVisible();
    await teachingPage.getByRole("button", { name: "接受呼叫" }).click();

    await expect(page.locator(".session-list dd").filter({ hasText: "Media Teaching" })).toBeVisible();
    await expect(teachingPage.locator(".session-list dd").filter({ hasText: "Media OR" })).toBeVisible();

    await teachingPage.getByLabel("通道 2 术野").click();
    await expect(teachingPage.getByLabel("通道 2 术野")).toBeChecked();
    await teachingPage.getByLabel("通道 3 腹腔镜").click();
    await expect(teachingPage.getByLabel("通道 3 腹腔镜")).toBeChecked();
    await teachingPage.getByRole("button", { name: "四画面" }).click();
    await expect(teachingPage.locator(".remote-video-tile")).toHaveCount(3);
    await expect(teachingPage.locator(".remote-health-waiting")).toHaveCount(3);
    await expect
      .poll(() => server.state.sessions.values().next().value?.subscriptions["teach-media-ui"]?.join(","))
      .toBe("ch1,ch2,ch3");

    await page.getByRole("button", { name: "发布订阅通道媒体" }).click();
    await expect(teachingPage.locator(".status-list dd").filter({ hasText: /收到 Media OR|正在接收 Media OR/ })).toBeVisible({
      timeout: 15000
    });
    await teachingPage.waitForFunction(
      () => {
        const video = document.querySelector(".remote-video-tile video");
        const stream = video?.srcObject;
        return Boolean(stream?.getVideoTracks?.().some((track) => track.readyState === "live"));
      },
      null,
      { timeout: 15000 }
    );
    await teachingPage.waitForFunction(
      () => {
        const streams = [...document.querySelectorAll(".remote-video-tile video")]
          .map((video) => video.srcObject)
          .filter((stream) => stream?.getVideoTracks?.().some((track) => track.readyState === "live"));
        return streams.length >= 3 && new Set(streams.map((stream) => stream.id)).size >= 3;
      },
      null,
      { timeout: 15000 }
    );
    await expectRemoteHealthLiveCount(teachingPage, 3);
    await expectDiagnosticLiveCount(teachingPage, 3);
    await expectPeerDiagnosticLiveCount(page, 1);
    await expectPeerDiagnosticLiveCount(teachingPage, 1);
    await expectMediaStatsIncludesVideo(teachingPage);
    await teachingPage.getByRole("button", { name: "复制诊断快照" }).click();
    const teachingSnapshot = JSON.parse(await teachingPage.getByLabel("诊断快照").inputValue());
    const mediaMetric = teachingSnapshot.media.statsMetrics.find((item) => item.endpointId === "or-media-ui");
    expect(mediaMetric).toBeTruthy();
    expect(Object.keys(mediaMetric.video).sort()).toEqual([
      "packetsLost",
      "packetsReceived",
      "packetsSent",
      "receiveBitrateBps",
      "sendBitrateBps"
    ]);
    expect(Object.keys(mediaMetric.audio).sort()).toEqual(["bufferMs", "jitterMs"]);
    expect(Object.keys(mediaMetric.network).sort()).toEqual(["iceRoute", "rttMs"]);
    await page.getByRole("button", { name: "刷新事件" }).click();
    await expect(page.locator(".signal-event").filter({ hasText: "peer.signal.forwarded" }).first()).toBeVisible();

    await teachingPage.getByLabel("通道 4 备用").click();
    await expect(teachingPage.getByLabel("通道 4 备用")).toBeChecked();
    await expect(teachingPage.locator(".remote-video-tile")).toHaveCount(4);
    await expect
      .poll(() => server.state.sessions.values().next().value?.subscriptions["teach-media-ui"]?.join(","))
      .toBe("ch1,ch2,ch3,ch4");
    await expectLiveRemoteVideoCount(teachingPage, 4);
    await expectRemoteHealthLiveCount(teachingPage, 4);
    await expectDiagnosticLiveCount(teachingPage, 4);

    await teachingPage.getByLabel("通道 4 备用").click();
    await expect(teachingPage.getByLabel("通道 4 备用")).not.toBeChecked();
    await expect(teachingPage.locator(".remote-video-tile")).toHaveCount(3);
    await expect
      .poll(() => server.state.sessions.values().next().value?.subscriptions["teach-media-ui"]?.join(","))
      .toBe("ch1,ch2,ch3");
    await expectRemoteHealthLiveCount(teachingPage, 3);

    await teachingPage.getByLabel("通道 4 备用").click();
    await expect(teachingPage.getByLabel("通道 4 备用")).toBeChecked();
    await expect(teachingPage.locator(".remote-video-tile")).toHaveCount(4);
    await expectLiveRemoteVideoCount(teachingPage, 4);
    await expectRemoteHealthLiveCount(teachingPage, 4);

    await teachingPage.waitForFunction(
      () => {
        const audio = document.querySelector(".remote-audio-sinks audio");
        const stream = audio?.srcObject;
        return Boolean(stream?.getAudioTracks?.().some((track) => track.readyState === "live"));
      },
      null,
      { timeout: 15000 }
    );
    await page.waitForFunction(
      () => {
        const audio = document.querySelector(".remote-audio-sinks audio");
        const stream = audio?.srcObject;
        return Boolean(stream?.getAudioTracks?.().some((track) => track.readyState === "live"));
      },
      null,
      { timeout: 15000 }
    );
    await expect(page.locator(".peer-diagnostic-list")).toContainText("音频 本地1 远端1", { timeout: 15000 });
    await expect(teachingPage.locator(".peer-diagnostic-list")).toContainText("音频 本地1 远端1", { timeout: 15000 });

    await page.getByRole("button", { name: "停止媒体链路" }).click();
    await expectRemoteHealthLiveCount(teachingPage, 0);
    await expect(teachingPage.locator(".remote-health-waiting")).toHaveCount(4);

    await teachingPage.getByRole("button", { name: "请求重发媒体" }).click();
    await expect(page.locator(".footer")).toContainText("请求重新发布", { timeout: 5000 });
    await expectLiveRemoteVideoCount(teachingPage, 4);
    await expectRemoteHealthLiveCount(teachingPage, 4);
    await expect(teachingPage.locator(".footer")).toContainText("已请求手术室端重新发布订阅媒体");
  } finally {
    await teachingPage.close();
    await server.stop();
  }
});

test("phase 3 UI publishes each remote endpoint subscription independently", async ({ page }) => {
  test.setTimeout(60000);
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingPage = await page.context().newPage();
  const observerPage = await page.context().newPage();

  try {
    await page.goto("/");
    await teachingPage.goto("/");
    await observerPage.goto("/");

    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-multi-media");
    await page.getByLabel("本端名称").fill("Multi OR");
    await page.getByLabel("手术室参与上限").fill("3");
    await page.getByLabel("发起模式").selectOption("view");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Multi OR")).toBeVisible();

    await teachingPage.getByLabel("信令地址").fill(url);
    await teachingPage.getByLabel("本端 ID").fill("teach-multi-media");
    await teachingPage.getByLabel("本端名称").fill("Multi Teaching");
    await teachingPage.getByLabel("本端角色").selectOption("teaching-room");
    await teachingPage.getByRole("button", { name: "连接信令" }).click();
    await expect(teachingPage.getByText("已注册 Multi Teaching")).toBeVisible();

    await observerPage.getByLabel("信令地址").fill(url);
    await observerPage.getByLabel("本端 ID").fill("observer-multi-media");
    await observerPage.getByLabel("本端名称").fill("Multi Observer");
    await observerPage.getByLabel("本端角色").selectOption("observer");
    await observerPage.getByRole("button", { name: "连接信令" }).click();
    await expect(observerPage.getByText("已注册 Multi Observer")).toBeVisible();

    await page.getByLabel("信令目标").selectOption("teach-multi-media");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await expect(teachingPage.getByText("待确认呼叫")).toBeVisible();
    await teachingPage.getByRole("button", { name: "接受呼叫" }).click();

    const sessionId = await expect
      .poll(() => server.state.sessions.values().next().value?.sessionId)
      .not.toBeUndefined()
      .then(() => server.state.sessions.values().next().value.sessionId);

    await observerPage.getByLabel("加入会话 ID").fill(sessionId);
    await observerPage.getByRole("button", { name: "加入信令会话" }).click();
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();
    await expect(observerPage.locator(".session-list dd").filter({ hasText: "Multi OR" })).toBeVisible();

    await teachingPage.getByLabel("通道 2 术野").click();
    await teachingPage.getByLabel("通道 3 腹腔镜").click();
    await teachingPage.getByRole("button", { name: "四画面" }).click();
    await expect(teachingPage.locator(".remote-video-tile")).toHaveCount(3);

    await observerPage.getByLabel("通道 4 备用").click();
    await observerPage.getByRole("button", { name: "四画面" }).click();
    await expect(observerPage.locator(".remote-video-tile")).toHaveCount(2);

    await expect
      .poll(() => server.state.sessions.values().next().value?.subscriptions["teach-multi-media"]?.join(","))
      .toBe("ch1,ch2,ch3");
    await expect
      .poll(() => server.state.sessions.values().next().value?.subscriptions["observer-multi-media"]?.join(","))
      .toBe("ch1,ch4");

    await page.getByRole("button", { name: "发布订阅通道媒体" }).click();
    await expectLiveRemoteVideoCount(teachingPage, 3);
    await expectLiveRemoteVideoCount(observerPage, 2);
    await expectRemoteHealthLiveCount(teachingPage, 3);
    await expectRemoteHealthLiveCount(observerPage, 2);
    await expectPeerDiagnosticLiveCount(page, 2);
    await expect(page.locator(".peer-diagnostic-list")).toContainText("音频 本地0 远端0");
    await expect(teachingPage.locator(".peer-diagnostic-list")).toContainText("音频 本地0 远端0");
    await expect(observerPage.locator(".peer-diagnostic-list")).toContainText("音频 本地0 远端0");
    await expectNoRemoteAudioTracks(page);
    await expectNoRemoteAudioTracks(teachingPage);
    await expectNoRemoteAudioTracks(observerPage);

    await observerPage.getByRole("button", { name: "停止媒体链路" }).click();
    await expectRemoteHealthLiveCount(observerPage, 0);
    await expect(page.locator(".footer")).toContainText("已停止媒体链路");
    await expectPeerDiagnosticLiveCount(page, 1);
    await expectLiveRemoteVideoCount(teachingPage, 3);
    await expectRemoteHealthLiveCount(teachingPage, 3);

    await observerPage.getByRole("button", { name: "请求重发媒体" }).click();
    await expectLiveRemoteVideoCount(observerPage, 2);
    await expectRemoteHealthLiveCount(observerPage, 2);
    await expectPeerDiagnosticLiveCount(page, 2);
    await expectLiveRemoteVideoCount(teachingPage, 3);
    await expectRemoteHealthLiveCount(teachingPage, 3);
  } finally {
    await observerPage.close();
    await teachingPage.close();
    await server.stop();
  }
});

test("phase 3 UI publishes to an observer that joins after media starts", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingPage = await page.context().newPage();
  const observerPage = await page.context().newPage();

  try {
    await page.goto("/");
    await teachingPage.goto("/");
    await observerPage.goto("/");

    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-late-media");
    await page.getByLabel("本端名称").fill("Late Join OR");
    await page.getByLabel("手术室参与上限").fill("3");
    await page.getByLabel("发起模式").selectOption("view");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Late Join OR")).toBeVisible();

    await teachingPage.getByLabel("信令地址").fill(url);
    await teachingPage.getByLabel("本端 ID").fill("teach-late-media");
    await teachingPage.getByLabel("本端名称").fill("Late Join Teaching");
    await teachingPage.getByLabel("本端角色").selectOption("teaching-room");
    await teachingPage.getByRole("button", { name: "连接信令" }).click();
    await expect(teachingPage.getByText("已注册 Late Join Teaching")).toBeVisible();

    await page.getByLabel("信令目标").selectOption("teach-late-media");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await expect(teachingPage.getByText("待确认呼叫")).toBeVisible();
    await teachingPage.getByRole("button", { name: "接受呼叫" }).click();
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 3" })).toBeVisible();

    await page.getByRole("button", { name: "发布订阅通道媒体" }).click();
    await expectLiveRemoteVideoCount(teachingPage, 1);
    await expectRemoteHealthLiveCount(teachingPage, 1);

    const sessionId = await expect
      .poll(() => server.state.sessions.values().next().value?.sessionId)
      .not.toBeUndefined()
      .then(() => server.state.sessions.values().next().value.sessionId);

    await observerPage.getByLabel("信令地址").fill(url);
    await observerPage.getByLabel("本端 ID").fill("observer-late-media");
    await observerPage.getByLabel("本端名称").fill("Late Join Observer");
    await observerPage.getByLabel("本端角色").selectOption("observer");
    await observerPage.getByRole("button", { name: "连接信令" }).click();
    await expect(observerPage.getByText("已注册 Late Join Observer")).toBeVisible();
    await observerPage.getByLabel("加入会话 ID").fill(sessionId);
    await observerPage.getByRole("button", { name: "加入信令会话" }).click();

    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();
    await expect(observerPage.locator(".session-list dd").filter({ hasText: "Late Join OR" })).toBeVisible();
    await expect
      .poll(() => server.state.sessions.values().next().value?.subscriptions["observer-late-media"]?.join(","))
      .toBe("ch1");
    await expectLiveRemoteVideoCount(observerPage, 1);
    await expectRemoteHealthLiveCount(observerPage, 1);
    await expectPeerDiagnosticLiveCount(observerPage, 1);
  } finally {
    await observerPage.close();
    await teachingPage.close();
    await server.stop();
  }
});

test("phase 3 UI republishes remaining media after an observer leaves", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingPage = await page.context().newPage();
  const observerPage = await page.context().newPage();

  try {
    await page.goto("/");
    await teachingPage.goto("/");
    await observerPage.goto("/");

    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-observer-leave-media");
    await page.getByLabel("本端名称").fill("Observer Leave OR");
    await page.getByLabel("手术室参与上限").fill("3");
    await page.getByLabel("发起模式").selectOption("view");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Observer Leave OR")).toBeVisible();

    await teachingPage.getByLabel("信令地址").fill(url);
    await teachingPage.getByLabel("本端 ID").fill("teach-observer-leave-media");
    await teachingPage.getByLabel("本端名称").fill("Observer Leave Teaching");
    await teachingPage.getByLabel("本端角色").selectOption("teaching-room");
    await teachingPage.getByRole("button", { name: "连接信令" }).click();
    await expect(teachingPage.getByText("已注册 Observer Leave Teaching")).toBeVisible();

    await observerPage.getByLabel("信令地址").fill(url);
    await observerPage.getByLabel("本端 ID").fill("observer-leave-media");
    await observerPage.getByLabel("本端名称").fill("Observer Leave Viewer");
    await observerPage.getByLabel("本端角色").selectOption("observer");
    await observerPage.getByRole("button", { name: "连接信令" }).click();
    await expect(observerPage.getByText("已注册 Observer Leave Viewer")).toBeVisible();

    await page.getByLabel("信令目标").selectOption("teach-observer-leave-media");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await expect(teachingPage.getByText("待确认呼叫")).toBeVisible();
    await teachingPage.getByRole("button", { name: "接受呼叫" }).click();

    const sessionId = await expect
      .poll(() => server.state.sessions.values().next().value?.sessionId)
      .not.toBeUndefined()
      .then(() => server.state.sessions.values().next().value.sessionId);

    await observerPage.getByLabel("加入会话 ID").fill(sessionId);
    await observerPage.getByRole("button", { name: "加入信令会话" }).click();
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();

    await page.getByRole("button", { name: "发布订阅通道媒体" }).click();
    await expectLiveRemoteVideoCount(teachingPage, 1);
    await expectLiveRemoteVideoCount(observerPage, 1);
    await expectPeerDiagnosticLiveCount(page, 2);

    await observerPage.getByRole("button", { name: "离开会话" }).click();
    await expect
      .poll(() => server.state.sessions.values().next().value?.participants.join(","))
      .toBe("or-observer-leave-media,teach-observer-leave-media");
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 3" })).toBeVisible();
    await expectPeerDiagnosticLiveCount(page, 1);
    await expectLiveRemoteVideoCount(teachingPage, 1);
    await expectRemoteHealthLiveCount(teachingPage, 1);
  } finally {
    await observerPage.close();
    await teachingPage.close();
    await server.stop();
  }
});

test("phase 3 UI keeps remaining media after an observer disconnects", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingPage = await page.context().newPage();
  const observerPage = await page.context().newPage();
  let observerClosed = false;

  try {
    await page.goto("/");
    await teachingPage.goto("/");
    await observerPage.goto("/");

    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-observer-disconnect-media");
    await page.getByLabel("本端名称").fill("Observer Disconnect OR");
    await page.getByLabel("手术室参与上限").fill("3");
    await page.getByLabel("发起模式").selectOption("view");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Observer Disconnect OR")).toBeVisible();

    await teachingPage.getByLabel("信令地址").fill(url);
    await teachingPage.getByLabel("本端 ID").fill("teach-observer-disconnect-media");
    await teachingPage.getByLabel("本端名称").fill("Observer Disconnect Teaching");
    await teachingPage.getByLabel("本端角色").selectOption("teaching-room");
    await teachingPage.getByRole("button", { name: "连接信令" }).click();
    await expect(teachingPage.getByText("已注册 Observer Disconnect Teaching")).toBeVisible();

    await observerPage.getByLabel("信令地址").fill(url);
    await observerPage.getByLabel("本端 ID").fill("observer-disconnect-media");
    await observerPage.getByLabel("本端名称").fill("Observer Disconnect Viewer");
    await observerPage.getByLabel("本端角色").selectOption("observer");
    await observerPage.getByRole("button", { name: "连接信令" }).click();
    await expect(observerPage.getByText("已注册 Observer Disconnect Viewer")).toBeVisible();

    await page.getByLabel("信令目标").selectOption("teach-observer-disconnect-media");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await expect(teachingPage.getByText("待确认呼叫")).toBeVisible();
    await teachingPage.getByRole("button", { name: "接受呼叫" }).click();

    const sessionId = await expect
      .poll(() => server.state.sessions.values().next().value?.sessionId)
      .not.toBeUndefined()
      .then(() => server.state.sessions.values().next().value.sessionId);

    await observerPage.getByLabel("加入会话 ID").fill(sessionId);
    await observerPage.getByRole("button", { name: "加入信令会话" }).click();
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();

    await page.getByRole("button", { name: "发布订阅通道媒体" }).click();
    await expectLiveRemoteVideoCount(teachingPage, 1);
    await expectLiveRemoteVideoCount(observerPage, 1);
    await expectPeerDiagnosticLiveCount(page, 2);

    await observerPage.close();
    observerClosed = true;
    await expect
      .poll(() => server.state.sessions.values().next().value?.participants.join(","))
      .toBe("or-observer-disconnect-media,teach-observer-disconnect-media");
    await expect(page.locator(".session-list dd").filter({ hasText: "2 / 3" })).toBeVisible();
    await expectPeerDiagnosticLiveCount(page, 1);
    await expectLiveRemoteVideoCount(teachingPage, 1);
    await expectRemoteHealthLiveCount(teachingPage, 1);
  } finally {
    if (!observerClosed) await observerPage.close();
    await teachingPage.close();
    await server.stop();
  }
});

test("phase 3 UI republishes media when a subscribed endpoint reconnects", async ({ page }) => {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const teachingPage = await page.context().newPage();
  const replacementPage = await page.context().newPage();

  try {
    await page.goto("/");
    await teachingPage.goto("/");

    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-reconnect-media");
    await page.getByLabel("本端名称").fill("Reconnect OR");
    await page.getByLabel("发起模式").selectOption("view");
    await page.getByRole("button", { name: "连接信令" }).click();
    await expect(page.getByText("已注册 Reconnect OR")).toBeVisible();

    await teachingPage.getByLabel("信令地址").fill(url);
    await teachingPage.getByLabel("本端 ID").fill("teach-reconnect-media");
    await teachingPage.getByLabel("本端名称").fill("Reconnect Teaching A");
    await teachingPage.getByLabel("本端角色").selectOption("teaching-room");
    await teachingPage.getByRole("button", { name: "连接信令" }).click();
    await expect(teachingPage.getByText("已注册 Reconnect Teaching A")).toBeVisible();

    await page.getByLabel("信令目标").selectOption("teach-reconnect-media");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    await expect(teachingPage.getByText("待确认呼叫")).toBeVisible();
    await teachingPage.getByRole("button", { name: "接受呼叫" }).click();
    await expect(page.locator(".session-list dd").filter({ hasText: "Reconnect Teaching A" })).toBeVisible();

    await page.getByRole("button", { name: "发布订阅通道媒体" }).click();
    await expectLiveRemoteVideoCount(teachingPage, 1);
    await expectPeerDiagnosticLiveCount(page, 1);

    await replacementPage.goto("/");
    await replacementPage.getByLabel("信令地址").fill(url);
    await replacementPage.getByLabel("本端 ID").fill("teach-reconnect-media");
    await replacementPage.getByLabel("本端名称").fill("Reconnect Teaching B");
    await replacementPage.getByLabel("本端角色").selectOption("teaching-room");
    await replacementPage.getByRole("button", { name: "连接信令" }).click();
    await expect(replacementPage.getByText("已注册 Reconnect Teaching B")).toBeVisible();
    await expect(replacementPage.locator(".session-list dd").filter({ hasText: "Reconnect OR" })).toBeVisible();

    await expectLiveRemoteVideoCount(replacementPage, 1);
    await expectRemoteHealthLiveCount(replacementPage, 1);
    await expectPeerDiagnosticLiveCount(page, 1);
    await expect(page.locator(".footer")).toContainText("已按会话变化重新发布");
  } finally {
    await replacementPage.close();
    await teachingPage.close();
    await server.stop();
  }
});
