import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ust-diagnostic-analyzer-"));
const okSnapshotPath = path.join(tmpDir, "ok-snapshot.json");
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
    session: {
      id: "session-1",
      mediaRoomId: "media-room-1"
    },
    media: {
      iceServerCount: 1,
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
      mediaRoomId: "media-room-2"
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
          state: "ended"
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
    recentEvents: []
  })
);

const okResult = spawnSync(process.execPath, ["scripts/analyze-diagnostics.cjs", okSnapshotPath], {
  encoding: "utf8"
});

assert.equal(okResult.status, 0, okResult.stderr);
assert.match(okResult.stdout, /OK diagnostics look consistent across 1 snapshot/);

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
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: channel ch1 is still waiting for remote WebRTC video/);
assert.match(warningResult.stdout, /WARN warning-snapshot\.json: peer or-2 connection is abnormal/);
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
