function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
}

function normalizeMetricLimitConfig(config = {}) {
  const normalized = {
    audioBufferWarnMs: Number(config.audioBufferWarnMs),
    audioBufferFailMs: Number(config.audioBufferFailMs),
    rttWarnMs: Number(config.rttWarnMs),
    rttFailMs: Number(config.rttFailMs),
    consecutiveSoftFailureSamples: Math.ceil(Number(config.consecutiveSoftFailureSamples))
  };
  assertFiniteNumber(normalized.audioBufferWarnMs, "audioBufferWarnMs");
  assertFiniteNumber(normalized.audioBufferFailMs, "audioBufferFailMs");
  assertFiniteNumber(normalized.rttWarnMs, "rttWarnMs");
  assertFiniteNumber(normalized.rttFailMs, "rttFailMs");
  if (!Number.isInteger(normalized.consecutiveSoftFailureSamples) || normalized.consecutiveSoftFailureSamples < 1) {
    throw new Error("consecutiveSoftFailureSamples must be a positive integer");
  }
  if (normalized.audioBufferFailMs < normalized.audioBufferWarnMs) {
    throw new Error("audioBufferFailMs must be greater than or equal to audioBufferWarnMs");
  }
  if (normalized.rttFailMs < normalized.rttWarnMs) {
    throw new Error("rttFailMs must be greater than or equal to rttWarnMs");
  }
  return normalized;
}

function metricPeerId(metric) {
  return metric?.endpointId || "unknown";
}

function metricFinding(level, type, label, metric, valueMs, limitMs) {
  const peer = metricPeerId(metric);
  const name = type === "audio-buffer" ? "audio buffer" : "RTT";
  const limitName = level === "failure" ? "hard limit" : "warning limit";
  return {
    key: `${label}:${peer}:${type}`,
    level,
    type,
    label,
    endpointId: peer,
    valueMs,
    limitMs,
    message: `${label}: ${name} ${valueMs} ms for ${peer} exceeds ${limitName} ${limitMs} ms`
  };
}

function collectMetricFindings(snapshot, label, config) {
  const limitConfig = normalizeMetricLimitConfig(config);
  const findings = [];
  const metrics = Array.isArray(snapshot?.media?.statsMetrics) ? snapshot.media.statsMetrics : [];
  for (const metric of metrics) {
    const bufferMs = metric?.audio?.bufferMs;
    const rttMs = metric?.network?.rttMs;
    if (Number.isFinite(bufferMs)) {
      if (bufferMs > limitConfig.audioBufferFailMs) {
        findings.push(metricFinding("failure", "audio-buffer", label, metric, bufferMs, limitConfig.audioBufferFailMs));
      } else if (bufferMs > limitConfig.audioBufferWarnMs) {
        findings.push(metricFinding("warning", "audio-buffer", label, metric, bufferMs, limitConfig.audioBufferWarnMs));
      }
    }
    if (Number.isFinite(rttMs)) {
      if (rttMs > limitConfig.rttFailMs) {
        findings.push(metricFinding("failure", "rtt", label, metric, rttMs, limitConfig.rttFailMs));
      } else if (rttMs > limitConfig.rttWarnMs) {
        findings.push(metricFinding("warning", "rtt", label, metric, rttMs, limitConfig.rttWarnMs));
      }
    }
  }
  return findings;
}

function createSoftLimitTracker(requiredSamples) {
  const required = Math.ceil(Number(requiredSamples));
  if (!Number.isInteger(required) || required < 1) {
    throw new Error("requiredSamples must be a positive integer");
  }
  const counts = new Map();
  return {
    evaluate(warnings) {
      const activeKeys = new Set();
      const warningStates = [];
      for (const warning of warnings) {
        activeKeys.add(warning.key);
        const count = (counts.get(warning.key) || 0) + 1;
        counts.set(warning.key, count);
        warningStates.push({
          ...warning,
          consecutiveSamples: count,
          requiredSamples: required
        });
      }
      for (const key of [...counts.keys()]) {
        if (!activeKeys.has(key)) counts.delete(key);
      }
      return {
        warningStates,
        sustainedFailures: warningStates
          .filter((warning) => warning.consecutiveSamples >= required)
          .map(
            (warning) =>
              `${warning.message} for ${warning.consecutiveSamples} consecutive samples`
          )
      };
    }
  };
}

module.exports = {
  collectMetricFindings,
  createSoftLimitTracker,
  normalizeMetricLimitConfig
};
