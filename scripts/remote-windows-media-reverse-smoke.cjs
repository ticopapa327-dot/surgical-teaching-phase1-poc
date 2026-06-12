const path = require("node:path");

process.env.UST_REMOTE_CALLER ||= "remote";
process.env.UST_REMOTE_ARTIFACT_DIR ||= path.join("test-results", "remote-windows-media-reverse-smoke");
process.env.UST_LOCAL_ENDPOINT_ID_PREFIX ||= "or-media-118-reverse";
process.env.UST_LOCAL_ENDPOINT_NAME_PREFIX ||= "Media OR 118 Reverse";
process.env.UST_REMOTE_ENDPOINT_ID_PREFIX ||= "teach-media-117-reverse";
process.env.UST_REMOTE_ENDPOINT_NAME_PREFIX ||= "Media Teach 117 Reverse";

require("./remote-windows-media-smoke.cjs");
