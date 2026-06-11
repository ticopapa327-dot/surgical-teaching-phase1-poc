const fs = require("node:fs");
const path = require("node:path");

const HEADERS = [
  "file",
  "generatedAt",
  "endpointId",
  "endpointName",
  "endpointRole",
  "locationHost",
  "secureContext",
  "getUserMedia",
  "webRtc",
  "setSinkId",
  "sessionId",
  "mediaRoomId",
  "mediaState",
  "subscribedChannelCount",
  "liveChannelCount",
  "waitingChannelCount",
  "endedChannelCount",
  "peerEndpointId",
  "peerEndpointName",
  "peerState",
  "connectionState",
  "iceConnectionState",
  "signalingState",
  "localAudioTrackCount",
  "remoteAudioTrackCount",
  "sendBitrateBps",
  "receiveBitrateBps",
  "packetsSent",
  "packetsReceived",
  "packetsLost",
  "audioBufferMs",
  "audioJitterMs",
  "rttMs",
  "iceRoute"
];

function csvCell(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function channelCounts(snapshot) {
  const subscribedChannels = Array.isArray(snapshot?.session?.subscribedChannels)
    ? snapshot.session.subscribedChannels
    : [];
  const diagnostics = Array.isArray(snapshot?.media?.diagnostics) ? snapshot.media.diagnostics : [];
  return {
    subscribedChannelCount: subscribedChannels.length,
    liveChannelCount: diagnostics.filter((item) => item?.state === "live").length,
    waitingChannelCount: diagnostics.filter((item) => item?.state === "waiting").length,
    endedChannelCount: diagnostics.filter((item) => item?.state === "ended").length
  };
}

function metricRows(filePath, snapshot) {
  const metrics = Array.isArray(snapshot?.media?.statsMetrics) ? snapshot.media.statsMetrics : [];
  const peers = Array.isArray(snapshot?.media?.peerConnections) ? snapshot.media.peerConnections : [];
  const peersByEndpoint = new Map(peers.map((peer) => [peer.endpointId, peer]));
  const counts = channelCounts(snapshot);
  const base = {
    file: path.basename(filePath),
    generatedAt: snapshot?.generatedAt || "",
    endpointId: snapshot?.endpoint?.id || "",
    endpointName: snapshot?.endpoint?.name || "",
    endpointRole: snapshot?.endpoint?.role || "",
    locationHost: snapshot?.runtime?.locationHost || "",
    secureContext: snapshot?.runtime?.secureContext,
    getUserMedia: snapshot?.runtime?.getUserMedia,
    webRtc: snapshot?.runtime?.webRtc,
    setSinkId: snapshot?.runtime?.setSinkId,
    sessionId: snapshot?.session?.id || "",
    mediaRoomId: snapshot?.session?.mediaRoomId || "",
    mediaState: snapshot?.media?.state || "",
    ...counts
  };

  if (!metrics.length) {
    if (!peers.length) return [{ ...base }];
    return peers.map((peer) => ({
      ...base,
      peerEndpointId: peer.endpointId || "",
      peerState: peer.state || "",
      connectionState: peer.connectionState || "",
      iceConnectionState: peer.iceConnectionState || "",
      signalingState: peer.signalingState || "",
      localAudioTrackCount: peer.localAudioTrackCount,
      remoteAudioTrackCount: peer.remoteAudioTrackCount
    }));
  }

  return metrics.map((metric) => {
    const peer = peersByEndpoint.get(metric.endpointId) || {};
    return {
      ...base,
      peerEndpointId: metric.endpointId || "",
      peerEndpointName: metric.endpointName || "",
      peerState: peer.state || "",
      connectionState: peer.connectionState || "",
      iceConnectionState: peer.iceConnectionState || "",
      signalingState: peer.signalingState || "",
      localAudioTrackCount: peer.localAudioTrackCount,
      remoteAudioTrackCount: peer.remoteAudioTrackCount,
      sendBitrateBps: metric.video?.sendBitrateBps,
      receiveBitrateBps: metric.video?.receiveBitrateBps,
      packetsSent: metric.video?.packetsSent,
      packetsReceived: metric.video?.packetsReceived,
      packetsLost: metric.video?.packetsLost,
      audioBufferMs: metric.audio?.bufferMs,
      audioJitterMs: metric.audio?.jitterMs,
      rttMs: metric.network?.rttMs,
      iceRoute: metric.network?.iceRoute || ""
    };
  });
}

function readSnapshot(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main(argv) {
  if (!argv.length) {
    console.error("Usage: node scripts/summarize-diagnostics.cjs <snapshot.json> [snapshot2.json ...]");
    process.exitCode = 1;
    return;
  }

  const rows = argv.flatMap((filePath) => metricRows(filePath, readSnapshot(filePath)));
  console.log([HEADERS, ...rows.map((row) => HEADERS.map((header) => row[header]))].map((row) => row.map(csvCell).join(",")).join("\n"));
}

main(process.argv.slice(2));
