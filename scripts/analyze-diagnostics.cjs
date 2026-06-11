const fs = require("node:fs");
const path = require("node:path");

function readSnapshot(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fileLabel(filePath) {
  return path.basename(filePath);
}

function metricHasVideo(metric) {
  const video = metric?.video || {};
  return [video.sendBitrateBps, video.receiveBitrateBps, video.packetsSent, video.packetsReceived].some(
    (value) => Number.isFinite(value) && value > 0
  );
}

function hasPeerSignalEvent(snapshot) {
  return (Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : []).some(
    (event) => event?.type === "peer.signal.forwarded"
  );
}

function warnRuntime(lines, label, snapshot) {
  const runtime = snapshot?.runtime || {};
  if (runtime.secureContext === false) {
    lines.push(`WARN ${label}: insecure context; local microphone capture may be blocked`);
  }
  if (runtime.getUserMedia === false) {
    lines.push(`WARN ${label}: getUserMedia unavailable; local capture cannot start`);
  }
  if (runtime.webRtc === false) {
    lines.push(`WARN ${label}: RTCPeerConnection unavailable; WebRTC media cannot start`);
  }
  if (runtime.setSinkId === false) {
    lines.push(`INFO ${label}: audio output selection unavailable; system default output is used`);
  }
}

function warnMedia(lines, label, snapshot) {
  const session = snapshot?.session;
  const media = snapshot?.media || {};
  const metrics = Array.isArray(media.statsMetrics) ? media.statsMetrics : [];
  const peers = Array.isArray(media.peerConnections) ? media.peerConnections : [];
  const diagnostics = Array.isArray(media.diagnostics) ? media.diagnostics : [];

  if (session && peers.length === 0 && metrics.length === 0) {
    lines.push(`WARN ${label}: session exists but no WebRTC peer connection or stats metrics were captured`);
  }
  if (session && !metrics.some(metricHasVideo)) {
    lines.push(`WARN ${label}: no positive WebRTC video bitrate or packet counters in stats metrics`);
  }
  if (session && !hasPeerSignalEvent(snapshot)) {
    lines.push(`WARN ${label}: recent events do not include peer.signal.forwarded`);
  }

  for (const diagnostic of diagnostics) {
    if (diagnostic?.state === "waiting") {
      lines.push(`WARN ${label}: channel ${diagnostic.channelId || "unknown"} is still waiting for remote WebRTC video`);
    }
    if (diagnostic?.state === "ended") {
      lines.push(`WARN ${label}: channel ${diagnostic.channelId || "unknown"} remote media is abnormal`);
    }
  }

  for (const peer of peers) {
    if (peer?.state === "ended") {
      lines.push(`WARN ${label}: peer ${peer.endpointId || "unknown"} connection is abnormal`);
    }
  }

  for (const metric of metrics) {
    const peer = metric.endpointId || "unknown-peer";
    const bufferMs = metric.audio?.bufferMs;
    const rttMs = metric.network?.rttMs;
    if (Number.isFinite(bufferMs) && bufferMs > 200) {
      lines.push(`WARN ${label}: audio buffer ${bufferMs} ms for ${peer}`);
    }
    if (Number.isFinite(rttMs) && rttMs > 150) {
      lines.push(`WARN ${label}: RTT ${rttMs} ms for ${peer}`);
    }
  }
}

function analyze(entries) {
  const lines = [];
  const sessionIds = new Map();
  const mediaRoomIds = new Map();
  let iceServerCount = null;

  for (const entry of entries) {
    const { label, snapshot } = entry;
    const session = snapshot?.session;
    if (session?.id) sessionIds.set(label, session.id);
    if (session?.mediaRoomId) mediaRoomIds.set(label, session.mediaRoomId);
    if (Number.isFinite(snapshot?.media?.iceServerCount)) {
      iceServerCount = Math.max(iceServerCount || 0, snapshot.media.iceServerCount);
    }
    warnRuntime(lines, label, snapshot);
    warnMedia(lines, label, snapshot);
  }

  const uniqueSessions = new Set(sessionIds.values());
  const uniqueMediaRooms = new Set(mediaRoomIds.values());
  if (uniqueSessions.size > 1) {
    lines.push(
      `WARN session mismatch: ${Array.from(sessionIds.entries())
        .map(([label, value]) => `${label}=${value}`)
        .join("; ")}`
    );
  }
  if (uniqueMediaRooms.size > 1) {
    lines.push(
      `WARN media room mismatch: ${Array.from(mediaRoomIds.entries())
        .map(([label, value]) => `${label}=${value}`)
        .join("; ")}`
    );
  }
  if (iceServerCount === 0) {
    lines.push("INFO no ICE servers configured; this is expected only for same-LAN host-candidate testing");
  }
  if (!lines.length) {
    lines.push(`OK diagnostics look consistent across ${entries.length} snapshot(s)`);
  }
  return lines;
}

function main(argv) {
  const failOnWarn = argv.includes("--fail-on-warn");
  const filePaths = argv.filter((item) => item !== "--fail-on-warn");
  if (!filePaths.length) {
    console.error("Usage: node scripts/analyze-diagnostics.cjs [--fail-on-warn] <snapshot.json> [snapshot2.json ...]");
    process.exitCode = 1;
    return;
  }

  const entries = filePaths.map((filePath) => ({
    label: fileLabel(filePath),
    snapshot: readSnapshot(filePath)
  }));
  const lines = analyze(entries);
  console.log(lines.join("\n"));
  if (failOnWarn && lines.some((line) => line.startsWith("WARN "))) {
    process.exitCode = 2;
  }
}

main(process.argv.slice(2));
