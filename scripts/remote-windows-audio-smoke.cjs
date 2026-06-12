const path = require("node:path");

process.env.UST_REMOTE_REQUEST_MODE ||= "interactive";
process.env.UST_REMOTE_EXPECT_AUDIO ||= "true";
process.env.UST_REMOTE_EXPECT_UPLINK_AUDIO ||= "true";
process.env.UST_REMOTE_ALLOW_NON_PUBLISHER_RUNTIME_WARN ||= "false";
process.env.UST_REMOTE_ARTIFACT_DIR ||= path.join("test-results", "remote-windows-audio-smoke");

require("./remote-windows-media-smoke.cjs");
