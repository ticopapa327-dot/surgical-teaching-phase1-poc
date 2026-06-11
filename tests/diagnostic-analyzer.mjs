import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ust-diagnostic-analyzer-"));
const okSnapshotPath = path.join(tmpDir, "ok-snapshot.json");
const publisherSnapshotPath = path.join(tmpDir, "publisher-snapshot.json");
const receiveOnlySnapshotPath = path.join(tmpDir, "receive-only-snapshot.json");
const nonPublisherReceiverSnapshotPath = path.join(tmpDir, "non-publisher-receiver-snapshot.json");
const warningSnapshotPath = path.join(tmpDir, "warning-snapshot.json");

fs.writeFileSync(
  okSnapshotPath,
  JSON.stringify({
    runtime: {
      secureContext: true,
      getUserMedia: true,
      webRtc: true,
      setSinkId: true
    },
    endpoint: {
      role: "teaching-room"
    },
    session: {
      id: "session-1",
      mediaRoomId: "media-room-1",
      subscribedChannels: ["ch1"]
    },
    media: {
      iceServerCount: 1,
      diagnostics: [
        {
          channelId: "ch1",
          state: "live"
        }
      ],
      peerConnections: [{ endpointId: "or-1" }],
      statsMetrics: [
        {
          endpointId: "or-1",
          video: {
            receiveBitrateBps: 640000,
            packetsReceived: 300
          },
          audio: {
            bufferMs: 40
          },
          network: {
            rttMs: 10
          }
        }
      ]
    },
    recentEvents: [
      {
        type: "peer.signal.forwarded",
        mediaRoomId: "media-room-1"
      }
    ]
  })
);

fs.writeFileSync(
  publisherSnapshotPath,
  JSON.stringify({
    runtime: {
      secureContext: true,
      getUserMedia: true,
      webRtc: true,
      setSinkId: true
    },
    endpoint: {
      role: "operating-room"
    },
    session: {
      id: "session-publisher",
      mediaRoomId: "media-room-publisher",
      subscribedChannels: ["ch1"]
    },
    media: {
      state: "publishing",
      iceServerCount: 1,
      diagnostics: [
        {
          channelId: "ch1",
          state: "waiting"
        }
      ],
      peerConnections: [
        {
          endpointId: "teach-1",
          state: "live",
          connectionState: "connected",
          iceConnectionState: "connected"
        }
      ],
      statsMetrics: [
        {
          endpointId: "teach-1",
          video: {
            sendBitrateBps: 640000,
            packetsSent: 300
          },
          audio: {
            bufferMs: 40
          },
          network: {
            rttMs: 10
          }
        }
      ]
    },
    recentEvents: [
      {
        type: "peer.signal.forwarded",
        sessionId: "session-publisher",
        mediaRoomId: "media-room-publisher"
      }
    ]
  })
);

fs.writeFileSync(
  warningSnapshotPath,
  JSON.stringify({
    runtime: {
      secureContext: false,
      getUserMedia: false,
      webRtc: true,
      setSinkId: false
    },
    session: {
      id: "session-2",
      mediaRoomId: "media-room-2",
      subscribedChannels: ["ch1", "ch2"]
    },
    media: {
      iceServerCount: 0,
      diagnostics: [
        {
          channelId: "ch1",
          state: "waiting"
        }
      ],
      peerConnections: [
        {
          endpointId: "or-2",
          state: "waiting",
          connectionState: "failed",
          iceConnectionState: "failed"
        }
      ],
      statsMetrics: [
        {
          endpointId: "or-2",
          video: {},
          audio: {
            bufferMs: 260
          },
          network: {
            rttMs: 180
          }
        }
      ]
    },
    recentEvents: [
      {
        type: "peer.signal.forwarded",
        sessionId: "session-old",
        mediaRoomId: "media-room-old"
      }
    ]
  })
);

fs.writeFileSync(
  receiveOnlySnapshotPath,
  JSON.stringify({
    runtime: {
      secureContext: false,
      getUserMedia: false,
      webRtc: true,
      setSinkId: true
    },
    endpoint: {
      role: "teaching-room"
    },
    session: {
      id: "session-view",
      mediaRoomId: "media-room-view",
      mode: "view",
      subscribedChannels: ["ch1"]
    },
    media: {
      iceServerCount: 1,
      diagnostics: [
        {
          channelId: "ch1",
          state: "live"
        }
      ],
      peerConnections: [
        {
          endpointId: "or-view",
          state: "live",
          connectionState: "connected",
          iceConnectionState: "connected"
        }
      ],
      statsMetrics: [
        {
          endpointId: "or-view",
          video: {
            receiveBitrateBps: 640000,
            packetsReceived: 300
          },
          audio: {
            bufferMs: 40
          },
          network: {
            rttMs: 10
          }
        }
      ]
    },
    recentEvents: [
      {
        type: "peer.signal.forwarded",
        sessionId: "session-view",
        mediaRoomId: "media-room-view"
      }
    ]
  })
);

fs.writeFileSync(
  nonPublisherReceiverSnapshotPath,
  JSON.stringify({
    runtime: {
      secureContext: false,
      getUserMedia: false,
      webRtc: true,
      setSinkId: true
    },
    endpoint: {
      role: "teaching-room"
    },
    session: {
      id: "session-interactive",
      mediaRoomId: "media-room-interactive",
      mode: "interactive",
      subscribedChannels: ["ch1"]
    },
    media: {
      state: "receiving",
      iceServerCount: 1,
      diagnostics: [
        {
          channelId: "ch1",
          state: "live"
        }
      ],
      peerConnections: [
        {
          endpointId: "or-interactive",
          state: "live",
          connectionState: "connected",
          iceConnectionState: "connected",
          remoteAudioTrackCount: 1,
          remoteVideoTrackCount: 1
        }
      ],
      statsMetrics: [
        {
          endpointId: "or-interactive",
          video: {
            receiveBitrateBps: 640000,
            packetsReceived: 300
          },
          audio: {
            bufferMs: 40
          },
          network: {
            rttMs: 10
          }
        }
      ]
    },
    recentEvents: [
      {
        type: "peer.signal.forwarded",
        sessionId: "session-interactive",
        mediaRoomId: "media-room-interactive"
      }
    ]
  })
);

const okResult = spawnSync(process.execPath, ["scripts/analyze-diagnostics.cjs", okSnapshotPath], {
  encoding: "utf8"
});

assert.equal(okResult.status, 0, okResult.stderr);
assert.match(okResult.stdout, /OK diagnostics look consistent across 1 snapshot/);

const publisherResult = spawnSync(process.execPath, ["scripts/analyze-diagnostics.cjs", publisherSnapshotPath], {
  encoding: "utf8"
});

assert.equal(publisherResult.status, 0, publisherResult.stderr);
assert.match(publisherResult.stdout, /OK diagnostics look consistent across 1 snapshot/);
assert.doesNotMatch(publisherResult.stdout, /channel ch1 is still waiting/);

const receiveOnlyResult = spawnSync(
  process.execPath,
  [
    "scripts/analyze-diagnostics.cjs",
    "--fail-on-warn",
    "--allow-receive-only-runtime-warn",
    receiveOnlySnapshotPath
  ],
  { encoding: "utf8" }
);

assert.equal(receiveOnlyResult.status, 0, receiveOnlyResult.stderr);
assert.match(receiveOnlyResult.stdout, /INFO receive-only-snapshot\.json: insecure context/);
assert.match(receiveOnlyResult.stdout, /INFO receive-only-snapshot\.json: getUserMedia unavailable/);

const nonPublisherReceiverResult = spawnSync(
  process.execPath,
  [
    "scripts/analyze-diagnostics.cjs",
    "--fail-on-warn",
    "--allow-non-publisher-runtime-warn",
    nonPublisherReceiverSnapshotPath
  ],
  { encoding: "utf8" }
);

assert.equal(nonPublisherReceiverResult.status, 0, nonPublisherReceiverResult.stderr);
assert.match(nonPublisherReceiverResult.stdout, /INFO non-publisher-receiver-snapshot\.json: insecure context/);
assert.match(nonPublisherReceiverResult.stdout, /INFO non-publisher-receiver-snapshot\.json: getUserMedia unavailable/);

const warningResult = spawnSync(
  process.execPath,
  ["scripts/analyze-diagnostics.cjs", okSnapshotPath, warningSnapshotPath],
  { encoding: "utf8" }
);

assert.equal(warningResult.status, 0, warningResult.stderr);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: insecure context/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: getUserMedia unavailable/);
assert.match(warningResult.stdout, /INFO warning-snapshot\.json: audio output selection unavailable/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: no positive WebRTC video bitrate/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: recent events do not include peer\.signal\.forwarded/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: only 1\/2 subscribed channel diagnostics were captured/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: channel ch1 is still waiting for remote WebRTC video/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: peer or-2 connection is abnormal \(failed\)/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: peer or-2 ICE failed during negotiation/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: audio buffer 260 ms for or-2/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: RTT 180 ms for or-2/);
assert.match(warningResult.stdout, /WARN session mismatch/);
assert.match(warningResult.stdout, /WARN media room mismatch/);

const failOnWarnResult = spawnSync(
  process.execPath,
  ["scripts/analyze-diagnostics.cjs", "--fail-on-warn", okSnapshotPath, warningSnapshotPath],
  { encoding: "utf8" }
);

assert.equal(failOnWarnResult.status, 2);
assert.match(failOnWarnResult.stdout, /WARN warning-snapshot\.json/);

console.log("diagnostic analyzer test passed");
