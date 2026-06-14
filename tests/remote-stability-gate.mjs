import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  collectMetricFindings,
  createSoftLimitTracker,
  normalizeMetricLimitConfig
} = require("../scripts/remote-stability-gate.cjs");

const limits = normalizeMetricLimitConfig({
  audioBufferWarnMs: 200,
  audioBufferFailMs: 500,
  rttWarnMs: 150,
  rttFailMs: 300,
  consecutiveSoftFailureSamples: 3
});

assert.deepEqual(limits, {
  audioBufferWarnMs: 200,
  audioBufferFailMs: 500,
  rttWarnMs: 150,
  rttFailMs: 300,
  consecutiveSoftFailureSamples: 3
});

assert.throws(
  () =>
    normalizeMetricLimitConfig({
      audioBufferWarnMs: 500,
      audioBufferFailMs: 200,
      rttWarnMs: 150,
      rttFailMs: 300,
      consecutiveSoftFailureSamples: 3
    }),
  /audioBufferFailMs/
);

const snapshotWithOneAudioBufferSpike = {
  media: {
    statsMetrics: [
      {
        endpointId: "teach-117",
        audio: { bufferMs: 251 },
        network: { rttMs: 4 }
      }
    ]
  }
};

const oneSpikeFindings = collectMetricFindings(snapshotWithOneAudioBufferSpike, "or-118", limits);
assert.equal(oneSpikeFindings.length, 1);
assert.equal(oneSpikeFindings[0].level, "warning");
assert.equal(oneSpikeFindings[0].key, "or-118:teach-117:audio-buffer");

const tracker = createSoftLimitTracker(3);
assert.deepEqual(tracker.evaluate(oneSpikeFindings).sustainedFailures, []);
assert.deepEqual(tracker.evaluate([]).warningStates, []);
assert.deepEqual(tracker.evaluate(oneSpikeFindings).sustainedFailures, []);
assert.deepEqual(tracker.evaluate(oneSpikeFindings).sustainedFailures, []);
assert.match(tracker.evaluate(oneSpikeFindings).sustainedFailures[0], /3 consecutive samples/);

const hardFailureFindings = collectMetricFindings(
  {
    media: {
      statsMetrics: [
        {
          endpointId: "teach-117",
          audio: { bufferMs: 501 },
          network: { rttMs: 301 }
        }
      ]
    }
  },
  "or-118",
  limits
);
assert.deepEqual(
  hardFailureFindings.map((finding) => finding.level),
  ["failure", "failure"]
);

console.log("remote stability gate test passed");
