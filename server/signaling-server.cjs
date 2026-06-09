const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const VALID_ENDPOINT_ROLES = new Set(["operating-room", "teaching-room", "observer"]);

function createId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeText(value, fallback = "", maxLength = 80) {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function normalizeRole(role) {
  return VALID_ENDPOINT_ROLES.has(role) ? role : "observer";
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  const normalized = [];
  for (const capability of capabilities) {
    const value = normalizeText(capability, "", 48);
    if (!value || normalized.includes(value)) continue;
    normalized.push(value);
    if (normalized.length >= 16) break;
  }
  return normalized;
}

function send(ws, type, payload = {}, requestId = null) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, requestId, payload }));
}

function normalizeChannels(channels) {
  if (!Array.isArray(channels)) return [];
  const normalized = [];
  for (const channel of channels) {
    if (!channel || typeof channel !== "object") continue;
    const index = normalized.length + 1;
    normalized.push({
      id: normalizeText(channel.id, `ch${index}`, 32),
      label: normalizeText(channel.label, `Channel ${index}`, 80),
      role: normalizeText(channel.role, "", 80)
    });
    if (normalized.length >= 16) break;
  }
  return normalized;
}

function normalizeSubscriptionChannels(channels) {
  const candidates = Array.isArray(channels) && channels.length ? channels : ["ch1"];
  const normalized = [];
  for (const channel of candidates) {
    if (typeof channel !== "string") continue;
    const channelId = channel.trim().slice(0, 32);
    if (!channelId || normalized.includes(channelId)) continue;
    normalized.push(channelId);
    if (normalized.length >= 4) break;
  }
  return normalized.length ? normalized : ["ch1"];
}

function publicEndpoint(endpoint) {
  return {
    endpointId: endpoint.endpointId,
    role: endpoint.role,
    name: endpoint.name,
    address: endpoint.address,
    capabilities: endpoint.capabilities,
    channels: endpoint.channels,
    online: true,
    registeredAt: endpoint.registeredAt
  };
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    ownerEndpointId: session.ownerEndpointId,
    participantLimit: session.participantLimit,
    participants: session.participants,
    subscriptions: session.subscriptions,
    annotation: session.annotation,
    startedAt: session.startedAt
  };
}

function publicSessionSummary(session) {
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    ownerEndpointId: session.ownerEndpointId,
    participantLimit: session.participantLimit,
    participantCount: session.participants.length,
    participants: session.participants,
    startedAt: session.startedAt
  };
}

function publicCall(call) {
  return {
    callId: call.callId,
    fromEndpointId: call.fromEndpointId,
    toEndpointId: call.toEndpointId,
    requestedMode: call.requestedMode,
    participantLimit: call.participantLimit,
    createdAt: call.createdAt,
    expiresAt: call.expiresAt
  };
}

function resolveMode(requestMode, acceptMode) {
  return requestMode === "view" || acceptMode === "view" ? "view" : "interactive";
}

function normalizeMode(mode) {
  return mode === "view" ? "view" : "interactive";
}

function normalizeParticipantLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 2;
  return Math.max(2, Math.min(16, Math.trunc(numericValue)));
}

function normalizeCallTimeoutMs(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return 60000;
  return Math.max(10, Math.trunc(numericValue));
}

function createSignalingServer(options = {}) {
  const port = options.port ?? Number(process.env.SIGNALING_PORT || 7077);
  const host = options.host || process.env.SIGNALING_HOST || "127.0.0.1";
  const callTimeoutMs = normalizeCallTimeoutMs(options.callTimeoutMs ?? process.env.SIGNALING_CALL_TIMEOUT_MS);
  const authToken = normalizeText(options.authToken ?? process.env.SIGNALING_AUTH_TOKEN, "", 256);
  const endpoints = new Map();
  const sockets = new Map();
  const pendingCalls = new Map();
  const sessions = new Map();
  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };

  function requestHasAuth(req, requestUrl) {
    if (!authToken) return true;
    const authorization = req.headers.authorization || "";
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const queryToken = requestUrl.searchParams.get("authToken") || "";
    return bearerToken === authToken || queryToken === authToken;
  }

  function writeUnauthorized(res) {
    res.writeHead(401, jsonHeaders);
    res.end(JSON.stringify({ error: "unauthorized" }));
  }

  const httpServer = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, jsonHeaders);
      res.end();
      return;
    }
    if (requestUrl.pathname === "/health") {
      res.writeHead(200, jsonHeaders);
      res.end(
        JSON.stringify({
          ok: true,
          endpoints: endpoints.size,
          sessions: sessions.size,
          pendingCalls: pendingCalls.size
        })
      );
      return;
    }
    if (requestUrl.pathname === "/directory") {
      if (!requestHasAuth(req, requestUrl)) {
        writeUnauthorized(res);
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(Array.from(endpoints.values()).map(publicEndpoint)));
      return;
    }
    if (requestUrl.pathname === "/sessions") {
      if (!requestHasAuth(req, requestUrl)) {
        writeUnauthorized(res);
        return;
      }
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(Array.from(sessions.values()).map(publicSessionSummary)));
      return;
    }
    res.writeHead(404, jsonHeaders);
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ server: httpServer, path: "/signal" });

  function broadcast(type, payload) {
    for (const ws of sockets.values()) send(ws, type, payload);
  }

  function sendDirectory() {
    broadcast("directory.updated", {
      endpoints: Array.from(endpoints.values()).map(publicEndpoint)
    });
  }

  function sendSessions() {
    broadcast("sessions.updated", {
      sessions: Array.from(sessions.values()).map(publicSessionSummary)
    });
  }

  function endpointForSocket(ws) {
    return [...sockets.entries()].find(([, value]) => value === ws)?.[0] || null;
  }

  function requireRegistration(ws, requestId) {
    const endpointId = endpointForSocket(ws);
    if (!endpointId) {
      send(ws, "error", { code: "not_registered", message: "endpoint.register is required" }, requestId);
      return null;
    }
    return endpoints.get(endpointId);
  }

  function notifySession(session) {
    for (const endpointId of session.participants) {
      const ws = sockets.get(endpointId);
      if (ws) send(ws, "session.updated", { session: publicSession(session) });
    }
  }

  function endpointIsBusy(endpointId) {
    const hasPendingCall = Array.from(pendingCalls.values()).some(
      (call) => call.fromEndpointId === endpointId || call.toEndpointId === endpointId
    );
    if (hasPendingCall) return true;
    return Array.from(sessions.values()).some((session) => session.participants.includes(endpointId));
  }

  function clearPendingCall(call) {
    if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
    pendingCalls.delete(call.callId);
  }

  function cancelPendingCall(call, canceledByEndpointId, reason = "canceled", requestId = null) {
    clearPendingCall(call);
    const payload = {
      callId: call.callId,
      canceledByEndpointId,
      reason,
      canceledAt: new Date().toISOString()
    };
    const callerSocket = sockets.get(call.fromEndpointId);
    const targetSocket = sockets.get(call.toEndpointId);
    if (callerSocket) send(callerSocket, "call.canceled", payload, call.fromEndpointId === canceledByEndpointId ? requestId : null);
    if (targetSocket) send(targetSocket, "call.canceled", payload, call.toEndpointId === canceledByEndpointId ? requestId : null);
  }

  function endSession(session, endedByEndpointId, reason = "requested", requestId = null) {
    sessions.delete(session.sessionId);
    const ended = {
      sessionId: session.sessionId,
      endedByEndpointId,
      reason,
      endedAt: new Date().toISOString()
    };
    for (const endpointId of session.participants) {
      const targetSocket = sockets.get(endpointId);
      if (targetSocket) {
        send(targetSocket, "session.ended", ended, endpointId === endedByEndpointId ? requestId : null);
      }
    }
    sendSessions();
  }

  function removeEndpoint(endpointId, reason = "endpoint_disconnected") {
    for (const [, call] of pendingCalls.entries()) {
      if (call.fromEndpointId === endpointId || call.toEndpointId === endpointId) {
        cancelPendingCall(call, endpointId, reason);
      }
    }
    sockets.delete(endpointId);
    endpoints.delete(endpointId);
    for (const session of Array.from(sessions.values())) {
      if (session.participants.includes(endpointId)) {
        endSession(session, endpointId, reason);
      }
    }
    sendDirectory();
  }

  function handleMessage(ws, raw) {
    const msg = safeJsonParse(raw);
    if (!msg || !msg.type) {
      send(ws, "error", { code: "bad_message", message: "invalid JSON message" });
      return;
    }
    const { type, payload = {}, requestId = null } = msg;

    if (type === "endpoint.register") {
      if (authToken && normalizeText(payload.authToken, "", 256) !== authToken) {
        send(ws, "error", { code: "unauthorized", message: "invalid signaling auth token" }, requestId);
        return;
      }
      const endpointId = normalizeText(payload.endpointId, "", 64) || createId("endpoint");
      const previousEndpointId = endpointForSocket(ws);
      if (previousEndpointId && previousEndpointId !== endpointId) {
        removeEndpoint(previousEndpointId, "endpoint_reregistered");
      }
      const endpoint = {
        endpointId,
        role: normalizeRole(payload.role),
        name: normalizeText(payload.name, endpointId, 80),
        address: normalizeText(payload.address, "", 120),
        capabilities: normalizeCapabilities(payload.capabilities),
        channels: normalizeChannels(payload.channels),
        registeredAt: new Date().toISOString()
      };
      const previousSocket = sockets.get(endpointId);
      endpoints.set(endpointId, endpoint);
      sockets.set(endpointId, ws);
      send(ws, "endpoint.registered", { endpoint: publicEndpoint(endpoint) }, requestId);
      if (previousSocket && previousSocket !== ws) {
        send(previousSocket, "endpoint.replaced", {
          endpointId,
          replacedAt: new Date().toISOString()
        });
        previousSocket.close(4000, "endpoint replaced");
      }
      for (const session of sessions.values()) {
        if (session.participants.includes(endpointId)) {
          send(ws, "session.resumed", { session: publicSession(session) });
        }
      }
      sendDirectory();
      return;
    }

    if (type === "endpoint.list") {
      send(
        ws,
        "directory.snapshot",
        { endpoints: Array.from(endpoints.values()).map(publicEndpoint) },
        requestId
      );
      return;
    }

    const fromEndpoint = requireRegistration(ws, requestId);
    if (!fromEndpoint) return;

    if (type === "session.list") {
      send(
        ws,
        "session.snapshot",
        { sessions: Array.from(sessions.values()).map(publicSessionSummary) },
        requestId
      );
      return;
    }

    if (type === "call.request") {
      const toEndpoint = endpoints.get(payload.toEndpointId);
      const targetSocket = sockets.get(payload.toEndpointId);
      if (!toEndpoint || !targetSocket) {
        send(ws, "error", { code: "target_offline", message: "target endpoint is offline" }, requestId);
        return;
      }
      if (endpointIsBusy(fromEndpoint.endpointId) || endpointIsBusy(toEndpoint.endpointId)) {
        send(ws, "error", { code: "endpoint_busy", message: "caller or target endpoint is busy" }, requestId);
        return;
      }
      const call = {
        callId: createId("call"),
        fromEndpointId: fromEndpoint.endpointId,
        toEndpointId: toEndpoint.endpointId,
        requestedMode: normalizeMode(payload.mode),
        participantLimit:
          fromEndpoint.role === "operating-room" ? normalizeParticipantLimit(payload.participantLimit) : null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + callTimeoutMs).toISOString(),
        timeoutHandle: null
      };
      call.timeoutHandle = setTimeout(() => {
        const activeCall = pendingCalls.get(call.callId);
        if (activeCall) cancelPendingCall(activeCall, "server", "timeout");
      }, callTimeoutMs);
      pendingCalls.set(call.callId, call);
      send(ws, "call.requested", { call: publicCall(call) }, requestId);
      send(targetSocket, "call.incoming", {
        call: publicCall(call),
        from: publicEndpoint(fromEndpoint)
      });
      return;
    }

    if (type === "call.accept") {
      const call = pendingCalls.get(payload.callId);
      if (!call || call.toEndpointId !== fromEndpoint.endpointId) {
        send(ws, "error", { code: "call_not_found", message: "pending call not found" }, requestId);
        return;
      }
      clearPendingCall(call);
      const callerEndpoint = endpoints.get(call.fromEndpointId);
      const participantLimit =
        fromEndpoint.role === "operating-room"
          ? normalizeParticipantLimit(payload.participantLimit || call.participantLimit)
          : normalizeParticipantLimit(
              callerEndpoint?.role === "operating-room" ? call.participantLimit : payload.participantLimit
            );
      const session = {
        sessionId: createId("session"),
        mode: resolveMode(call.requestedMode, normalizeMode(payload.mode)),
        ownerEndpointId: call.toEndpointId,
        participantLimit,
        participants: [call.fromEndpointId, call.toEndpointId],
        subscriptions: {
          [call.fromEndpointId]: ["ch1"],
          [call.toEndpointId]: ["ch1"]
        },
        annotation: {
          visible: false,
          text: "",
          updatedByEndpointId: null,
          updatedAt: null
        },
        startedAt: new Date().toISOString()
      };
      sessions.set(session.sessionId, session);
      const publicValue = publicSession(session);
      send(ws, "session.started", { session: publicValue }, requestId);
      const callerSocket = sockets.get(call.fromEndpointId);
      if (callerSocket) send(callerSocket, "session.started", { session: publicValue });
      sendSessions();
      return;
    }

    if (type === "call.reject") {
      const call = pendingCalls.get(payload.callId);
      if (!call || call.toEndpointId !== fromEndpoint.endpointId) {
        send(ws, "error", { code: "call_not_found", message: "pending call not found" }, requestId);
        return;
      }
      clearPendingCall(call);
      const callerSocket = sockets.get(call.fromEndpointId);
      if (callerSocket) {
        send(callerSocket, "call.rejected", { callId: call.callId, byEndpointId: fromEndpoint.endpointId });
      }
      send(ws, "call.rejected", { callId: call.callId, byEndpointId: fromEndpoint.endpointId }, requestId);
      return;
    }

    if (type === "call.cancel") {
      const call = pendingCalls.get(payload.callId);
      if (!call || call.fromEndpointId !== fromEndpoint.endpointId) {
        send(ws, "error", { code: "call_not_found", message: "pending call not found" }, requestId);
        return;
      }
      cancelPendingCall(call, fromEndpoint.endpointId, "caller_canceled", requestId);
      return;
    }

    if (type === "session.subscribe") {
      const session = sessions.get(payload.sessionId);
      if (!session || !session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      session.subscriptions[fromEndpoint.endpointId] = normalizeSubscriptionChannels(payload.channels);
      notifySession(session);
      send(ws, "session.subscribed", { session: publicSession(session) }, requestId);
      return;
    }

    if (type === "session.annotation") {
      const session = sessions.get(payload.sessionId);
      if (!session || !session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      if (fromEndpoint.role !== "operating-room") {
        send(ws, "error", { code: "annotation_forbidden", message: "only operating-room can update annotation" }, requestId);
        return;
      }
      session.annotation = {
        visible: Boolean(payload.visible),
        text: String(payload.text || "").slice(0, 200),
        updatedByEndpointId: fromEndpoint.endpointId,
        updatedAt: new Date().toISOString()
      };
      notifySession(session);
      send(ws, "session.annotation.updated", { session: publicSession(session) }, requestId);
      return;
    }

    if (type === "session.end") {
      const session = sessions.get(payload.sessionId);
      if (!session || !session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      endSession(session, fromEndpoint.endpointId, "requested", requestId);
      return;
    }

    if (type === "peer.signal") {
      const session = sessions.get(payload.sessionId);
      const targetSocket = sockets.get(payload.toEndpointId);
      const signal = payload.signal && typeof payload.signal === "object" ? payload.signal : null;
      if (!session || !session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      if (!session.participants.includes(payload.toEndpointId) || !targetSocket) {
        send(ws, "error", { code: "target_not_in_session", message: "target endpoint is not in session" }, requestId);
        return;
      }
      if (!signal) {
        send(ws, "error", { code: "bad_signal", message: "signal payload is required" }, requestId);
        return;
      }
      send(targetSocket, "peer.signal", {
        sessionId: session.sessionId,
        fromEndpointId: fromEndpoint.endpointId,
        signal
      });
      send(ws, "peer.signal.sent", { sessionId: session.sessionId, toEndpointId: payload.toEndpointId }, requestId);
      return;
    }

    if (type === "session.leave") {
      const session = sessions.get(payload.sessionId);
      if (!session || !session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      session.participants = session.participants.filter((endpointId) => endpointId !== fromEndpoint.endpointId);
      delete session.subscriptions[fromEndpoint.endpointId];
      send(ws, "session.left", { sessionId: session.sessionId }, requestId);
      if (session.participants.length < 2) {
        endSession(session, fromEndpoint.endpointId, "participant_left");
        return;
      }
      notifySession(session);
      sendSessions();
      return;
    }

    if (type === "session.join") {
      const session = sessions.get(payload.sessionId);
      if (!session) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      if (session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "session.joined", { session: publicSession(session) }, requestId);
        return;
      }
      if (session.participants.length >= session.participantLimit) {
        send(
          ws,
          "error",
          { code: "participant_limit", message: "participant limit reached" },
          requestId
        );
        return;
      }
      session.participants.push(fromEndpoint.endpointId);
      session.subscriptions[fromEndpoint.endpointId] = ["ch1"];
      notifySession(session);
      send(ws, "session.joined", { session: publicSession(session) }, requestId);
      sendSessions();
      return;
    }

    send(ws, "error", { code: "unknown_type", message: `unsupported message type: ${type}` }, requestId);
  }

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => handleMessage(ws, raw.toString()));
    ws.on("close", () => {
      const endpointId = endpointForSocket(ws);
      if (!endpointId) return;
      removeEndpoint(endpointId, "endpoint_disconnected");
    });
  });

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(port, host, () => resolve(httpServer.address()));
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const call of pendingCalls.values()) {
        if (call.timeoutHandle) clearTimeout(call.timeoutHandle);
      }
      pendingCalls.clear();
      for (const ws of wss.clients) ws.close();
      wss.close(() => httpServer.close(resolve));
    });
  }

  return {
    start,
    stop,
    httpServer,
    wss,
    state: { endpoints, pendingCalls, sessions }
  };
}

if (require.main === module) {
  const server = createSignalingServer();
  server.start().then((address) => {
    const host = address.address === "127.0.0.1" ? "127.0.0.1" : address.address;
    console.log(`signaling server listening on ws://${host}:${address.port}/signal`);
  });

  const shutdown = () => {
    server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createSignalingServer };
