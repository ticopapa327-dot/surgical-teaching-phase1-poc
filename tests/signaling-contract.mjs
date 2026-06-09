import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const { createSignalingServer } = require("../server/signaling-server.cjs");

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function send(ws, type, payload = {}, requestId = crypto.randomUUID()) {
  ws.send(JSON.stringify({ type, payload, requestId }));
  return requestId;
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

async function main() {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;

  const orClient = await connect(url);
  const teachingClient = await connect(url);
  const observerClient = await connect(url);

  send(orClient, "endpoint.register", {
    endpointId: "or-1",
    role: "operating-room",
    name: "Operating Room 1",
    address: "192.168.10.21",
    capabilities: ["publish-video", "record", "accept-call"]
  });
  await waitFor(orClient, "endpoint.registered");

  send(teachingClient, "endpoint.register", {
    endpointId: "teach-1",
    role: "teaching-room",
    name: "Teaching Room A",
    address: "192.168.10.31",
    capabilities: ["subscribe-video", "interactive-audio"]
  });
  await waitFor(teachingClient, "endpoint.registered");

  send(observerClient, "endpoint.register", {
    endpointId: "observer-1",
    role: "observer",
    name: "Observer 1",
    address: "192.168.10.41",
    capabilities: ["subscribe-video"]
  });
  await waitFor(observerClient, "endpoint.registered");

  send(teachingClient, "endpoint.list");
  const directory = await waitFor(teachingClient, "directory.snapshot");
  assert.equal(directory.payload.endpoints.length, 3);

  send(teachingClient, "call.request", { toEndpointId: "or-1", mode: "interactive" });
  const requested = await waitFor(teachingClient, "call.requested");
  const incoming = await waitFor(orClient, "call.incoming");
  assert.equal(incoming.payload.call.callId, requested.payload.call.callId);
  assert.equal(incoming.payload.from.endpointId, "teach-1");

  send(orClient, "call.accept", {
    callId: incoming.payload.call.callId,
    mode: "interactive",
    participantLimit: 2
  });
  const sessionStarted = await waitFor(teachingClient, "session.started");
  const session = sessionStarted.payload.session;
  assert.equal(session.mode, "interactive");
  assert.deepEqual(session.subscriptions["teach-1"], ["ch1"]);

  send(teachingClient, "session.subscribe", {
    sessionId: session.sessionId,
    channels: ["ch1", "ch2", "ch3"]
  });
  const subscribed = await waitFor(teachingClient, "session.subscribed");
  assert.deepEqual(subscribed.payload.session.subscriptions["teach-1"], ["ch1", "ch2", "ch3"]);

  send(orClient, "session.annotation", {
    sessionId: session.sessionId,
    text: "Key anatomy",
    visible: true
  });
  const annotated = await waitFor(
    teachingClient,
    "session.updated",
    (message) => message.payload.session.annotation?.visible === true
  );
  assert.equal(annotated.payload.session.annotation.text, "Key anatomy");
  assert.equal(annotated.payload.session.annotation.updatedByEndpointId, "or-1");

  send(observerClient, "session.join", { sessionId: session.sessionId });
  const limitError = await waitFor(observerClient, "error", (message) => message.payload.code === "participant_limit");
  assert.equal(limitError.payload.code, "participant_limit");

  send(teachingClient, "session.end", { sessionId: session.sessionId });
  const ended = await waitFor(orClient, "session.ended");
  assert.equal(ended.payload.sessionId, session.sessionId);
  assert.equal(ended.payload.endedByEndpointId, "teach-1");
  assert.equal(server.state.sessions.size, 0);

  orClient.close();
  teachingClient.close();
  observerClient.close();
  await server.stop();
  console.log("signaling contract test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
