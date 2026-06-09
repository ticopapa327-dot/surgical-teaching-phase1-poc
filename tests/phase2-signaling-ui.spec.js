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

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();

    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await page.getByRole("button", { name: "检查健康" }).click();
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "2 终端 / 0 会话 / 0 呼叫" })).toBeVisible();
    await expect(page.getByLabel("信令目标")).toBeEnabled();
    await page.getByLabel("信令目标").selectOption("teach-remote");
    await expect(page.locator(".status-list.compact dd").filter({ hasText: "remote-ch1 Teaching View" })).toBeVisible();
    await page.getByLabel("手术室参与上限").fill("4");

    const incomingCall = waitFor(teachingClient, "call.incoming");
    await page.getByRole("button", { name: "信令呼叫选中终端" }).click();
    const incoming = await incomingCall;
    assert.equal(incoming.payload.call.toEndpointId, "teach-remote");
    assert.equal(incoming.payload.call.requestedMode, "interactive");

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

test("phase 2 UI reports invalid signaling URL", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("信令地址").fill("not-a-websocket-url");
  await page.getByRole("button", { name: "连接信令" }).click();
  await expect(page.getByText("连接错误")).toBeVisible();
  await expect(page.locator(".footer")).toContainText("信令地址无效");
});
