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
  const emptySessions = await getJson(`${httpBase}/sessions`);
  assert.deepEqual(emptySessions, []);

  const orClient = await connect(url);
  const teachingClient = await connect(url);
  const observerClient = await connect(url);

  const protocolErrorClient = await connect(url);
  protocolErrorClient.send("not-json");
  const badMessage = await waitFor(protocolErrorClient, "error", (message) => message.payload.code === "bad_message");
  assert.equal(badMessage.payload.code, "bad_message");
  send(protocolErrorClient, "call.request", { toEndpointId: "or-1" });
  const notRegistered = await waitFor(
    protocolErrorClient,
    "error",
    (message) => message.payload.code === "not_registered"
  );
  assert.equal(notRegistered.payload.code, "not_registered");
  send(protocolErrorClient, "endpoint.list");
  const notRegisteredDirectory = await waitFor(
    protocolErrorClient,
    "error",
    (message) => message.payload.code === "not_registered"
  );
  assert.equal(notRegisteredDirectory.payload.code, "not_registered");
  send(protocolErrorClient, "endpoint.register", {
    endpointId: "protocol-error-client",
    role: "observer",
    name: "Protocol Error Client"
  });
  await waitFor(protocolErrorClient, "endpoint.registered");
  send(protocolErrorClient, "unsupported.type");
  const unknownType = await waitFor(protocolErrorClient, "error", (message) => message.payload.code === "unknown_type");
  assert.equal(unknownType.payload.code, "unknown_type");
  const protocolClientClosed = new Promise((resolve) => protocolErrorClient.once("close", resolve));
  protocolErrorClient.close();
  await protocolClientClosed;

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

  send(orClient, "call.request", { toEndpointId: "or-1", mode: "interactive" });
  const selfCallError = await waitFor(orClient, "error", (message) => message.payload.code === "self_call_forbidden");
  assert.equal(selfCallError.payload.code, "self_call_forbidden");

  send(orClient, "call.request", { toEndpointId: "missing-endpoint", mode: "interactive" });
  const targetOffline = await waitFor(orClient, "error", (message) => message.payload.code === "target_offline");
  assert.equal(targetOffline.payload.code, "target_offline");

  send(orClient, "call.accept", { callId: "missing-call", mode: "interactive" });
  const missingAccept = await waitFor(orClient, "error", (message) => message.payload.code === "call_not_found");
  assert.equal(missingAccept.payload.code, "call_not_found");
  send(orClient, "call.reject", { callId: "missing-call" });
  const missingReject = await waitFor(orClient, "error", (message) => message.payload.code === "call_not_found");
  assert.equal(missingReject.payload.code, "call_not_found");
  send(orClient, "call.cancel", { callId: "missing-call" });
  const missingCancel = await waitFor(orClient, "error", (message) => message.payload.code === "call_not_found");
  assert.equal(missingCancel.payload.code, "call_not_found");

  send(orClient, "session.join", { sessionId: "missing-session" });
  const missingJoinSession = await waitFor(orClient, "error", (message) => message.payload.code === "session_not_found");
  assert.equal(missingJoinSession.payload.code, "session_not_found");

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

  send(teachingClient, "call.request", { toEndpointId: "or-1", mode: "view" });
  await waitFor(teachingClient, "call.requested");
  const viewIncoming = await waitFor(orClient, "call.incoming");
  send(orClient, "call.accept", {
    callId: viewIncoming.payload.call.callId,
    mode: "interactive",
    participantLimit: 2
  });
  const viewSessionStarted = await waitFor(teachingClient, "session.started");
  assert.equal(viewSessionStarted.payload.session.mode, "view");
  send(orClient, "session.end", { sessionId: viewSessionStarted.payload.session.sessionId });
  await waitFor(teachingClient, "session.ended");

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
  assert.equal(session.ownerEndpointId, "or-1");
  assert.equal(session.participantLimit, 2);
  assert.deepEqual(session.subscriptions["teach-1"], ["ch1"]);
  const activeHealth = await getJson(`${httpBase}/health`);
  assert.equal(activeHealth.endpoints, 3);
  assert.equal(activeHealth.sessions, 1);
  assert.equal(activeHealth.pendingCalls, 0);
  const httpSessions = await getJson(`${httpBase}/sessions`);
  assert.equal(httpSessions.length, 1);
  assert.equal(httpSessions[0].sessionId, session.sessionId);
  assert.equal(httpSessions[0].participantCount, 2);
  assert.equal(httpSessions[0].participantLimit, 2);
  assert.deepEqual(httpSessions[0].participants, ["teach-1", "or-1"]);
  assert.equal("annotation" in httpSessions[0], false);
  assert.equal("subscriptions" in httpSessions[0], false);
  const httpEvents = await getJson(`${httpBase}/events`);
  assert.equal(httpEvents.some((event) => event.type === "endpoint.registered" && event.endpointId === "or-1"), true);
  assert.equal(httpEvents.some((event) => event.type === "call.requested" && event.callId === requested.payload.call.callId), true);
  assert.equal(httpEvents.some((event) => event.type === "session.started" && event.sessionId === session.sessionId), true);
  send(observerClient, "session.list");
  const sessionSnapshot = await waitFor(observerClient, "session.snapshot");
  assert.equal(sessionSnapshot.payload.sessions.length, 1);
  assert.equal(sessionSnapshot.payload.sessions[0].sessionId, session.sessionId);

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

  const switchClient = await connect(url);
  const switchTarget = await connect(url);
  send(switchClient, "endpoint.register", {
    endpointId: "switch-a",
    role: "teaching-room",
    name: "Switch A"
  });
  await waitFor(switchClient, "endpoint.registered");
  send(switchTarget, "endpoint.register", {
    endpointId: "switch-target",
    role: "operating-room",
    name: "Switch Target"
  });
  await waitFor(switchTarget, "endpoint.registered");
  send(switchClient, "call.request", { toEndpointId: "switch-target", mode: "view" });
  const switchCall = await waitFor(switchClient, "call.requested");
  await waitFor(switchTarget, "call.incoming", (message) => message.payload.call.callId === switchCall.payload.call.callId);
  const switchedCanceled = waitFor(
    switchTarget,
    "call.canceled",
    (message) => message.payload.reason === "endpoint_reregistered"
  );
  send(switchClient, "endpoint.register", {
    endpointId: "switch-b",
    role: "observer",
    name: "Switch B"
  });
  await waitFor(switchClient, "endpoint.registered", (message) => message.payload.endpoint.endpointId === "switch-b");
  const canceledByReregister = await switchedCanceled;
  assert.equal(canceledByReregister.payload.callId, switchCall.payload.call.callId);
  send(switchClient, "endpoint.list");
  const switchDirectory = await waitFor(switchClient, "directory.snapshot");
  assert.equal(switchDirectory.payload.endpoints.some((endpoint) => endpoint.endpointId === "switch-a"), false);
  assert.equal(switchDirectory.payload.endpoints.some((endpoint) => endpoint.endpointId === "switch-b"), true);
  switchClient.close();
  switchTarget.close();

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

  send(teachingClient, "peer.signal", {
    sessionId: session.sessionId,
    toEndpointId: "observer-1",
    signal: { type: "offer", sdp: "v=0" }
  });
  const targetNotInSession = await waitFor(
    teachingClient,
    "error",
    (message) => message.payload.code === "target_not_in_session"
  );
  assert.equal(targetNotInSession.payload.code, "target_not_in_session");

  send(teachingClient, "peer.signal", {
    sessionId: session.sessionId,
    toEndpointId: "or-1"
  });
  const badSignal = await waitFor(teachingClient, "error", (message) => message.payload.code === "bad_signal");
  assert.equal(badSignal.payload.code, "bad_signal");

  send(observerClient, "session.subscribe", {
    sessionId: session.sessionId,
    channels: ["ch1"]
  });
  const observerSubscribeRejected = await waitFor(
    observerClient,
    "error",
    (message) => message.payload.code === "session_not_found"
  );
  assert.equal(observerSubscribeRejected.payload.code, "session_not_found");

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
  assert.equal(orOwnedLimitSession.payload.session.ownerEndpointId, "or-1");
  assert.equal(orOwnedLimitSession.payload.session.participantLimit, 4);
  send(observerClient, "session.join", { sessionId: orOwnedLimitSession.payload.session.sessionId });
  const observerJoined = await waitFor(observerClient, "session.joined");
  assert.equal(observerJoined.payload.session.participants.length, 3);
  send(observerClient, "session.end", { sessionId: orOwnedLimitSession.payload.session.sessionId });
  const observerEndForbidden = await waitFor(
    observerClient,
    "error",
    (message) => message.payload.code === "session_end_forbidden"
  );
  assert.equal(observerEndForbidden.payload.code, "session_end_forbidden");
  assert.equal(server.state.sessions.has(orOwnedLimitSession.payload.session.sessionId), true);

  const busyJoinOrClient = await connect(url);
  const busyJoinTeachingClient = await connect(url);
  send(busyJoinOrClient, "endpoint.register", {
    endpointId: "busy-join-or",
    role: "operating-room",
    name: "Busy Join OR"
  });
  await waitFor(busyJoinOrClient, "endpoint.registered");
  send(busyJoinTeachingClient, "endpoint.register", {
    endpointId: "busy-join-teach",
    role: "teaching-room",
    name: "Busy Join Teaching"
  });
  await waitFor(busyJoinTeachingClient, "endpoint.registered");
  const busyJoinIncoming = waitFor(busyJoinTeachingClient, "call.incoming");
  send(busyJoinOrClient, "call.request", {
    toEndpointId: "busy-join-teach",
    mode: "interactive",
    participantLimit: 4
  });
  const busyJoinCall = await busyJoinIncoming;
  const busyJoinStartedForOr = waitFor(busyJoinOrClient, "session.started");
  send(busyJoinTeachingClient, "call.accept", {
    callId: busyJoinCall.payload.call.callId,
    mode: "interactive",
    participantLimit: 4
  });
  const busyJoinSession = await busyJoinStartedForOr;
  send(observerClient, "session.join", { sessionId: busyJoinSession.payload.session.sessionId });
  const busyJoinError = await waitFor(observerClient, "error", (message) => message.payload.code === "endpoint_busy");
  assert.equal(busyJoinError.payload.code, "endpoint_busy");
  send(busyJoinOrClient, "session.end", { sessionId: busyJoinSession.payload.session.sessionId });
  await waitFor(busyJoinTeachingClient, "session.ended");
  busyJoinOrClient.close();
  busyJoinTeachingClient.close();

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

  const ownerLeaveOrClient = await connect(url);
  const ownerLeaveTeachingClient = await connect(url);
  send(ownerLeaveOrClient, "endpoint.register", {
    endpointId: "owner-leave-or",
    role: "operating-room",
    name: "Owner Leave OR"
  });
  await waitFor(ownerLeaveOrClient, "endpoint.registered");
  send(ownerLeaveTeachingClient, "endpoint.register", {
    endpointId: "owner-leave-teach",
    role: "teaching-room",
    name: "Owner Leave Teaching"
  });
  await waitFor(ownerLeaveTeachingClient, "endpoint.registered");
  const ownerLeaveIncoming = waitFor(ownerLeaveTeachingClient, "call.incoming");
  send(ownerLeaveOrClient, "call.request", {
    toEndpointId: "owner-leave-teach",
    mode: "interactive",
    participantLimit: 3
  });
  const ownerLeaveCall = await ownerLeaveIncoming;
  const ownerLeaveStartedForOr = waitFor(ownerLeaveOrClient, "session.started");
  send(ownerLeaveTeachingClient, "call.accept", {
    callId: ownerLeaveCall.payload.call.callId,
    mode: "interactive",
    participantLimit: 2
  });
  const ownerLeaveSession = await ownerLeaveStartedForOr;
  send(observerClient, "session.join", { sessionId: ownerLeaveSession.payload.session.sessionId });
  await waitFor(observerClient, "session.joined");
  send(ownerLeaveOrClient, "session.leave", { sessionId: ownerLeaveSession.payload.session.sessionId });
  await waitFor(ownerLeaveOrClient, "session.left");
  const ownerLeftEnded = await waitFor(
    ownerLeaveTeachingClient,
    "session.ended",
    (message) => message.payload.reason === "owner_left"
  );
  assert.equal(ownerLeftEnded.payload.sessionId, ownerLeaveSession.payload.session.sessionId);
  assert.equal(server.state.sessions.has(ownerLeaveSession.payload.session.sessionId), false);
  ownerLeaveOrClient.close();
  ownerLeaveTeachingClient.close();

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

  const timeoutServer = createSignalingServer({ port: 0, callTimeoutMs: 25 });
  const timeoutAddress = await timeoutServer.start();
  const timeoutUrl = `ws://127.0.0.1:${timeoutAddress.port}/signal`;
  const timeoutHttpBase = `http://127.0.0.1:${timeoutAddress.port}`;
  const timeoutCaller = await connect(timeoutUrl);
  const timeoutTarget = await connect(timeoutUrl);

  send(timeoutCaller, "endpoint.register", {
    endpointId: "timeout-caller",
    role: "teaching-room",
    name: "Timeout Caller"
  });
  await waitFor(timeoutCaller, "endpoint.registered");
  send(timeoutTarget, "endpoint.register", {
    endpointId: "timeout-target",
    role: "operating-room",
    name: "Timeout Target"
  });
  await waitFor(timeoutTarget, "endpoint.registered");
  const callerTimeout = waitFor(timeoutCaller, "call.canceled", (message) => message.payload.reason === "timeout");
  const targetTimeout = waitFor(timeoutTarget, "call.canceled", (message) => message.payload.reason === "timeout");
  send(timeoutCaller, "call.request", { toEndpointId: "timeout-target", mode: "interactive" });
  const timeoutRequest = await waitFor(timeoutCaller, "call.requested");
  assert.equal(Boolean(timeoutRequest.payload.call.expiresAt), true);
  await waitFor(timeoutTarget, "call.incoming", (message) => message.payload.call.callId === timeoutRequest.payload.call.callId);
  const [callerCanceled, targetCanceled] = await Promise.all([callerTimeout, targetTimeout]);
  assert.equal(callerCanceled.payload.callId, timeoutRequest.payload.call.callId);
  assert.equal(targetCanceled.payload.callId, timeoutRequest.payload.call.callId);
  const timeoutHealth = await getJson(`${timeoutHttpBase}/health`);
  assert.equal(timeoutHealth.pendingCalls, 0);
  timeoutCaller.close();
  timeoutTarget.close();
  await timeoutServer.stop();

  const heartbeatServer = createSignalingServer({ port: 0, heartbeatMs: 25 });
  const heartbeatAddress = await heartbeatServer.start();
  const heartbeatUrl = `ws://127.0.0.1:${heartbeatAddress.port}/signal`;
  const heartbeatHttpBase = `http://127.0.0.1:${heartbeatAddress.port}`;
  const heartbeatClient = await connect(heartbeatUrl);
  send(heartbeatClient, "endpoint.register", {
    endpointId: "heartbeat-client",
    role: "observer",
    name: "Heartbeat Client"
  });
  await waitFor(heartbeatClient, "endpoint.registered");
  const serverSocket = Array.from(heartbeatServer.wss.clients)[0];
  serverSocket.isAlive = false;
  await new Promise((resolve) => heartbeatClient.once("close", resolve));
  const heartbeatHealth = await getJson(`${heartbeatHttpBase}/health`);
  assert.equal(heartbeatHealth.endpoints, 0);
  await heartbeatServer.stop();

  const authServer = createSignalingServer({ port: 0, authToken: "shared-secret" });
  const authAddress = await authServer.start();
  const authUrl = `ws://127.0.0.1:${authAddress.port}/signal`;
  const authHttpBase = `http://127.0.0.1:${authAddress.port}`;
  const authClient = await connect(authUrl);

  send(authClient, "endpoint.register", {
    endpointId: "auth-client",
    role: "observer",
    name: "Auth Client",
    authToken: "wrong-secret"
  });
  const unauthorized = await waitFor(authClient, "error", (message) => message.payload.code === "unauthorized");
  assert.equal(unauthorized.payload.code, "unauthorized");
  const unauthenticatedHealth = await getJson(`${authHttpBase}/health`);
  assert.equal(unauthenticatedHealth.endpoints, 0);

  send(authClient, "endpoint.register", {
    endpointId: "auth-client",
    role: "observer",
    name: "Auth Client",
    authToken: "shared-secret"
  });
  await waitFor(authClient, "endpoint.registered");
  const authenticatedHealth = await getJson(`${authHttpBase}/health`);
  assert.equal(authenticatedHealth.endpoints, 1);
  const unauthorizedDirectory = await fetch(`${authHttpBase}/directory`);
  assert.equal(unauthorizedDirectory.status, 401);
  const unauthorizedEvents = await fetch(`${authHttpBase}/events`);
  assert.equal(unauthorizedEvents.status, 401);
  const authorizedDirectoryResponse = await fetch(`${authHttpBase}/directory`, {
    headers: { Authorization: "Bearer shared-secret" }
  });
  assert.equal(authorizedDirectoryResponse.ok, true);
  const authorizedDirectory = await authorizedDirectoryResponse.json();
  assert.equal(authorizedDirectory.length, 1);
  const authorizedSessionsResponse = await fetch(`${authHttpBase}/sessions?authToken=shared-secret`);
  assert.equal(authorizedSessionsResponse.ok, true);
  const authorizedSessions = await authorizedSessionsResponse.json();
  assert.deepEqual(authorizedSessions, []);
  const authorizedEventsResponse = await fetch(`${authHttpBase}/events`, {
    headers: { Authorization: "Bearer shared-secret" }
  });
  assert.equal(authorizedEventsResponse.ok, true);
  const authorizedEvents = await authorizedEventsResponse.json();
  assert.equal(authorizedEvents.some((event) => event.type === "endpoint.register.denied"), true);
  assert.equal(authorizedEvents.some((event) => event.type === "endpoint.registered" && event.endpointId === "auth-client"), true);
  assert.equal(JSON.stringify(authorizedEvents).includes("shared-secret"), false);
  assert.equal(JSON.stringify(authorizedEvents).includes("wrong-secret"), false);
  authClient.close();
  await authServer.stop();

  console.log("signaling contract test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
