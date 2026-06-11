const path = require("node:path");

process.env.UST_REMOTE_ENDPOINT_ID_PREFIX ||= "teach-media-137";
process.env.UST_REMOTE_ENDPOINT_NAME_PREFIX ||= "Media Teach 137";
process.env.UST_REMOTE_ARTIFACT_DIR ||= path.join("test-results", "remote-kylin-media-smoke");
process.env.UST_REMOTE_SNAPSHOT_SUFFIX ||= "teach-137";

require("./remote-windows-media-smoke.cjs");
