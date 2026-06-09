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
      capabilities: ["subscribe-video", "interactive-audio"]
    });
    await waitFor(teachingClient, "endpoint.registered");

    await page.goto("/");
    await page.getByLabel("信令地址").fill(url);
    await page.getByLabel("本端 ID").fill("or-ui");
    await page.getByLabel("本端名称").fill("OR UI");
    await page.getByRole("button", { name: "连接信令" }).click();

    await expect(page.getByText("已注册 OR UI")).toBeVisible();
    await expect(page.getByLabel("信令目标")).toBeEnabled();
    await page.getByLabel("信令目标").selectOption("teach-remote");

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
    await expect(page.getByText("信令会话已建立")).toBeVisible();

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
  } finally {
    teachingClient.close();
    await server.stop();
  }
});
