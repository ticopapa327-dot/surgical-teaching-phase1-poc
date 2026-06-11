const path = require("node:path");

process.env.UST_REMOTE_REQUEST_MODE ||= "interactive";
process.env.UST_REMOTE_EXPECT_AUDIO ||= "true";
process.env.UST_REMOTE_ALLOW_NON_PUBLISHER_RUNTIME_WARN ||= "true";
process.env.UST_REMOTE_ENDPOINT_ID_PREFIX ||= "teach-audio-137";
process.env.UST_REMOTE_ENDPOINT_NAME_PREFIX ||= "Audio Teach 137";
process.env.UST_REMOTE_ARTIFACT_DIR ||= path.join("test-results", "remote-kylin-audio-smoke");
process.env.UST_REMOTE_SNAPSHOT_SUFFIX ||= "teach-137";

require("./remote-windows-media-smoke.cjs");
