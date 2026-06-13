import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ust-diagnostics-"));
const metricSnapshotPath = path.join(tmpDir, "metric-snapshot.json");
const peerOnlySnapshotPath = path.join(tmpDir, "peer-only-snapshot.json");
const emptySnapshotPath = path.join(tmpDir, "empty-snapshot.json");

fs.writeFileSync(
  metricSnapshotPath,
  JSON.stringify({
    generatedAt: "2026-06-10T19:30:00.000Z",
    endpoint: {
      id: "teach-pc-b",
      name: "示教室端 PC-B",
      role: "teaching-room"
    },
    runtime: {
      locationHost: "192.168.1.117:5173",
      secureContext: false,
      getUserMedia: false,
      webRtc: true,
      setSinkId: true
    },
    audio: {
      localTracks: [
        {
          id: "track-1",
          label: "Default - Microphone Array",
          enabled: true,
          muted: false,
          readyState: "live"
        }
      ]
    },
    session: {
      id: "session-1",
      mediaRoomId: "media-room-1",
      subscribedChannels: ["ch1", "ch2"]
    },
    media: {
      state: "receiving",
      diagnostics: [
        {
          channelId: "ch1",
          state: "live"
        },
        {
          channelId: "ch2",
          state: "live"
        }
      ],
      peerConnections: [
        {
          endpointId: "or-pc-a",
          state: "live",
          connectionState: "connected",
          iceConnectionState: "connected",
          signalingState: "stable",
          localAudioTrackCount: 1,
          remoteAudioTrackCount: 1
        }
      ],
      statsMetrics: [
        {
          endpointId: "or-pc-a",
          endpointName: "手术室端 PC-A",
          video: {
            sendBitrateBps: null,
            receiveBitrateBps: 851200,
            packetsSent: null,
            packetsReceived: 320,
            packetsLost: 0
          },
          audio: {
            bufferMs: 18,
            jitterMs: 6
          },
          network: {
            rttMs: 4,
            iceRoute: "host->host"
          }
        }
      ]
    }
  })
);

fs.writeFileSync(
  peerOnlySnapshotPath,
  JSON.stringify({
    endpoint: {
      id: "teach-pc-c",
      name: "示教室端 PC-C",
      role: "teaching-room"
    },
    session: {
      id: "session-2",
      mediaRoomId: "media-room-2",
      subscribedChannels: ["ch1"]
    },
    media: {
      state: "publishing",
      diagnostics: [
        {
          channelId: "ch1",
          state: "waiting"
        }
      ],
      peerConnections: [
        {
          endpointId: "or-pc-c",
          state: "waiting",
          connectionState: "connecting",
          iceConnectionState: "checking",
          signalingState: "have-remote-offer",
          localAudioTrackCount: 0,
          remoteAudioTrackCount: 0
        }
      ],
      statsMetrics: []
    }
  })
);

fs.writeFileSync(
  emptySnapshotPath,
  JSON.stringify({
    endpoint: {
      id: "or-pc-a",
      name: "手术室端 PC-A",
      role: "operating-room"
    },
    media: {
      state: "idle",
      statsMetrics: []
    }
  })
);

const result = spawnSync(
  process.execPath,
  ["scripts/summarize-diagnostics.cjs", metricSnapshotPath, peerOnlySnapshotPath, emptySnapshotPath],
  {
    encoding: "utf8"
  }
);

assert.equal(result.status, 0, result.stderr);
const lines = result.stdout.trim().split(/\r?\n/);
assert.equal(lines.length, 4);
assert.equal(
  lines[0],
  "file,generatedAt,endpointId,endpointName,endpointRole,locationHost,secureContext,getUserMedia,webRtc,setSinkId,sessionId,mediaRoomId,mediaState,subscribedChannelCount,liveChannelCount,waitingChannelCount,endedChannelCount,peerEndpointId,peerEndpointName,peerState,connectionState,iceConnectionState,signalingState,localAudioTrackCount,remoteAudioTrackCount,localAudioTrackLabels,sendBitrateBps,receiveBitrateBps,packetsSent,packetsReceived,packetsLost,audioBufferMs,audioJitterMs,rttMs,iceRoute"
);
assert.match(lines[1], /metric-snapshot\.json,2026-06-10T19:30:00\.000Z,teach-pc-b,示教室端 PC-B,teaching-room,192\.168\.1\.117:5173,false,false,true,true,session-1,media-room-1,receiving,2,2,0,0,or-pc-a,手术室端 PC-A,live,connected,connected,stable,1,1,Default - Microphone Array,,851200,,320,0,18,6,4,host->host/);
assert.match(lines[2], /peer-only-snapshot\.json,,teach-pc-c,示教室端 PC-C,teaching-room,,,,,,session-2,media-room-2,publishing,1,0,1,0,or-pc-c,,waiting,connecting,checking,have-remote-offer,0,0,,,,,,,,,/);
assert.match(lines[3], /empty-snapshot\.json,,or-pc-a,手术室端 PC-A,operating-room,,,,,,,,idle,0,0,0,0,,,,,,,,,,,,,,,,,/);

console.log("diagnostic summary test passed");
