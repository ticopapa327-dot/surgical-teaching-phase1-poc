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
    await expect(page.getByLabel("信令地址")).toBeDisabled();
    await expect(page.getByLabel("本端 ID")).toBeDisabled();
    await expect(page.getByLabel("本端角色")).toBeDisabled();
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
  const server = createSignalingServer({ port: 0, callTimeoutMs: 50 });
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
    await expect(page.locator(".footer")).toContainText("信令呼叫已取消：超时");
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
  const server = createSignalingServer({ port: 0, callTimeoutMs: 50 });
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
    await expect(page.locator(".footer")).toContainText("信令呼叫已取消：超时");
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
    await expect(page.locator(".status-list dd").filter({ hasText: "已建立，本地音频轨道" })).toBeVisible();

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
    await expect(page.locator(".status-list dd").filter({ hasText: "已建立，本地音频轨道" })).toBeVisible();
    await page.getByRole("button", { name: "检查健康" }).click();
    const healthMetric = page.locator(".status-list.compact div", { hasText: "健康检查" }).locator("dd");
    await expect(healthMetric).toHaveText("2 终端 / 1 会话 / 0 呼叫");

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

test("phase 3 UI sends channel 1 video over WebRTC signaling", async ({ page }) => {
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

    await page.getByRole("button", { name: "发布通道 1 媒体" }).click();
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
  } finally {
    await teachingPage.close();
    await server.stop();
  }
});
