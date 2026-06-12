const path = require("node:path");

process.env.UST_REMOTE_CALLER ||= "remote";
process.env.UST_REMOTE_ARTIFACT_DIR ||= path.join("test-results", "remote-windows-audio-reverse-smoke");
process.env.UST_LOCAL_ENDPOINT_ID_PREFIX ||= "or-audio-118-reverse";
process.env.UST_LOCAL_ENDPOINT_NAME_PREFIX ||= "Audio OR 118 Reverse";
process.env.UST_REMOTE_ENDPOINT_ID_PREFIX ||= "teach-audio-117-reverse";
process.env.UST_REMOTE_ENDPOINT_NAME_PREFIX ||= "Audio Teach 117 Reverse";

require("./remote-windows-audio-smoke.cjs");
