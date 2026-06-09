const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

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

function send(ws, type, payload = {}, requestId = null) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, requestId, payload }));
}

function normalizeChannels(channels) {
  if (!Array.isArray(channels)) return [];
  return channels.slice(0, 16).map((channel, index) => ({
    id: String(channel.id || `ch${index + 1}`).slice(0, 32),
    label: String(channel.label || `Channel ${index + 1}`).slice(0, 80),
    role: String(channel.role || "").slice(0, 80)
  }));
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

function resolveMode(requestMode, acceptMode) {
  return requestMode === "view" || acceptMode === "view" ? "view" : "interactive";
}

function normalizeParticipantLimit(value) {
  return Math.max(2, Math.min(16, Number(value || 2)));
}

function createSignalingServer(options = {}) {
  const port = options.port ?? Number(process.env.SIGNALING_PORT || 7077);
  const host = options.host || process.env.SIGNALING_HOST || "127.0.0.1";
  const endpoints = new Map();
  const sockets = new Map();
  const pendingCalls = new Map();
  const sessions = new Map();
  const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  const httpServer = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, jsonHeaders);
      res.end();
      return;
    }
    if (req.url === "/health") {
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
    if (req.url === "/directory") {
      res.writeHead(200, jsonHeaders);
      res.end(JSON.stringify(Array.from(endpoints.values()).map(publicEndpoint)));
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

  function cancelPendingCall(call, canceledByEndpointId, reason = "canceled", requestId = null) {
    pendingCalls.delete(call.callId);
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
  }

  function handleMessage(ws, raw) {
    const msg = safeJsonParse(raw);
    if (!msg || !msg.type) {
      send(ws, "error", { code: "bad_message", message: "invalid JSON message" });
      return;
    }
    const { type, payload = {}, requestId = null } = msg;

    if (type === "endpoint.register") {
      const endpointId = payload.endpointId || createId("endpoint");
      const endpoint = {
        endpointId,
        role: payload.role || "unknown",
        name: payload.name || endpointId,
        address: payload.address || "",
        capabilities: payload.capabilities || [],
        channels: normalizeChannels(payload.channels),
        registeredAt: new Date().toISOString()
      };
      endpoints.set(endpointId, endpoint);
      sockets.set(endpointId, ws);
      send(ws, "endpoint.registered", { endpoint: publicEndpoint(endpoint) }, requestId);
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

    if (type === "call.request") {
      const toEndpoint = endpoints.get(payload.toEndpointId);
      const targetSocket = sockets.get(payload.toEndpointId);
      if (!toEndpoint || !targetSocket) {
        send(ws, "error", { code: "target_offline", message: "target endpoint is offline" }, requestId);
        return;
      }
      const call = {
        callId: createId("call"),
        fromEndpointId: fromEndpoint.endpointId,
        toEndpointId: toEndpoint.endpointId,
        requestedMode: payload.mode || "interactive",
        participantLimit:
          fromEndpoint.role === "operating-room" ? normalizeParticipantLimit(payload.participantLimit) : null,
        createdAt: new Date().toISOString()
      };
      pendingCalls.set(call.callId, call);
      send(ws, "call.requested", { call }, requestId);
      send(targetSocket, "call.incoming", {
        call,
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
      pendingCalls.delete(call.callId);
      const callerEndpoint = endpoints.get(call.fromEndpointId);
      const participantLimit =
        fromEndpoint.role === "operating-room"
          ? normalizeParticipantLimit(payload.participantLimit || call.participantLimit)
          : normalizeParticipantLimit(
              callerEndpoint?.role === "operating-room" ? call.participantLimit : payload.participantLimit
            );
      const session = {
        sessionId: createId("session"),
        mode: resolveMode(call.requestedMode, payload.mode || "interactive"),
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
      return;
    }

    if (type === "call.reject") {
      const call = pendingCalls.get(payload.callId);
      if (!call || call.toEndpointId !== fromEndpoint.endpointId) {
        send(ws, "error", { code: "call_not_found", message: "pending call not found" }, requestId);
        return;
      }
      pendingCalls.delete(call.callId);
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
      return;
    }

    send(ws, "error", { code: "unknown_type", message: `unsupported message type: ${type}` }, requestId);
  }

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => handleMessage(ws, raw.toString()));
    ws.on("close", () => {
      const endpointId = endpointForSocket(ws);
      if (!endpointId) return;
      for (const [callId, call] of pendingCalls.entries()) {
        if (call.fromEndpointId === endpointId || call.toEndpointId === endpointId) {
          cancelPendingCall(call, endpointId, "endpoint_disconnected");
        }
      }
      sockets.delete(endpointId);
      endpoints.delete(endpointId);
      for (const session of Array.from(sessions.values())) {
        if (session.participants.includes(endpointId)) {
          endSession(session, endpointId, "endpoint_disconnected");
        }
      }
      sendDirectory();
    });
  });

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(port, host, () => resolve(httpServer.address()));
    });
  }

  function stop() {
    return new Promise((resolve) => {
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
