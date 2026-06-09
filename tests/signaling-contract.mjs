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

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true);
  return response.json();
}

async function main() {
  const server = createSignalingServer({ port: 0 });
  const address = await server.start();
  const url = `ws://127.0.0.1:${address.port}/signal`;
  const httpBase = `http://127.0.0.1:${address.port}`;

  const emptyHealth = await getJson(`${httpBase}/health`);
  assert.equal(emptyHealth.ok, true);
  assert.equal(emptyHealth.endpoints, 0);
  assert.equal(emptyHealth.sessions, 0);
  assert.equal(emptyHealth.pendingCalls, 0);

  const orClient = await connect(url);
  const teachingClient = await connect(url);
  const observerClient = await connect(url);

  send(orClient, "endpoint.register", {
    endpointId: "or-1",
    role: "operating-room",
    name: "Operating Room 1",
    address: "192.168.10.21",
    capabilities: ["publish-video", "record", "accept-call"],
    channels: [
      { id: "ch1", label: "Panorama", role: "overview" },
      { id: "ch2", label: "Surgical Field", role: "field" },
      { id: "ch3", label: "Laparoscope", role: "device" },
      { id: "ch4", label: "Backup", role: "backup" }
    ]
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
  const orEndpoint = directory.payload.endpoints.find((endpoint) => endpoint.endpointId === "or-1");
  assert.equal(orEndpoint.channels.length, 4);
  assert.equal(orEndpoint.channels[1].label, "Surgical Field");
  const httpDirectory = await getJson(`${httpBase}/directory`);
  assert.equal(httpDirectory.length, 3);

  send(teachingClient, "call.request", { toEndpointId: "or-1", mode: "view" });
  const cancelableCall = await waitFor(teachingClient, "call.requested");
  await waitFor(orClient, "call.incoming", (message) => message.payload.call.callId === cancelableCall.payload.call.callId);
  send(teachingClient, "call.request", { toEndpointId: "or-1", mode: "view" });
  const busyCall = await waitFor(teachingClient, "error", (message) => message.payload.code === "endpoint_busy");
  assert.equal(busyCall.payload.code, "endpoint_busy");
  send(teachingClient, "call.cancel", { callId: cancelableCall.payload.call.callId });
  const canceledCall = await waitFor(orClient, "call.canceled");
  assert.equal(canceledCall.payload.callId, cancelableCall.payload.call.callId);
  assert.equal(canceledCall.payload.reason, "caller_canceled");

  const disconnectingCaller = await connect(url);
  send(disconnectingCaller, "endpoint.register", {
    endpointId: "teach-disconnect",
    role: "teaching-room",
    name: "Disconnecting Teaching Room",
    address: "192.168.10.38",
    capabilities: ["subscribe-video"]
  });
  await waitFor(disconnectingCaller, "endpoint.registered");
  send(disconnectingCaller, "call.request", { toEndpointId: "or-1", mode: "view" });
  const disconnectingCall = await waitFor(disconnectingCaller, "call.requested");
  await waitFor(orClient, "call.incoming", (message) => message.payload.call.callId === disconnectingCall.payload.call.callId);
  disconnectingCaller.close();
  const disconnectedCall = await waitFor(
    orClient,
    "call.canceled",
    (message) => message.payload.callId === disconnectingCall.payload.call.callId
  );
  assert.equal(disconnectedCall.payload.reason, "endpoint_disconnected");

  send(teachingClient, "call.request", { toEndpointId: "or-1", mode: "interactive" });
  const requested = await waitFor(teachingClient, "call.requested");
  const incoming = await waitFor(orClient, "call.incoming");
  assert.equal(incoming.payload.call.callId, requested.payload.call.callId);
  assert.equal(incoming.payload.from.endpointId, "teach-1");

  send(orClient, "call.accept", {
    callId: incoming.payload.call.callId,
    mode: "interactive",
    participantLimit: "not-a-number"
  });
  const sessionStarted = await waitFor(teachingClient, "session.started");
  const session = sessionStarted.payload.session;
  assert.equal(session.mode, "interactive");
  assert.equal(session.participantLimit, 2);
  assert.deepEqual(session.subscriptions["teach-1"], ["ch1"]);
  const activeHealth = await getJson(`${httpBase}/health`);
  assert.equal(activeHealth.endpoints, 3);
  assert.equal(activeHealth.sessions, 1);
  assert.equal(activeHealth.pendingCalls, 0);

  const malformedClient = await connect(url);
  send(malformedClient, "endpoint.register", {
    endpointId: { bad: true },
    role: "invalid-role",
    name: " ",
    address: 100,
    capabilities: ["subscribe-video", "", { bad: true }, "subscribe-video"],
    channels: [
      null,
      { id: " ", label: "", role: 42 },
      {
        id: "channel-id-that-is-longer-than-thirty-two-characters",
        label: "Channel label that is longer than eighty characters and should be trimmed by the signaling service",
        role: "observer-return"
      }
    ]
  });
  const malformedRegistration = await waitFor(malformedClient, "endpoint.registered");
  assert.match(malformedRegistration.payload.endpoint.endpointId, /^endpoint-/);
  assert.equal(malformedRegistration.payload.endpoint.role, "observer");
  assert.equal(malformedRegistration.payload.endpoint.name, malformedRegistration.payload.endpoint.endpointId);
  assert.equal(malformedRegistration.payload.endpoint.address, "");
  assert.deepEqual(malformedRegistration.payload.endpoint.capabilities, ["subscribe-video"]);
  assert.equal(malformedRegistration.payload.endpoint.channels.length, 2);
  assert.equal(malformedRegistration.payload.endpoint.channels[0].id, "ch1");
  assert.equal(malformedRegistration.payload.endpoint.channels[0].label, "Channel 1");
  assert.equal(malformedRegistration.payload.endpoint.channels[0].role, "");
  assert.equal(malformedRegistration.payload.endpoint.channels[1].id.length, 32);
  assert.equal(malformedRegistration.payload.endpoint.channels[1].label.length, 80);
  malformedClient.close();

  const duplicateClientA = await connect(url);
  const duplicateClientB = await connect(url);
  send(duplicateClientA, "endpoint.register", {
    endpointId: "duplicate-endpoint",
    role: "observer",
    name: "Duplicate A"
  });
  await waitFor(duplicateClientA, "endpoint.registered");
  const replaced = waitFor(duplicateClientA, "endpoint.replaced");
  const duplicateClosed = new Promise((resolve) => duplicateClientA.once("close", resolve));
  send(duplicateClientB, "endpoint.register", {
    endpointId: "duplicate-endpoint",
    role: "observer",
    name: "Duplicate B"
  });
  const duplicateRegistration = await waitFor(duplicateClientB, "endpoint.registered");
  assert.equal(duplicateRegistration.payload.endpoint.name, "Duplicate B");
  assert.equal((await replaced).payload.endpointId, "duplicate-endpoint");
  await duplicateClosed;
  send(duplicateClientB, "endpoint.list");
  const duplicateDirectory = await waitFor(duplicateClientB, "directory.snapshot");
  assert.equal(
    duplicateDirectory.payload.endpoints.filter((endpoint) => endpoint.endpointId === "duplicate-endpoint").length,
    1
  );
  duplicateClientB.close();

  const resumeOrClient = await connect(url);
  const resumeTeachingClientA = await connect(url);
  const resumeTeachingClientB = await connect(url);
  send(resumeOrClient, "endpoint.register", {
    endpointId: "resume-or",
    role: "operating-room",
    name: "Resume OR"
  });
  await waitFor(resumeOrClient, "endpoint.registered");
  send(resumeTeachingClientA, "endpoint.register", {
    endpointId: "resume-teach",
    role: "teaching-room",
    name: "Resume Teaching A"
  });
  await waitFor(resumeTeachingClientA, "endpoint.registered");
  const resumeIncoming = waitFor(resumeTeachingClientA, "call.incoming");
  send(resumeOrClient, "call.request", { toEndpointId: "resume-teach", mode: "interactive", participantLimit: 2 });
  const resumeCall = await resumeIncoming;
  const resumeStartedForOr = waitFor(resumeOrClient, "session.started");
  send(resumeTeachingClientA, "call.accept", {
    callId: resumeCall.payload.call.callId,
    mode: "interactive",
    participantLimit: 2
  });
  const resumeSession = await resumeStartedForOr;
  const resumeReplaced = waitFor(resumeTeachingClientA, "endpoint.replaced");
  const resumeClosed = new Promise((resolve) => resumeTeachingClientA.once("close", resolve));
  const resumedSession = waitFor(resumeTeachingClientB, "session.resumed");
  send(resumeTeachingClientB, "endpoint.register", {
    endpointId: "resume-teach",
    role: "teaching-room",
    name: "Resume Teaching B"
  });
  await waitFor(resumeTeachingClientB, "endpoint.registered");
  assert.equal((await resumeReplaced).payload.endpointId, "resume-teach");
  await resumeClosed;
  const resumed = await resumedSession;
  assert.equal(resumed.payload.session.sessionId, resumeSession.payload.session.sessionId);
  assert.deepEqual(resumed.payload.session.participants, ["resume-or", "resume-teach"]);
  send(resumeOrClient, "session.end", { sessionId: resumeSession.payload.session.sessionId });
  await waitFor(resumeTeachingClientB, "session.ended");
  resumeOrClient.close();
  resumeTeachingClientB.close();

  send(teachingClient, "peer.signal", {
    sessionId: session.sessionId,
    toEndpointId: "or-1",
    signal: { type: "offer", sdp: "v=0" }
  });
  const relayedOffer = await waitFor(orClient, "peer.signal");
  assert.equal(relayedOffer.payload.fromEndpointId, "teach-1");
  assert.equal(relayedOffer.payload.signal.type, "offer");
  const signalSent = await waitFor(teachingClient, "peer.signal.sent");
  assert.equal(signalSent.payload.toEndpointId, "or-1");

  send(teachingClient, "session.subscribe", {
    sessionId: session.sessionId,
    channels: ["ch1", "ch2", "ch3"]
  });
  const subscribed = await waitFor(teachingClient, "session.subscribed");
  assert.deepEqual(subscribed.payload.session.subscriptions["teach-1"], ["ch1", "ch2", "ch3"]);

  const longChannelId = "channel-id-that-is-longer-than-thirty-two-characters";
  send(teachingClient, "session.subscribe", {
    sessionId: session.sessionId,
    channels: ["ch4", "", { id: "bad" }, "ch4", longChannelId, "ch2", "ch3", "ch1"]
  });
  const sanitizedSubscription = await waitFor(teachingClient, "session.subscribed");
  assert.deepEqual(sanitizedSubscription.payload.session.subscriptions["teach-1"], [
    "ch4",
    longChannelId.slice(0, 32),
    "ch2",
    "ch3"
  ]);

  send(teachingClient, "session.annotation", {
    sessionId: session.sessionId,
    text: "Forbidden annotation",
    visible: true
  });
  const forbiddenAnnotation = await waitFor(
    teachingClient,
    "error",
    (message) => message.payload.code === "annotation_forbidden"
  );
  assert.equal(forbiddenAnnotation.payload.code, "annotation_forbidden");

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
  assert.equal(ended.payload.reason, "requested");
  assert.equal(server.state.sessions.size, 0);
  const endedHealth = await getJson(`${httpBase}/health`);
  assert.equal(endedHealth.sessions, 0);

  send(orClient, "call.request", {
    toEndpointId: "teach-1",
    mode: "interactive",
    participantLimit: 4
  });
  await waitFor(orClient, "call.requested");
  const incomingFromOr = await waitFor(teachingClient, "call.incoming");
  assert.equal(incomingFromOr.payload.call.participantLimit, 4);
  send(teachingClient, "call.accept", {
    callId: incomingFromOr.payload.call.callId,
    mode: "interactive",
    participantLimit: 2
  });
  const orOwnedLimitSession = await waitFor(orClient, "session.started");
  assert.equal(orOwnedLimitSession.payload.session.participantLimit, 4);
  send(observerClient, "session.join", { sessionId: orOwnedLimitSession.payload.session.sessionId });
  const observerJoined = await waitFor(observerClient, "session.joined");
  assert.equal(observerJoined.payload.session.participants.length, 3);
  send(observerClient, "session.leave", { sessionId: orOwnedLimitSession.payload.session.sessionId });
  await waitFor(observerClient, "session.left");
  const observerLeftUpdate = await waitFor(
    orClient,
    "session.updated",
    (message) => message.payload.session.participants.length === 2
  );
  assert.equal(observerLeftUpdate.payload.session.participants.includes("observer-1"), false);
  send(orClient, "session.end", { sessionId: orOwnedLimitSession.payload.session.sessionId });
  await waitFor(teachingClient, "session.ended");

  send(teachingClient, "call.request", { toEndpointId: "or-1", mode: "interactive" });
  await waitFor(teachingClient, "call.requested");
  const incomingAfterEnd = await waitFor(orClient, "call.incoming");
  send(orClient, "call.accept", {
    callId: incomingAfterEnd.payload.call.callId,
    mode: "interactive",
    participantLimit: 2
  });
  const restarted = await waitFor(teachingClient, "session.started");
  orClient.close();
  const disconnected = await waitFor(
    teachingClient,
    "session.ended",
    (message) => message.payload.reason === "endpoint_disconnected"
  );
  assert.equal(disconnected.payload.sessionId, restarted.payload.session.sessionId);
  assert.equal(disconnected.payload.endedByEndpointId, "or-1");
  assert.equal(server.state.sessions.size, 0);
  const disconnectedHealth = await getJson(`${httpBase}/health`);
  assert.equal(disconnectedHealth.sessions, 0);

  teachingClient.close();
  observerClient.close();
  await server.stop();
  console.log("signaling contract test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
