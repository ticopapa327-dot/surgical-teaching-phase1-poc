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

function publicEndpoint(endpoint) {
  return {
    endpointId: endpoint.endpointId,
    role: endpoint.role,
    name: endpoint.name,
    address: endpoint.address,
    capabilities: endpoint.capabilities,
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

function createSignalingServer(options = {}) {
  const port = options.port ?? Number(process.env.SIGNALING_PORT || 7077);
  const host = options.host || process.env.SIGNALING_HOST || "127.0.0.1";
  const endpoints = new Map();
  const sockets = new Map();
  const pendingCalls = new Map();
  const sessions = new Map();

  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, endpoints: endpoints.size, sessions: sessions.size }));
      return;
    }
    if (req.url === "/directory") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.from(endpoints.values()).map(publicEndpoint)));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
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
      const participantLimit = Math.max(2, Math.min(16, Number(payload.participantLimit || 2)));
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

    if (type === "session.subscribe") {
      const session = sessions.get(payload.sessionId);
      if (!session || !session.participants.includes(fromEndpoint.endpointId)) {
        send(ws, "error", { code: "session_not_found", message: "session not found" }, requestId);
        return;
      }
      const channels = Array.isArray(payload.channels) && payload.channels.length ? payload.channels : ["ch1"];
      session.subscriptions[fromEndpoint.endpointId] = [...new Set(channels)].slice(0, 4);
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
      sessions.delete(session.sessionId);
      const ended = {
        sessionId: session.sessionId,
        endedByEndpointId: fromEndpoint.endpointId,
        endedAt: new Date().toISOString()
      };
      for (const endpointId of session.participants) {
        const targetSocket = sockets.get(endpointId);
        if (targetSocket) {
          send(targetSocket, "session.ended", ended, endpointId === fromEndpoint.endpointId ? requestId : null);
        }
      }
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
      sockets.delete(endpointId);
      endpoints.delete(endpointId);
      for (const [callId, call] of pendingCalls.entries()) {
        if (call.fromEndpointId === endpointId || call.toEndpointId === endpointId) {
          pendingCalls.delete(callId);
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
