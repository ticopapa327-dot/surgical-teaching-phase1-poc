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

    send(observerClient, "session.join", { sessionId: started.payload.session.sessionId });
    await waitFor(observerClient, "session.joined");
    await expect(page.locator(".session-list dd").filter({ hasText: "3 / 3" })).toBeVisible();

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

test("phase 2 UI reports invalid signaling URL", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("信令地址").fill("not-a-websocket-url");
  await page.getByRole("button", { name: "连接信令" }).click();
  await expect(page.getByText("连接错误")).toBeVisible();
  await expect(page.locator(".footer")).toContainText("信令地址无效");
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

    await server.stop();
    stopped = true;
    await expect(page.getByText("尚未建立互动连接")).toBeVisible();
    await expect(page.locator(".footer")).toContainText("信令连接已断开");
  } finally {
    teachingClient.close();
    if (!stopped) await server.stop();
  }
});
