const fs = require("node:fs");
const path = require("node:path");

const HEADERS = [
  "file",
  "generatedAt",
  "endpointId",
  "endpointName",
  "endpointRole",
  "sessionId",
  "mediaRoomId",
  "mediaState",
  "peerEndpointId",
  "peerEndpointName",
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

function metricRows(filePath, snapshot) {
  const metrics = Array.isArray(snapshot?.media?.statsMetrics) ? snapshot.media.statsMetrics : [];
  const base = {
    file: path.basename(filePath),
    generatedAt: snapshot?.generatedAt || "",
    endpointId: snapshot?.endpoint?.id || "",
    endpointName: snapshot?.endpoint?.name || "",
    endpointRole: snapshot?.endpoint?.role || "",
    sessionId: snapshot?.session?.id || "",
    mediaRoomId: snapshot?.session?.mediaRoomId || "",
    mediaState: snapshot?.media?.state || ""
  };

  if (!metrics.length) {
    return [{ ...base }];
  }

  return metrics.map((metric) => ({
    ...base,
    peerEndpointId: metric.endpointId || "",
    peerEndpointName: metric.endpointName || "",
    sendBitrateBps: metric.video?.sendBitrateBps,
    receiveBitrateBps: metric.video?.receiveBitrateBps,
    packetsSent: metric.video?.packetsSent,
    packetsReceived: metric.video?.packetsReceived,
    packetsLost: metric.video?.packetsLost,
    audioBufferMs: metric.audio?.bufferMs,
    audioJitterMs: metric.audio?.jitterMs,
    rttMs: metric.network?.rttMs,
    iceRoute: metric.network?.iceRoute || ""
  }));
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
