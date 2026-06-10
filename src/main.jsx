import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const CHANNELS = [
  { id: "ch1", label: "通道 1", role: "全景" },
  { id: "ch2", label: "通道 2", role: "术野" },
  { id: "ch3", label: "通道 3", role: "腹腔镜" },
  { id: "ch4", label: "通道 4", role: "备用" }
];

const ADDRESS_BOOK = [
  { id: "teach-a", name: "示教室 A", address: "192.168.10.31", type: "Windows PC" },
  { id: "teach-b", name: "示教室 B", address: "192.168.10.32", type: "Windows PC" },
  { id: "panel-a", name: "会议平板 A", address: "192.168.10.51", type: "Android" }
];

const MOCK_PATIENTS = [
  {
    hisId: "HIS-001",
    name: "患者 001",
    sex: "女",
    age: 45,
    department: "普外科",
    surgery: "腹腔镜胆囊切除术"
  },
  {
    hisId: "HIS-002",
    name: "患者 002",
    sex: "男",
    age: 58,
    department: "泌尿外科",
    surgery: "腹腔镜肾囊肿去顶术"
  }
];

const DEFAULT_SIGNALING_URL = "ws://127.0.0.1:7077/signal";
const LOCAL_ENDPOINT_ID_KEY = "ust.localEndpointId";
const DEFAULT_APP_CONFIG = {
  signalingUrl: DEFAULT_SIGNALING_URL,
  signalingToken: "",
  localEndpoint: {
    id: "or-local",
    name: "手术室端本机",
    role: "operating-room"
  },
  webrtc: {
    iceServers: []
  }
};

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];
const INTERACTION_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
  latency: { ideal: 0.02, max: 0.08 }
};
const LOW_LATENCY_OPUS_PARAMETERS = {
  minptime: "10",
  useinbandfec: "1",
  usedtx: "1",
  maxaveragebitrate: "32000",
  stereo: "0",
  "sprop-stereo": "0"
};

const browserRecordingStore = {
  active: new Map(),
  index: []
};

const api = window.surgicalApi || {
  getAppInfo: async () => ({
    appName: "browser-preview",
    appVersion: "0.1.0",
    recordingsDir: "浏览器内存模式，不写入本地文件"
  }),
  displays: {
    list: async () => []
  },
  recordings: {
    create: async (payload) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      browserRecordingStore.active.set(id, { payload, chunks: [], bytes: 0 });
      return { id, fileName: `${payload.channelLabel || "recording"}.webm`, filePath: "" };
    },
    writeChunk: async ({ recordingId, chunk }) => {
      const item = browserRecordingStore.active.get(recordingId);
      if (!item) return { ok: false };
      item.chunks.push(chunk);
      item.bytes += chunk.byteLength;
      return { ok: true, bytes: item.bytes };
    },
    close: async ({ recordingId, stoppedAt, durationMs }) => {
      const item = browserRecordingStore.active.get(recordingId);
      if (!item) return { ok: false };
      browserRecordingStore.active.delete(recordingId);
      const blob = new Blob(item.chunks, { type: item.payload.mimeType || "video/webm" });
      const record = {
        ...item.payload,
        id: recordingId,
        stoppedAt,
        durationMs,
        bytes: blob.size,
        fileName: `${item.payload.channelLabel || "recording"}.webm`,
        fileUrl: URL.createObjectURL(blob),
        status: "complete"
      };
      browserRecordingStore.index.unshift(record);
      return { ok: true, item: record };
    },
    list: async () => browserRecordingStore.index,
    delete: async (id) => {
      const item = browserRecordingStore.index.find((record) => record.id === id);
      if (item?.fileUrl?.startsWith("blob:")) URL.revokeObjectURL(item.fileUrl);
      browserRecordingStore.index = browserRecordingStore.index.filter((item) => item.id !== id);
      return { ok: true };
    },
    reveal: async () => ({ ok: true }),
    export: async (id) => {
      const item = browserRecordingStore.index.find((record) => record.id === id);
      if (!item?.fileUrl) return { ok: false, reason: "recording_not_found" };
      const link = document.createElement("a");
      link.href = item.fileUrl;
      link.download = item.fileName || "recording.webm";
      link.click();
      return { ok: true };
    },
    uploadFtp: async () => ({ ok: false, reason: "ftp_not_available_in_browser" }),
    openRoot: async () => ({ ok: true })
  }
};

function getSupportedMimeType() {
  if (!window.MediaRecorder) return "";
  return MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" || host === "127.0.0.1" || host.startsWith("127.");
}

function defaultSignalingUrlForPage() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname || "127.0.0.1";
  return `${protocol}//${host}:7077/signal`;
}

function isLoopbackSignalingUrl(value) {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

function generatedEndpointId() {
  const random =
    window.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `ust-${random}`;
}

function stableEndpointId(configuredId) {
  const explicitId = String(configuredId || "").trim();
  if (explicitId && explicitId !== DEFAULT_APP_CONFIG.localEndpoint.id) return explicitId;
  try {
    const stored = window.localStorage.getItem(LOCAL_ENDPOINT_ID_KEY);
    if (stored) return stored;
    const next = generatedEndpointId();
    window.localStorage.setItem(LOCAL_ENDPOINT_ID_KEY, next);
    return next;
  } catch {
    return generatedEndpointId();
  }
}

function normalizeIceServerUrls(urls) {
  const values = Array.isArray(urls) ? urls : [urls];
  return values
    .filter((url) => typeof url === "string")
    .map((url) => url.trim())
    .filter((url, index, all) => /^(stun|turns?):/i.test(url) && all.indexOf(url) === index)
    .slice(0, 8);
}

function normalizeIceServers(iceServers) {
  if (!Array.isArray(iceServers)) return [];
  return iceServers
    .map((server) => {
      if (!server || typeof server !== "object") return null;
      const urls = normalizeIceServerUrls(server.urls);
      if (!urls.length) return null;
      const normalized = { urls: urls.length === 1 ? urls[0] : urls };
      if (typeof server.username === "string" && server.username.trim()) {
        normalized.username = server.username.trim();
      }
      if (typeof server.credential === "string" && server.credential) {
        normalized.credential = server.credential;
      }
      return normalized;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeRuntimeConfig(config = {}) {
  const merged = {
    ...DEFAULT_APP_CONFIG,
    ...config,
    localEndpoint: {
      ...DEFAULT_APP_CONFIG.localEndpoint,
      ...(config.localEndpoint || {})
    },
    webrtc: {
      ...DEFAULT_APP_CONFIG.webrtc,
      ...(config.webrtc || {})
    }
  };
  if (!merged.signalingUrl || (!isLoopbackHost(window.location.hostname) && isLoopbackSignalingUrl(merged.signalingUrl))) {
    merged.signalingUrl = defaultSignalingUrlForPage();
  }
  merged.localEndpoint.id = stableEndpointId(merged.localEndpoint.id);
  merged.webrtc.iceServers = normalizeIceServers(merged.webrtc.iceServers);
  return merged;
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) return normalizeRuntimeConfig(DEFAULT_APP_CONFIG);
    return normalizeRuntimeConfig(await response.json());
  } catch {
    return normalizeRuntimeConfig(DEFAULT_APP_CONFIG);
  }
}

function createDefaultChannelConfig() {
  return Object.fromEntries(
    CHANNELS.map((channel, index) => [
      channel.id,
      {
        sourceMode: "mock",
        deviceId: "",
        enabled: index < 4,
        selectedForRecording: index === 0
      }
    ])
  );
}

function createMockVideoStream(channel) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  let frame = 0;

  const draw = () => {
    const now = new Date();
    const hue = (frame * 2 + channel.id.charCodeAt(2) * 30) % 360;
    ctx.fillStyle = `hsl(${hue}, 38%, 17%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;
    for (let x = 0; x < canvas.width; x += 80) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 80) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255,255,255,0.94)";
    ctx.font = "700 58px Microsoft YaHei, sans-serif";
    ctx.fillText(`${channel.label} ${channel.role}`, 56, 112);
    ctx.font = "32px Consolas, monospace";
    ctx.fillText(now.toLocaleString(), 56, 176);
    ctx.font = "28px Microsoft YaHei, sans-serif";
    ctx.fillText("模拟视频源：用于无 USB 采集卡时验证预览、录制和互动拉流", 56, 234);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(56, 310, 680, 260);
    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = "120px Consolas, monospace";
    ctx.fillText(String(frame % 10000).padStart(4, "0"), 92, 485);
    frame += 1;
  };

  draw();
  const interval = window.setInterval(draw, 1000 / 30);
  const stream = canvas.captureStream(30);
  stream.__cleanup = () => window.clearInterval(interval);
  return stream;
}

function stopStream(stream) {
  if (!stream) return;
  if (typeof stream.__cleanup === "function") stream.__cleanup();
  for (const track of stream.getTracks()) track.stop();
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(ms) {
  if (!ms) return "-";
  const seconds = Math.round(ms / 1000);
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function modeLabel(mode) {
  return mode === "interactive" ? "交互模式" : "仅收看";
}

function canceledReasonLabel(reason) {
  const labels = {
    timeout: "超时",
    caller_canceled: "发起方取消",
    endpoint_disconnected: "终端断开",
    endpoint_reregistered: "终端重新注册",
    canceled: "已取消"
  };
  return labels[reason] || reason || "已取消";
}

function signalingErrorLabel(payload = {}) {
  const labels = {
    bad_message: "信令消息格式错误",
    not_registered: "请先完成终端注册",
    target_offline: "目标终端不在线",
    self_call_forbidden: "不能呼叫本端终端",
    endpoint_busy: "本端或目标终端忙线",
    call_not_found: "待处理呼叫不存在或已失效",
    session_not_found: "会话不存在或当前终端无权访问",
    annotation_forbidden: "只有手术室端可以更新标注",
    session_end_forbidden: "只有会话控制方可以结束多人会话",
    target_not_in_session: "目标终端不在当前会话中",
    bad_signal: "协商消息无效",
    participant_limit: "已达到参与上限",
    unauthorized: "信令鉴权失败",
    unknown_type: "不支持的信令消息类型"
  };
  return labels[payload.code] || payload.message || payload.code || "未知信令错误";
}

function resolveMode(requestMode, confirmMode) {
  return requestMode === "view" || confirmMode === "view" ? "view" : "interactive";
}

function isValidWebSocketUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}

function httpUrlFromSignalingUrl(value, pathname) {
  const url = new URL(value);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function healthUrlFromSignalingUrl(value) {
  return httpUrlFromSignalingUrl(value, "/health");
}

function eventsUrlFromSignalingUrl(value) {
  return httpUrlFromSignalingUrl(value, "/events");
}

function signalingEventLabel(event) {
  const id = event.sessionId || event.callId || event.endpointId || event.eventId || "";
  return `${event.type || "event"}${id ? ` / ${id}` : ""}`;
}

function signalingEventDetails(event) {
  const details = [];
  if (event.fromEndpointId || event.toEndpointId) {
    details.push(`${event.fromEndpointId || "-"} -> ${event.toEndpointId || "-"}`);
  }
  if (event.byEndpointId) details.push(`处理端 ${event.byEndpointId}`);
  if (event.endedByEndpointId) details.push(`结束端 ${event.endedByEndpointId}`);
  if (event.role) details.push(`角色 ${event.role}`);
  if (event.mode) details.push(`模式 ${event.mode}`);
  if (event.requestedMode) details.push(`请求 ${event.requestedMode}`);
  if (event.participantLimit) details.push(`上限 ${event.participantLimit}`);
  if (event.signalKind) details.push(`信号 ${event.signalKind}`);
  if (event.descriptionType) details.push(`SDP ${event.descriptionType}`);
  if (Array.isArray(event.channelIds) && event.channelIds.length) {
    details.push(`通道 ${event.channelIds.join(",")}`);
  }
  if (Number.isFinite(event.trackCount)) details.push(`轨道 ${event.trackCount}`);
  if (event.reason) details.push(`原因 ${event.reason}`);
  return details.join(" / ");
}

function endpointLabel(endpoint) {
  if (!endpoint) return "未知终端";
  return `${endpoint.name || endpoint.endpointId}${endpoint.address ? ` (${endpoint.address})` : ""}`;
}

function capabilitiesForRole(role) {
  if (role === "operating-room") {
    return ["call-control", "publish-video", "subscribe-video", "interactive-audio", "annotation"];
  }
  if (role === "teaching-room") {
    return ["call-control", "subscribe-video", "interactive-audio"];
  }
  return ["subscribe-video"];
}

function sessionChannelsForEndpoint(session, endpointId) {
  const channels = session.subscriptions?.[endpointId];
  return normalizeChannelSelection(channels);
}

function normalizeChannelSelection(channelIds) {
  const validIds = new Set(CHANNELS.map((channel) => channel.id));
  const values = Array.isArray(channelIds) ? channelIds : [channelIds];
  const normalized = [];
  for (const channelId of values) {
    if (typeof channelId !== "string") continue;
    const value = channelId.trim();
    if (!validIds.has(value) || normalized.includes(value)) continue;
    normalized.push(value);
    if (normalized.length >= 4) break;
  }
  return normalized.length ? normalized : ["ch1"];
}

function sessionChannelsForRemoteEndpoint(session, endpointId) {
  return normalizeChannelSelection(session?.subscriptions?.[endpointId]);
}

function publicationSignatureForSession(session, selfEndpointId, directory = []) {
  const participantIds = Array.isArray(session?.participantIds) ? session.participantIds : [];
  const endpointRevisions = new Map(
    (Array.isArray(directory) ? directory : []).map((endpoint) => [
      endpoint.endpointId,
      endpoint.registeredAt || endpoint.address || ""
    ])
  );
  return participantIds
    .filter((endpointId) => endpointId && endpointId !== selfEndpointId)
    .sort()
    .map(
      (endpointId) =>
        `${endpointId}@${endpointRevisions.get(endpointId) || ""}:${sessionChannelsForRemoteEndpoint(session, endpointId).join(",")}`
    )
    .join("|");
}

function interactionAudioConstraints(audioDeviceId) {
  return {
    ...INTERACTION_AUDIO_CONSTRAINTS,
    deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined
  };
}

function applyLowLatencyAudioSdp(sdp) {
  if (!sdp) return sdp;
  const lines = sdp.split(/\r\n/);
  const audioLineIndex = lines.findIndex((line) => line.startsWith("m=audio "));
  const nextMediaLineIndex = lines.findIndex((line, index) => index > audioLineIndex && line.startsWith("m="));
  const audioSectionEnd = nextMediaLineIndex >= 0 ? nextMediaLineIndex : lines.length;
  if (audioLineIndex >= 0) {
    const audioSection = lines.slice(audioLineIndex, audioSectionEnd);
    const additions = [];
    if (!audioSection.some((line) => line === "a=ptime:10")) additions.push("a=ptime:10");
    if (!audioSection.some((line) => line === "a=maxptime:20")) additions.push("a=maxptime:20");
    if (additions.length) lines.splice(audioLineIndex + 1, 0, ...additions);
  }

  const opusPayloadIds = lines
    .map((line) => line.match(/^a=rtpmap:(\d+) opus\/48000/i)?.[1])
    .filter(Boolean);

  for (const payloadId of opusPayloadIds) {
    const fmtpPattern = new RegExp(`^a=fmtp:${payloadId}\\s+`);
    const fmtpIndex = lines.findIndex((line) => fmtpPattern.test(line));
    if (fmtpIndex >= 0) {
      const existing = new Set(
        lines[fmtpIndex]
          .replace(fmtpPattern, "")
          .split(";")
          .map((item) => item.trim().split("=")[0])
          .filter(Boolean)
      );
      const additions = Object.entries(LOW_LATENCY_OPUS_PARAMETERS)
        .filter(([key]) => !existing.has(key))
        .map(([key, value]) => `${key}=${value}`);
      if (additions.length) lines[fmtpIndex] = `${lines[fmtpIndex]};${additions.join(";")}`;
      continue;
    }

    const rtpmapIndex = lines.findIndex((line) => line.startsWith(`a=rtpmap:${payloadId} `));
    if (rtpmapIndex >= 0) {
      lines.splice(
        rtpmapIndex + 1,
        0,
        `a=fmtp:${payloadId} ${Object.entries(LOW_LATENCY_OPUS_PARAMETERS)
          .map(([key, value]) => `${key}=${value}`)
          .join(";")}`
      );
    }
  }

  return lines.join("\r\n");
}

function App({ initialConfig = DEFAULT_APP_CONFIG }) {
  const [appInfo, setAppInfo] = useState(null);
  const [videoDevices, setVideoDevices] = useState([]);
  const [audioDevices, setAudioDevices] = useState([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState([]);
  const [channelConfig, setChannelConfig] = useState(createDefaultChannelConfig);
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [audioOutputDeviceId, setAudioOutputDeviceId] = useState("");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [recordings, setRecordings] = useState([]);
  const [status, setStatus] = useState("准备就绪");
  const [selectedPlayback, setSelectedPlayback] = useState(null);
  const [recordingFilter, setRecordingFilter] = useState("");
  const [isPermissionReady, setPermissionReady] = useState(false);
  const [recordingSessionId, setRecordingSessionId] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [patientQuery, setPatientQuery] = useState("HIS-001");
  const [currentPatient, setCurrentPatient] = useState(null);
  const [patientStatus, setPatientStatus] = useState("未绑定患者");
  const [aiJobs, setAiJobs] = useState([]);
  const webrtcIceServers = initialConfig.webrtc?.iceServers || [];

  const [signalingUrl, setSignalingUrl] = useState(initialConfig.signalingUrl);
  const [localEndpointId, setLocalEndpointId] = useState(initialConfig.localEndpoint?.id || DEFAULT_APP_CONFIG.localEndpoint.id);
  const [localEndpointName, setLocalEndpointName] = useState(
    initialConfig.localEndpoint?.name || DEFAULT_APP_CONFIG.localEndpoint.name
  );
  const [localEndpointRole, setLocalEndpointRole] = useState(
    initialConfig.localEndpoint?.role || DEFAULT_APP_CONFIG.localEndpoint.role
  );
  const [signalingState, setSignalingState] = useState({ connected: false, label: "未连接" });
  const [signalingDirectory, setSignalingDirectory] = useState([]);
  const [signalingSessions, setSignalingSessions] = useState([]);
  const [signalingToken, setSignalingToken] = useState(initialConfig.signalingToken || "");
  const [signalingTargetId, setSignalingTargetId] = useState("");
  const [signalingHealth, setSignalingHealth] = useState("-");
  const [signalingEventsStatus, setSignalingEventsStatus] = useState("-");
  const [signalingEvents, setSignalingEvents] = useState([]);
  const [joinSessionId, setJoinSessionId] = useState("");

  const [callTargetId, setCallTargetId] = useState(ADDRESS_BOOK[0].id);
  const [customAddress, setCustomAddress] = useState("");
  const [requestMode, setRequestMode] = useState("interactive");
  const [confirmMode, setConfirmMode] = useState("interactive");
  const [participantLimit, setParticipantLimit] = useState(2);
  const [pendingCall, setPendingCall] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [layoutMode, setLayoutMode] = useState("single");
  const [displayTargets, setDisplayTargets] = useState([]);
  const [selectedDisplayId, setSelectedDisplayId] = useState("");
  const [annotationText, setAnnotationText] = useState("请关注术野关键区域");
  const [annotationVisible, setAnnotationVisible] = useState(false);
  const [audioCall, setAudioCall] = useState({ state: "idle", label: "未建立" });
  const [webrtcMediaState, setWebrtcMediaState] = useState({ state: "idle", label: "未建立" });
  const [webrtcStatsLabel, setWebrtcStatsLabel] = useState("-");
  const [mediaVersion, setMediaVersion] = useState(0);
  const [overLimitNotice, setOverLimitNotice] = useState("");

  const videoRefs = useRef({});
  const remoteVideoRefs = useRef({});
  const remoteAudioRefs = useRef({});
  const previewStreams = useRef({});
  const activeRecorders = useRef({});
  const pendingWrites = useRef({});
  const interactionAudioStream = useRef(null);
  const signalingSocket = useRef(null);
  const signalingEndpointIdRef = useRef(localEndpointId);
  const signalingDirectoryRef = useRef([]);
  const activeSessionRef = useRef(null);
  const signalingCloseMessageRef = useRef("");
  const mediaPeerConnections = useRef(new Map());
  const mediaPeerChannels = useRef(new Map());
  const mediaPeerTrackMetadata = useRef(new Map());
  const publishedSubscriptionSignature = useRef("");
  const autoRepublishInFlight = useRef(false);
  const mediaRemoteStreams = useRef({});
  const mediaRemoteAudioStreams = useRef({});
  const localAudioSenders = useRef(new Map());
  const pendingMediaIceCandidates = useRef(new Map());
  const mediaStatsTimer = useRef(null);
  const mediaStatsHistory = useRef(new Map());

  const supportedMimeType = useMemo(getSupportedMimeType, []);

  useEffect(() => {
    api.getAppInfo().then(setAppInfo);
    refreshRecordings();
    refreshDisplayTargets({ silent: true });
    return () => {
      Object.values(previewStreams.current).forEach(stopStream);
      stopStream(interactionAudioStream.current);
      for (const peerConnection of mediaPeerConnections.current.values()) peerConnection.close();
      signalingSocket.current?.close();
    };
  }, []);

  useEffect(() => {
    signalingEndpointIdRef.current = localEndpointId.trim() || "or-local";
  }, [localEndpointId]);

  useEffect(() => {
    signalingDirectoryRef.current = signalingDirectory;
    setActiveSession((session) => {
      if (session?.source !== "signaling" || !session.participantIds) return session;
      return {
        ...session,
        participants: session.participantIds.map(endpointLabelById)
      };
    });
  }, [signalingDirectory]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  function shouldAutoRepublishMedia(session = activeSessionRef.current) {
    if (localEndpointRole !== "operating-room") return false;
    if (session?.source !== "signaling") return false;
    if (webrtcMediaState.state !== "publishing" && webrtcMediaState.state !== "connected") return false;
    const nextSignature = publicationSignatureForSession(
      session,
      signalingEndpointIdRef.current,
      signalingDirectoryRef.current
    );
    return Boolean(publishedSubscriptionSignature.current && publishedSubscriptionSignature.current !== nextSignature);
  }

  function triggerAutoRepublishMedia() {
    if (autoRepublishInFlight.current) return;
    autoRepublishInFlight.current = true;
    startSubscribedWebRtcMedia({ auto: true }).finally(() => {
      autoRepublishInFlight.current = false;
      if (shouldAutoRepublishMedia()) {
        window.setTimeout(triggerAutoRepublishMedia, 0);
      }
    });
  }

  useEffect(() => {
    if (activeSession?.source !== "signaling") return;
    const subscribedChannels = new Set(activeSession.subscribedChannels || []);
    let changed = false;
    for (const channelId of Object.keys(mediaRemoteStreams.current)) {
      if (subscribedChannels.has(channelId)) continue;
      delete mediaRemoteStreams.current[channelId];
      const video = remoteVideoRefs.current[channelId];
      if (video) video.srcObject = null;
      changed = true;
    }
    if (changed) setMediaVersion((value) => value + 1);
  }, [activeSession?.source, activeSession?.subscribedChannels?.join(",")]);

  useEffect(() => {
    if (shouldAutoRepublishMedia(activeSession)) triggerAutoRepublishMedia();
  }, [activeSession, localEndpointRole, webrtcMediaState.state]);

  useEffect(() => {
    if (!activeSession) return;
    for (const channelId of activeSession.subscribedChannels) {
      const video = remoteVideoRefs.current[channelId];
      const stream = remoteStreamForChannel(channelId);
      if (video && video.srcObject !== stream) {
        video.srcObject = stream || null;
        if (stream) video.play().catch(() => {});
      }
    }
  }, [activeSession, previewVersion, layoutMode, mediaVersion]);

  useEffect(() => {
    if (!activeSession?.participantIds) return;
    const selfId = signalingEndpointIdRef.current;
    for (const endpointId of activeSession.participantIds.filter((id) => id !== selfId)) {
      const audio = remoteAudioRefs.current[endpointId];
      const stream = mediaRemoteAudioStreams.current[endpointId];
      if (audio) {
        if (audio.srcObject !== stream) {
          audio.srcObject = stream || null;
        }
        applyAudioOutputDevice(audio).finally(() => {
          if (stream) audio.play().catch(() => {});
        });
      }
    }
  }, [activeSession, mediaVersion, audioOutputDeviceId]);

  function audioOutputLabel(deviceId) {
    if (!deviceId) return "系统默认音频输出";
    const device = audioOutputDevices.find((item) => item.deviceId === deviceId);
    return device?.label || deviceId;
  }

  function handleAudioOutputChange(deviceId) {
    setAudioOutputDeviceId(deviceId);
    setStatus(`远端音频输出将使用：${audioOutputLabel(deviceId)}。`);
  }

  async function applyAudioOutputDevice(audioElement) {
    if (!audioElement) return;
    if (typeof audioElement.setSinkId !== "function") {
      if (audioOutputDeviceId) setStatus("当前浏览器不支持选择音频输出设备，继续使用系统默认输出。");
      return;
    }
    if ((audioElement.sinkId || "") === audioOutputDeviceId) return;
    try {
      await audioElement.setSinkId(audioOutputDeviceId);
    } catch (error) {
      setStatus(`音频输出切换失败：${error.message}`);
    }
  }

  async function refreshRecordings() {
    const items = await api.recordings.list();
    setRecordings(items);
  }

  function displayLabel(display) {
    if (!display) return "默认窗口位置";
    const workArea = display.workArea || display.bounds || {};
    const size =
      Number.isFinite(workArea.width) && Number.isFinite(workArea.height)
        ? ` / ${workArea.width}×${workArea.height}`
        : "";
    return `${display.primary ? "主显示器" : "扩展显示器"} ${display.label || display.id}${size}`;
  }

  async function refreshDisplayTargets(options = {}) {
    if (!api.displays?.list) return;
    try {
      const displays = await api.displays.list();
      const normalized = Array.isArray(displays) ? displays : [];
      setDisplayTargets(normalized);
      setSelectedDisplayId((current) =>
        current && normalized.some((display) => String(display.id) === current) ? current : ""
      );
      if (!options.silent) {
        setStatus(
          normalized.length
            ? `已发现 ${normalized.length} 个 Windows 显示器。`
            : "当前运行环境未提供显示器清单，扩展窗口使用默认位置。"
        );
      }
    } catch (error) {
      setDisplayTargets([]);
      if (!options.silent) setStatus(`显示器清单读取失败：${error.message}`);
    }
  }

  async function requestDevicePermissionAndRefresh() {
    setStatus("正在请求摄像头和麦克风权限...");
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("当前页面不支持媒体设备访问。请使用 Chrome/Edge，并从 http://127.0.0.1:5173 打开手术室端。");
      return;
    }
    if (!window.isSecureContext) {
      setStatus("当前页面不是安全上下文，浏览器可能禁止摄像头枚举。手术室端请使用 http://127.0.0.1:5173。");
      return;
    }

    const errors = [];
    let granted = false;
    let videoStream;
    let audioStream;
    try {
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        granted = true;
      } catch (error) {
        errors.push(`视频授权失败：${error.message}`);
      }
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        granted = true;
      } catch (error) {
        errors.push(`音频授权失败：${error.message}`);
      }
      setPermissionReady(granted);
    } finally {
      stopStream(videoStream);
      stopStream(audioStream);
    }
    await refreshDevices({ errors });
  }

  async function refreshDevices(options = {}) {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus("当前环境不支持媒体设备枚举。");
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videos = devices.filter((device) => device.kind === "videoinput");
      const audios = devices.filter((device) => device.kind === "audioinput");
      const audioOutputs = devices.filter((device) => device.kind === "audiooutput");
      setVideoDevices(videos);
      setAudioDevices(audios);
      setAudioOutputDevices(audioOutputs);
      setAudioOutputDeviceId((current) =>
        current && audioOutputs.some((device) => device.deviceId === current) ? current : ""
      );
      const videoNames = videos
        .map((device, index) => device.label || `视频输入 ${index + 1}`)
        .slice(0, 6)
        .join("、");
      const errorText = options.errors?.length ? `；${options.errors.join("；")}` : "";
      setStatus(
        `已发现 ${videos.length} 个视频输入、${audios.length} 个音频输入、${audioOutputs.length} 个音频输出${
          videoNames ? `：${videoNames}` : ""
        }${errorText}`
      );
    } catch (error) {
      setVideoDevices([]);
      setAudioDevices([]);
      setAudioOutputDevices([]);
      setStatus(`媒体设备枚举失败：${error.message}`);
    }
  }

  function updateChannel(channelId, patch) {
    setChannelConfig((current) => ({
      ...current,
      [channelId]: { ...current[channelId], ...patch }
    }));
  }

  async function buildVideoStream(channel) {
    const config = channelConfig[channel.id];
    if (config.sourceMode === "mock") return createMockVideoStream(channel);
    if (!config.deviceId) throw new Error(`${channel.label} 未选择视频设备`);
    return navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: config.deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      },
      audio: false
    });
  }

  async function startPreview(channel) {
    stopStream(previewStreams.current[channel.id]);
    const stream = await buildVideoStream(channel);
    previewStreams.current[channel.id] = stream;
    const video = videoRefs.current[channel.id];
    if (video) {
      video.srcObject = stream;
      await video.play();
    }
    setPreviewVersion((value) => value + 1);
    setStatus(`${channel.label} 预览已启动。`);
  }

  async function startAllPreviews() {
    for (const channel of CHANNELS) {
      if (channelConfig[channel.id].enabled) {
        await startPreview(channel);
      }
    }
  }

  function stopPreview(channel) {
    stopStream(previewStreams.current[channel.id]);
    previewStreams.current[channel.id] = null;
    const video = videoRefs.current[channel.id];
    if (video) video.srcObject = null;
    setPreviewVersion((value) => value + 1);
    setStatus(`${channel.label} 预览已停止。`);
  }

  async function adjustCameraControl(channel, control, direction) {
    const stream = previewStreams.current[channel.id];
    const track = stream?.getVideoTracks?.()[0];
    const config = channelConfig[channel.id];
    const labels = { pan: "云台水平", tilt: "云台垂直", zoom: "镜头变倍" };
    if (config.sourceMode !== "device" || !track) {
      setStatus(`${channel.label} 请先切换为 USB/摄像头设备并启动预览，再控制云台或镜头。`);
      return;
    }
    if (!track.getCapabilities || !track.applyConstraints) {
      setStatus(`${channel.label} 当前浏览器或设备不支持 UVC 云台/镜头控制。`);
      return;
    }
    const capabilities = track.getCapabilities();
    const capability = capabilities?.[control];
    if (!capability || !Number.isFinite(capability.min) || !Number.isFinite(capability.max)) {
      setStatus(`${channel.label} 当前设备不支持${labels[control]}控制。`);
      return;
    }
    const settings = track.getSettings?.() || {};
    const current = Number.isFinite(settings[control]) ? settings[control] : (capability.min + capability.max) / 2;
    const step =
      Number.isFinite(capability.step) && capability.step > 0 ? capability.step : (capability.max - capability.min) / 20;
    const nextValue = clampValue(current + step * direction, capability.min, capability.max);
    try {
      await track.applyConstraints({ advanced: [{ [control]: nextValue }] });
      setStatus(`${channel.label} ${labels[control]}已调整至 ${Math.round(nextValue * 100) / 100}。`);
    } catch (error) {
      setStatus(`${channel.label} ${labels[control]}控制失败：${error.message}`);
    }
  }

  async function getAudioTracksForRecording() {
    if (!includeAudio || !audioDeviceId) return [];
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: { exact: audioDeviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    return stream.getAudioTracks();
  }

  async function startRecording(channel) {
    let recordStream = null;
    try {
      if (!supportedMimeType) {
        setStatus("当前环境不支持 MediaRecorder，无法录制。");
        return;
      }
      if (!previewStreams.current[channel.id]) {
        await startPreview(channel);
      }
      if (activeRecorders.current[channel.id]) return;

      const previewStream = previewStreams.current[channel.id];
      const videoTrack = previewStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error("没有可录制的视频轨道");

      const audioTracks = await getAudioTracksForRecording();
      recordStream = new MediaStream([videoTrack.clone(), ...audioTracks]);
      const startedAt = new Date().toISOString();
      const sessionId = recordingSessionId || `phase1-${startedAt.slice(0, 19).replace(/[:T]/g, "-")}`;
      setRecordingSessionId(sessionId);

      const created = await api.recordings.create({
        sessionId,
        channelId: channel.id,
        channelLabel: `${channel.label}-${channel.role}`,
        sourceMode: channelConfig[channel.id].sourceMode,
        sourceDeviceId: channelConfig[channel.id].deviceId,
        sourceLabel: getDeviceLabel(channelConfig[channel.id].deviceId),
        patient: currentPatient,
        mimeType: supportedMimeType,
        startedAt
      });

      const recorder = new MediaRecorder(recordStream, { mimeType: supportedMimeType });
      const writes = [];
      pendingWrites.current[channel.id] = writes;

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        const writePromise = event.data.arrayBuffer().then((chunk) =>
          api.recordings.writeChunk({
            recordingId: created.id,
            chunk
          })
        );
        writes.push(writePromise);
      };

      recorder.onerror = (event) => {
        setStatus(`${channel.label} 录制错误：${event.error?.message || "未知错误"}`);
      };

      recorder.onstop = async () => {
        let nextStatus = `${channel.label} 录制已完成。`;
        try {
          const writeResults = await Promise.allSettled(writes);
          const failedWrite = writeResults.find(
            (result) => result.status === "rejected" || result.value?.ok === false
          );
          const active = activeRecorders.current[channel.id];
          const closeResult = await api.recordings.close({
            recordingId: created.id,
            stoppedAt: new Date().toISOString(),
            durationMs: active ? Date.now() - active.startedAtMs : null
          });
          if (!closeResult?.ok) {
            nextStatus = `${channel.label} 录制停止失败：${closeResult?.reason || "关闭失败"}`;
          } else if (failedWrite) {
            nextStatus = `${channel.label} 录制已停止，但部分数据写入失败。`;
          }
        } catch (error) {
          nextStatus = `${channel.label} 录制停止失败：${error.message}`;
        } finally {
          stopStream(recordStream);
          delete activeRecorders.current[channel.id];
          delete pendingWrites.current[channel.id];
          await refreshRecordings();
          setStatus(nextStatus);
        }
      };

      recorder.start(1000);
      activeRecorders.current[channel.id] = {
        recorder,
        recordingId: created.id,
        startedAtMs: Date.now()
      };
      setStatus(`${channel.label} 正在录制。`);
    } catch (error) {
      stopStream(recordStream);
      setStatus(`${channel.label} 录制启动失败：${error.message}`);
    }
  }

  async function stopRecording(channel) {
    const active = activeRecorders.current[channel.id];
    if (!active) return;
    if (active.recorder.state !== "inactive") {
      active.recorder.stop();
      setStatus(`${channel.label} 正在停止录制...`);
    }
  }

  async function startSelectedRecording() {
    for (const channel of CHANNELS) {
      const config = channelConfig[channel.id];
      if (config.selectedForRecording && config.enabled) {
        await startRecording(channel);
      }
    }
  }

  async function stopAllRecording() {
    for (const channel of CHANNELS) {
      await stopRecording(channel);
    }
  }

  function getDeviceLabel(deviceId) {
    const device = videoDevices.find((item) => item.deviceId === deviceId);
    return device?.label || "";
  }

  function audioInputLabel(deviceId) {
    if (!deviceId) return "未选麦克风";
    const device = audioDevices.find((item) => item.deviceId === deviceId);
    return device?.label || "已选麦克风";
  }

  function queryMockPatient() {
    const key = patientQuery.trim().toUpperCase();
    const patient = MOCK_PATIENTS.find((item) => item.hisId === key);
    if (!patient) {
      setCurrentPatient(null);
      setPatientStatus("未查询到患者，当前录像不会绑定患者信息。");
      setStatus("模拟 HIS 未查询到患者。");
      return;
    }
    setCurrentPatient(patient);
    setPatientStatus(`${patient.name} / ${patient.hisId} / ${patient.department}`);
    setStatus(`已从模拟 HIS 获取 ${patient.name}，新录像将绑定该患者。`);
  }

  function clearPatientBinding() {
    setCurrentPatient(null);
    setPatientStatus("未绑定患者");
    setStatus("已清除患者绑定。");
  }

  function enqueueAiJob(recording) {
    if (!recording) return;
    const job = {
      id: `ai-${Date.now()}`,
      recordingId: recording.id,
      channelLabel: recording.channelLabel,
      fileName: recording.fileName,
      durationMs: recording.durationMs,
      bytes: recording.bytes,
      patient: recording.patient || null,
      status: "queued",
      createdAt: new Date().toISOString()
    };
    setAiJobs((jobs) => [job, ...jobs]);
    setStatus(`AI 处理任务已加入本地模拟队列：${recording.channelLabel}`);
  }

  function recordingDisplayName(recording) {
    return recording?.fileName || recording?.channelLabel || "录像文件";
  }

  function recordingFilterText(recording) {
    return [
      recording?.fileName,
      recording?.channelLabel,
      recording?.startedAt,
      recording?.stoppedAt,
      recording?.patient?.name,
      recording?.patient?.hisId,
      recording?.patient?.department,
      recording?.patient?.surgery
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  async function revealRecording(recording) {
    if (!recording) return;
    try {
      const result = await api.recordings.reveal(recording.id);
      setStatus(
        result?.ok ? `已定位录像：${recordingDisplayName(recording)}` : `录像定位失败：${result?.reason || "未知错误"}`
      );
    } catch (error) {
      setStatus(`录像定位失败：${error.message}`);
    }
  }

  async function exportRecording(recording) {
    if (!recording) return;
    try {
      const result = await api.recordings.export(recording.id);
      if (result?.ok) {
        setStatus(`录像已导出：${result.filePath || recordingDisplayName(recording)}`);
        return;
      }
      setStatus(result?.reason === "canceled" ? "已取消导出录像。" : `录像导出失败：${result?.reason || "未知错误"}`);
    } catch (error) {
      setStatus(`录像导出失败：${error.message}`);
    }
  }

  async function uploadRecordingToFtp(recording) {
    if (!recording) return;
    if (!api.recordings.uploadFtp) {
      setStatus("FTP 上传失败：当前客户端未提供上传接口。");
      return;
    }
    try {
      const result = await api.recordings.uploadFtp(recording.id);
      if (result?.ok) {
        setStatus(`录像已上传 FTP：${result.remotePath || recordingDisplayName(recording)}`);
        return;
      }
      setStatus(`FTP 上传失败：${result?.reason || "未知错误"}`);
    } catch (error) {
      setStatus(`FTP 上传失败：${error.message}`);
    }
  }

  async function deleteRecording(recording) {
    if (!recording) return;
    try {
      const result = await api.recordings.delete(recording.id);
      if (!result?.ok) {
        setStatus(`录像删除失败：${result?.reason || "未知错误"}`);
        return;
      }
      if (selectedPlayback?.id === recording.id) setSelectedPlayback(null);
      await refreshRecordings();
      setStatus(`录像已删除：${recordingDisplayName(recording)}`);
    } catch (error) {
      setStatus(`录像删除失败：${error.message}`);
    }
  }

  async function openRecordingRoot() {
    try {
      const result = await api.recordings.openRoot();
      setStatus(result?.ok ? "已打开录像目录。" : `录像目录打开失败：${result?.reason || "未知错误"}`);
    } catch (error) {
      setStatus(`录像目录打开失败：${error.message}`);
    }
  }

  function selectedTarget() {
    return ADDRESS_BOOK.find((item) => item.id === callTargetId) || ADDRESS_BOOK[0];
  }

  function endpointLabelById(endpointId) {
    const endpoint = signalingDirectoryRef.current.find((item) => item.endpointId === endpointId);
    return endpoint ? endpointLabel(endpoint) : endpointId;
  }

  function sessionDirectoryLabel(session) {
    const participants = Array.isArray(session.participants) ? session.participants : [];
    const participantText = participants.map(endpointLabelById).join("、") || "-";
    const participantCount = Number.isFinite(Number(session.participantCount))
      ? session.participantCount
      : participants.length;
    return `${session.sessionId} / ${modeLabel(session.mode)} / ${participantCount} / ${session.participantLimit} / ${participantText}`;
  }

  function setDirectoryFromSignaling(endpoints) {
    const onlineEndpoints = Array.isArray(endpoints) ? endpoints : [];
    setSignalingDirectory(onlineEndpoints);
    setSignalingTargetId((current) => {
      const selfId = signalingEndpointIdRef.current;
      if (current && onlineEndpoints.some((item) => item.endpointId === current && item.endpointId !== selfId)) {
        return current;
      }
      return onlineEndpoints.find((item) => item.endpointId !== selfId)?.endpointId || "";
    });
  }

  function setSessionsFromSignaling(sessions) {
    setSignalingSessions(Array.isArray(sessions) ? sessions : []);
  }

  function sendSignaling(type, payload = {}) {
    const ws = signalingSocket.current;
    if (!ws || ws.readyState !== 1) {
      setStatus("信令服务器未连接。");
      return false;
    }
    ws.send(
      JSON.stringify({
        type,
        requestId: `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        payload
      })
    );
    return true;
  }

  function applySignalingSession(session, resetLayout = false, allowNew = false) {
    if (!session) return;
    const currentSession = activeSessionRef.current;
    if (!allowNew && !currentSession) return;
    if (currentSession?.id && currentSession.id !== session.sessionId) return;
    const endpointId = signalingEndpointIdRef.current;
    const nextSession = {
      id: session.sessionId,
      source: "signaling",
      startedAt: session.startedAt,
      mode: session.mode,
      ownerEndpointId: session.ownerEndpointId,
      participantIds: session.participants,
      participants: session.participants.map(endpointLabelById),
      participantLimit: session.participantLimit,
      subscriptions: session.subscriptions || {},
      subscribedChannels: sessionChannelsForEndpoint(session, endpointId)
    };
    activeSessionRef.current = nextSession;
    setActiveSession(nextSession);
    if (session.annotation) {
      setAnnotationText(session.annotation.text || "");
      setAnnotationVisible(Boolean(session.annotation.visible));
    }
    if (resetLayout) setLayoutMode("single");
    setPendingCall(null);
    setOverLimitNotice("");
  }

  function channelLabelById(channelId) {
    const channel = CHANNELS.find((item) => item.id === channelId);
    return channel ? `${channel.label} ${channel.role}` : channelId;
  }

  function remoteStreamForChannel(channelId) {
    if (activeSession?.source === "signaling" && mediaRemoteStreams.current[channelId]) {
      return mediaRemoteStreams.current[channelId];
    }
    return previewStreams.current[channelId] || null;
  }

  function remoteMediaHealth(channelId) {
    const remoteStream = activeSession?.source === "signaling" ? mediaRemoteStreams.current[channelId] : null;
    const fallbackStream = previewStreams.current[channelId] || null;
    const stream = remoteStream || fallbackStream;
    const videoTracks = stream?.getVideoTracks?.() || [];
    const liveVideoTracks = videoTracks.filter((track) => track.readyState === "live");

    if (remoteStream) {
      if (liveVideoTracks.length > 0) {
        const mutedTracks = liveVideoTracks.filter((track) => track.muted).length;
        return {
          state: mutedTracks === liveVideoTracks.length ? "waiting" : "live",
          label: mutedTracks === liveVideoTracks.length ? "远端轨道等待" : "真实远端",
          detail: `${channelLabelById(channelId)}：已收到 ${liveVideoTracks.length} 路 WebRTC 视频轨道`
        };
      }
      return {
        state: "ended",
        label: "轨道中断",
        detail: `${channelLabelById(channelId)}：已收到远端流，但视频轨道不可用`
      };
    }

    if (activeSession?.source === "signaling") {
      return {
        state: "waiting",
        label: fallbackStream ? "等待远端" : "未收到",
        detail: `${channelLabelById(channelId)}：已订阅，尚未收到远端 WebRTC 视频轨道`
      };
    }

    if (liveVideoTracks.length > 0) {
      return {
        state: "local",
        label: "本地模拟",
        detail: `${channelLabelById(channelId)}：当前显示本地预览流`
      };
    }

    return {
      state: "idle",
      label: "未启动",
      detail: `${channelLabelById(channelId)}：未建立媒体流`
    };
  }

  function peerConnectionHealth(endpointId, peerConnection) {
    const connectionState = peerConnection?.connectionState || "unknown";
    const iceState = peerConnection?.iceConnectionState || "unknown";
    const signalingState = peerConnection?.signalingState || "unknown";
    const localAudioTrackCount = (localAudioSenders.current.get(endpointId) || []).filter(
      (sender) => sender.track?.readyState === "live"
    ).length;
    const remoteAudioTrackCount = (mediaRemoteAudioStreams.current[endpointId]?.getAudioTracks?.() || []).filter(
      (track) => track.readyState === "live"
    ).length;
    const state =
      connectionState === "connected"
        ? "live"
        : connectionState === "failed" || connectionState === "disconnected" || connectionState === "closed"
          ? "ended"
          : "waiting";
    const label =
      state === "live"
        ? "已连接"
        : state === "ended"
          ? "连接异常"
          : "协商中";
    return {
      endpointId,
      state,
      label,
      detail: `${endpointLabelById(
        endpointId
      )}：连接 ${connectionState} / ICE ${iceState} / 协商 ${signalingState} / 音频 本地${localAudioTrackCount} 远端${remoteAudioTrackCount}`
    };
  }

  function activeRemoteEndpointIds() {
    const session = activeSessionRef.current;
    const selfId = signalingEndpointIdRef.current;
    if (!session?.participantIds) return [];
    return session.participantIds.filter((endpointId) => endpointId && endpointId !== selfId);
  }

  async function ensureInteractionAudioStream() {
    if (interactionAudioStream.current?.getAudioTracks().some((track) => track.readyState === "live")) {
      return interactionAudioStream.current;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前页面不支持麦克风采集");
    }
    if (!window.isSecureContext) {
      throw new Error("当前页面不是安全上下文，不能采集本地麦克风；示教室端如需发言请使用本机 127.0.0.1 或 HTTPS");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: interactionAudioConstraints(audioDeviceId)
    });
    interactionAudioStream.current = stream;
    setAudioCall({
      state: "connected",
      label: `本地音频已建立，低延迟模式，轨道 ${stream.getAudioTracks().length} 路`
    });
    return stream;
  }

  async function tuneAudioSender(sender) {
    if (!sender?.track || sender.track.kind !== "audio" || !sender.getParameters || !sender.setParameters) return;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings = parameters.encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: 32000,
      priority: "high",
      networkPriority: "high"
    }));
    try {
      await sender.setParameters(parameters);
    } catch {
      // Browsers can reject optional RTP priority fields; SDP low-latency hints still apply.
    }
  }

  function tuneAudioReceiver(peerConnection, track) {
    const receiver = peerConnection.getReceivers().find((item) => item.track === track);
    if (!receiver) return;
    if ("playoutDelayHint" in receiver) {
      try {
        receiver.playoutDelayHint = 0;
      } catch {
        // Optional browser optimization.
      }
    }
    if (!("jitterBufferTarget" in receiver)) return;
    try {
      receiver.jitterBufferTarget = 0.02;
    } catch {
      // Optional browser optimization.
    }
  }

  function formatMs(value) {
    return Number.isFinite(value) ? `${Math.max(0, Math.round(value))} ms` : "-";
  }

  function formatBitrate(value) {
    if (!Number.isFinite(value) || value < 0) return "-";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
    if (value >= 1_000) return `${Math.round(value / 1_000)} kbps`;
    return `${Math.round(value)} bps`;
  }

  function candidateTypeLabel(candidate) {
    return typeof candidate?.candidateType === "string" && candidate.candidateType ? candidate.candidateType : "-";
  }

  function statsHistoryKey(endpointId, report) {
    return `${endpointId}:${report.type}:${report.id}`;
  }

  function trackBitrate(endpointId, report, bytes) {
    if (!Number.isFinite(bytes) || !Number.isFinite(report.timestamp)) return null;
    const key = statsHistoryKey(endpointId, report);
    const previous = mediaStatsHistory.current.get(key);
    mediaStatsHistory.current.set(key, { bytes, timestamp: report.timestamp });
    if (!previous || report.timestamp <= previous.timestamp || bytes < previous.bytes) return null;
    return ((bytes - previous.bytes) * 8 * 1000) / (report.timestamp - previous.timestamp);
  }

  async function updateWebRtcStats() {
    const values = [];
    for (const [endpointId, peerConnection] of mediaPeerConnections.current.entries()) {
      if (peerConnection.connectionState === "closed") continue;
      try {
        const stats = await peerConnection.getStats();
        const reports = [];
        stats.forEach((report) => reports.push(report));
        const reportsById = new Map(reports.map((report) => [report.id, report]));
        let audioBufferMs = null;
        let audioJitterMs = null;
        let rttMs = null;
        let iceRouteLabel = "-→-";
        let videoBitrateBps = 0;
        let hasVideoBitrate = false;
        let videoPacketsLost = 0;
        let hasVideoPacketsLost = false;
        reports.forEach((report) => {
          const reportKind = report.kind || report.mediaType;
          if (
            report.type === "inbound-rtp" &&
            reportKind === "audio" &&
            report.jitterBufferDelay != null &&
            report.jitterBufferEmittedCount
          ) {
            audioBufferMs = (report.jitterBufferDelay / report.jitterBufferEmittedCount) * 1000;
            audioJitterMs = Number.isFinite(report.jitter) ? report.jitter * 1000 : audioJitterMs;
          }
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime != null) {
            rttMs = report.currentRoundTripTime * 1000;
            const localCandidate = reportsById.get(report.localCandidateId);
            const remoteCandidate = reportsById.get(report.remoteCandidateId);
            iceRouteLabel = `${candidateTypeLabel(localCandidate)}→${candidateTypeLabel(remoteCandidate)}`;
          }
          if (reportKind === "video" && (report.type === "inbound-rtp" || report.type === "outbound-rtp")) {
            const bytes = report.type === "outbound-rtp" ? report.bytesSent : report.bytesReceived;
            const bitrate = trackBitrate(endpointId, report, bytes);
            if (Number.isFinite(bitrate)) {
              videoBitrateBps += bitrate;
              hasVideoBitrate = true;
            }
            if (report.type === "inbound-rtp" && Number.isFinite(report.packetsLost)) {
              videoPacketsLost += report.packetsLost;
              hasVideoPacketsLost = true;
            }
          }
        });
        values.push(
          `${endpointLabelById(endpointId)}：视频 ${formatBitrate(
            hasVideoBitrate ? videoBitrateBps : null
          )} / 丢包 ${hasVideoPacketsLost ? videoPacketsLost : "-"} / 音频缓冲 ${formatMs(audioBufferMs)} / jitter ${formatMs(
            audioJitterMs
          )} / RTT ${formatMs(rttMs)} / ICE ${iceRouteLabel}`
        );
      } catch {
        values.push(`${endpointLabelById(endpointId)}：统计读取失败`);
      }
    }
    setWebrtcStatsLabel(values.length ? values.join("；") : "-");
  }

  function ensureMediaStatsPolling() {
    if (mediaStatsTimer.current) return;
    mediaStatsTimer.current = window.setInterval(updateWebRtcStats, 1000);
    updateWebRtcStats();
  }

  function stopMediaStatsPolling() {
    if (mediaStatsTimer.current) {
      window.clearInterval(mediaStatsTimer.current);
      mediaStatsTimer.current = null;
    }
    setWebrtcStatsLabel("-");
  }

  async function setLowLatencyLocalDescription(peerConnection, description) {
    const nextDescription =
      description?.sdp && (description.type === "offer" || description.type === "answer")
        ? { type: description.type, sdp: applyLowLatencyAudioSdp(description.sdp) }
        : description;
    await peerConnection.setLocalDescription(nextDescription);
  }

  async function addInteractionAudioToPeerConnection(peerConnection, endpointId) {
    if (activeSessionRef.current?.mode !== "interactive") return false;
    const stream = await ensureInteractionAudioStream();
    const senders = localAudioSenders.current.get(endpointId) || [];
    const existingTracks = new Set(peerConnection.getSenders().map((sender) => sender.track).filter(Boolean));
    for (const track of stream.getAudioTracks()) {
      if (existingTracks.has(track)) continue;
      const sender = peerConnection.addTrack(track, stream);
      await tuneAudioSender(sender);
      senders.push(sender);
    }
    localAudioSenders.current.set(endpointId, senders);
    return stream.getAudioTracks().length > 0;
  }

  async function renegotiatePeerConnection(endpointId, channelIds = ["ch1"]) {
    const session = activeSessionRef.current;
    const peerConnection = mediaPeerConnections.current.get(endpointId);
    if (!session?.id || !peerConnection) return;
    const normalizedChannelIds = normalizeChannelSelection(channelIds);
    const offer = await peerConnection.createOffer();
    await setLowLatencyLocalDescription(peerConnection, offer);
    sendSignaling("peer.signal", {
      sessionId: session.id,
      toEndpointId: endpointId,
      signal: {
        kind: "media-offer",
        channelId: normalizedChannelIds[0],
        channelIds: normalizedChannelIds,
        tracks: mediaPeerTrackMetadata.current.get(endpointId) || [],
        description: peerConnection.localDescription
      }
    });
  }

  function createMediaPeerConnection(endpointId) {
    const existing = mediaPeerConnections.current.get(endpointId);
    if (existing && existing.connectionState !== "closed") return existing;

    if (!window.RTCPeerConnection) {
      throw new Error("当前环境不支持 RTCPeerConnection");
    }

    const peerConnection = new RTCPeerConnection({ iceServers: webrtcIceServers });
    mediaPeerConnections.current.set(endpointId, peerConnection);
    ensureMediaStatsPolling();

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      const session = activeSessionRef.current;
      if (!session?.id) return;
      sendSignaling("peer.signal", {
        sessionId: session.id,
        toEndpointId: endpointId,
        signal: {
          kind: "ice",
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate
        }
      });
    };

    peerConnection.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      const trackMetadata = mediaPeerTrackMetadata.current.get(endpointId) || [];
      const mappedTrack = trackMetadata.find(
        (item) =>
          item.kind === event.track.kind &&
          (item.trackId === event.track.id || item.streamId === stream.id)
      );
      const channelId = mappedTrack?.channelId || mediaPeerChannels.current.get(endpointId) || "ch1";
      if (event.track.kind === "video") {
        mediaRemoteStreams.current[channelId] = stream;
        setWebrtcMediaState({
          state: "receiving",
          label: `收到 ${endpointLabelById(endpointId)} 的 ${channelLabelById(channelId)}`
        });
      }
      if (event.track.kind === "audio") {
        tuneAudioReceiver(peerConnection, event.track);
        const audioStream = mediaRemoteAudioStreams.current[endpointId] || new MediaStream();
        if (!audioStream.getTracks().includes(event.track)) {
          audioStream.addTrack(event.track);
        }
        mediaRemoteAudioStreams.current[endpointId] = audioStream;
        setAudioCall({
          state: "connected",
          label: `已接收 ${endpointLabelById(endpointId)} 的远端音频，低延迟模式`
        });
      }
      setMediaVersion((value) => value + 1);
    };

    const refreshPeerDiagnostics = () => setMediaVersion((value) => value + 1);

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === "failed" || state === "disconnected") {
        setWebrtcMediaState({ state: "error", label: `媒体链路${state}` });
      }
      if (state === "connected") {
        setWebrtcMediaState((current) =>
          current.state === "publishing" || current.state === "receiving"
            ? current
            : { state: "connected", label: `已连接 ${endpointLabelById(endpointId)}` }
        );
      }
      refreshPeerDiagnostics();
    };
    peerConnection.oniceconnectionstatechange = refreshPeerDiagnostics;
    peerConnection.onicegatheringstatechange = refreshPeerDiagnostics;
    peerConnection.onsignalingstatechange = refreshPeerDiagnostics;

    return peerConnection;
  }

  function queueMediaIceCandidate(endpointId, candidate) {
    const queued = pendingMediaIceCandidates.current.get(endpointId) || [];
    queued.push(candidate);
    pendingMediaIceCandidates.current.set(endpointId, queued);
  }

  function closeMediaPeerConnection(endpointId) {
    const existing = mediaPeerConnections.current.get(endpointId);
    if (existing) existing.close();
    mediaPeerConnections.current.delete(endpointId);
    mediaPeerChannels.current.delete(endpointId);
    mediaPeerTrackMetadata.current.delete(endpointId);
    localAudioSenders.current.delete(endpointId);
    delete mediaRemoteAudioStreams.current[endpointId];
    pendingMediaIceCandidates.current.delete(endpointId);
    for (const key of mediaStatsHistory.current.keys()) {
      if (key.startsWith(`${endpointId}:`)) mediaStatsHistory.current.delete(key);
    }
  }

  function openMediaPeerConnectionCount() {
    return Array.from(mediaPeerConnections.current.values()).filter(
      (peerConnection) => peerConnection.connectionState !== "closed"
    ).length;
  }

  function cleanupWebRtcMediaForEndpoint(endpointId, message) {
    closeMediaPeerConnection(endpointId);
    const remainingPeers = openMediaPeerConnectionCount();
    if (remainingPeers === 0) {
      publishedSubscriptionSignature.current = "";
      mediaStatsHistory.current.clear();
      stopMediaStatsPolling();
      setWebrtcMediaState({ state: "idle", label: "未建立" });
    } else {
      setWebrtcMediaState({
        state: "publishing",
        label: `${endpointLabelById(endpointId)} 已停止媒体链路，仍向 ${remainingPeers} 个远端发布`
      });
    }
    setMediaVersion((value) => value + 1);
    if (message) setStatus(message);
  }

  async function addMediaIceCandidate(endpointId, candidate) {
    if (!candidate) return;
    const peerConnection = mediaPeerConnections.current.get(endpointId);
    if (!peerConnection || !peerConnection.remoteDescription) {
      queueMediaIceCandidate(endpointId, candidate);
      return;
    }
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  async function flushQueuedMediaIceCandidates(endpointId, peerConnection) {
    const queued = pendingMediaIceCandidates.current.get(endpointId) || [];
    pendingMediaIceCandidates.current.delete(endpointId);
    for (const candidate of queued) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  function cleanupWebRtcMedia(message) {
    for (const peerConnection of mediaPeerConnections.current.values()) peerConnection.close();
    mediaPeerConnections.current.clear();
    mediaPeerChannels.current.clear();
    mediaPeerTrackMetadata.current.clear();
    publishedSubscriptionSignature.current = "";
    mediaRemoteStreams.current = {};
    mediaRemoteAudioStreams.current = {};
    localAudioSenders.current.clear();
    pendingMediaIceCandidates.current.clear();
    mediaStatsHistory.current.clear();
    stopMediaStatsPolling();
    setMediaVersion((value) => value + 1);
    setWebrtcMediaState({ state: "idle", label: "未建立" });
    if (!interactionAudioStream.current) {
      setAudioCall({ state: "idle", label: "未建立" });
    }
    if (message) setStatus(message);
  }

  function stopWebRtcMedia(message = "WebRTC 媒体链路已停止。") {
    const session = activeSessionRef.current;
    if (session?.source === "signaling") {
      const selfId = signalingEndpointIdRef.current;
      const targetEndpointIds =
        session.ownerEndpointId && session.ownerEndpointId !== selfId
          ? [session.ownerEndpointId]
          : activeRemoteEndpointIds();
      for (const endpointId of targetEndpointIds) {
        sendSignaling("peer.signal", {
          sessionId: session.id,
          toEndpointId: endpointId,
          signal: { kind: "media-stop" }
        });
      }
    }
    cleanupWebRtcMedia(message);
  }

  function requestMediaRefresh() {
    const session = activeSessionRef.current;
    const selfId = signalingEndpointIdRef.current;
    if (!session || session.source !== "signaling") {
      setStatus("请先建立信令会话，再请求媒体重发。");
      return;
    }
    if (localEndpointRole === "operating-room" || session.ownerEndpointId === selfId) {
      startSubscribedWebRtcMedia({ auto: true, refreshRequestFrom: selfId });
      return;
    }
    if (!session.ownerEndpointId) {
      setStatus("当前会话没有手术室 owner，无法请求媒体重发。");
      return;
    }
    sendSignaling("peer.signal", {
      sessionId: session.id,
      toEndpointId: session.ownerEndpointId,
      signal: {
        kind: "media-refresh-request",
        channelIds: normalizeChannelSelection(session.subscribedChannels || ["ch1"])
      }
    });
    setStatus("已请求手术室端重新发布订阅媒体。");
  }

  async function startWebRtcMedia(channelId = "ch1") {
    const session = activeSessionRef.current;
    if (!session || session.source !== "signaling") {
      setStatus("请先建立信令会话，再发布媒体。");
      return;
    }
    if (localEndpointRole !== "operating-room") {
      setStatus("当前 PoC 只允许手术室端发布媒体。");
      return;
    }
    const peers = activeRemoteEndpointIds();
    if (peers.length === 0) {
      setStatus("当前会话没有可发布媒体的远端参与方。");
      return;
    }

    const channel = CHANNELS.find((item) => item.id === channelId);
    if (!channel) {
      setStatus(`媒体通道不存在：${channelId}`);
      return;
    }

    try {
      cleanupWebRtcMedia();
      if (!previewStreams.current[channelId]) {
        await startPreview(channel);
      }
      const stream = previewStreams.current[channelId];
      if (!stream?.getVideoTracks().length) {
        throw new Error(`${channelLabelById(channelId)} 没有可发布的视频轨道`);
      }

      let audioAttached = false;
      const audioErrors = [];
      for (const endpointId of peers) {
        mediaPeerChannels.current.set(endpointId, channelId);
        const peerConnection = createMediaPeerConnection(endpointId);
        const trackMetadata = [];
        for (const track of stream.getTracks()) {
          peerConnection.addTrack(track, stream);
          trackMetadata.push({
            kind: track.kind,
            channelId,
            streamId: stream.id,
            trackId: track.id
          });
        }
        mediaPeerTrackMetadata.current.set(endpointId, trackMetadata);
        if (session.mode === "interactive") {
          try {
            audioAttached = (await addInteractionAudioToPeerConnection(peerConnection, endpointId)) || audioAttached;
          } catch (error) {
            audioErrors.push(error.message);
            setAudioCall({ state: "error", label: error.message });
          }
        }
        await renegotiatePeerConnection(endpointId, [channelId]);
      }

      setWebrtcMediaState({
        state: "publishing",
        label: `正在发布 ${channelLabelById(channelId)} 至 ${peers.length} 个远端`
      });
      setStatus(
        `${channelLabelById(channelId)} WebRTC 媒体发布已发起${
          audioAttached ? "，交互音频已随同发布" : ""
        }${audioErrors.length ? `；音频未加入：${Array.from(new Set(audioErrors)).join("；")}` : ""}。`
      );
    } catch (error) {
      cleanupWebRtcMedia();
      setWebrtcMediaState({ state: "error", label: error.message });
      setStatus(`WebRTC 媒体发布失败：${error.message}`);
    }
  }

  async function startSubscribedWebRtcMedia(options = {}) {
    const auto = Boolean(options.auto);
    const refreshRequestFrom = options.refreshRequestFrom || "";
    const session = activeSessionRef.current;
    if (!session || session.source !== "signaling") {
      setStatus("请先建立信令会话，再发布媒体。");
      return;
    }
    if (localEndpointRole !== "operating-room") {
      setStatus("当前 PoC 只允许手术室端发布媒体。");
      return;
    }
    const peers = activeRemoteEndpointIds();
    if (peers.length === 0) {
      setStatus("当前会话没有可发布媒体的远端参与方。");
      return;
    }

    try {
      cleanupWebRtcMedia();
      let audioAttached = false;
      const audioErrors = [];
      const publishedChannelIds = new Set();

      for (const endpointId of peers) {
        const endpointChannelIds = sessionChannelsForRemoteEndpoint(session, endpointId);
        mediaPeerChannels.current.set(endpointId, endpointChannelIds[0]);
        const peerConnection = createMediaPeerConnection(endpointId);
        const trackMetadata = [];

        for (const channelId of endpointChannelIds) {
          const channel = CHANNELS.find((item) => item.id === channelId);
          if (!channel) continue;
          if (!previewStreams.current[channelId]) {
            await startPreview(channel);
          }
          const stream = previewStreams.current[channelId];
          const videoTracks = stream?.getVideoTracks() || [];
          if (!videoTracks.length) {
            throw new Error(`${channelLabelById(channelId)} 没有可发布的视频轨道`);
          }
          for (const track of videoTracks) {
            peerConnection.addTrack(track, stream);
            trackMetadata.push({
              kind: track.kind,
              channelId,
              streamId: stream.id,
              trackId: track.id
            });
          }
          publishedChannelIds.add(channelId);
        }

        mediaPeerTrackMetadata.current.set(endpointId, trackMetadata);
        if (session.mode === "interactive") {
          try {
            audioAttached = (await addInteractionAudioToPeerConnection(peerConnection, endpointId)) || audioAttached;
          } catch (error) {
            audioErrors.push(error.message);
            setAudioCall({ state: "error", label: error.message });
          }
        }
        await renegotiatePeerConnection(endpointId, endpointChannelIds);
      }

      const publishedLabel = Array.from(publishedChannelIds).map(channelLabelById).join("、") || "通道 1";
      publishedSubscriptionSignature.current = publicationSignatureForSession(
        activeSessionRef.current,
        signalingEndpointIdRef.current,
        signalingDirectoryRef.current
      );
      setWebrtcMediaState({
        state: "publishing",
        label: `${
          refreshRequestFrom ? "已按媒体重发请求发布" : auto ? "已按会话变化重新发布" : "正在发布"
        } ${publishedLabel} 至 ${peers.length} 个远端`
      });
      setStatus(
        `${publishedLabel} WebRTC 媒体${
          refreshRequestFrom
            ? `已按 ${endpointLabelById(refreshRequestFrom)} 请求重新发布`
            : auto
              ? "已按会话变化重新发布"
              : "发布已发起"
        }${
          audioAttached ? "，交互音频已随同发布" : ""
        }${audioErrors.length ? `；音频未加入：${Array.from(new Set(audioErrors)).join("；")}` : ""}。`
      );
    } catch (error) {
      cleanupWebRtcMedia();
      setWebrtcMediaState({ state: "error", label: error.message });
      setStatus(`WebRTC 媒体发布失败：${error.message}`);
    }
  }

  async function handlePeerSignal(payload = {}) {
    try {
      const session = activeSessionRef.current;
      if (!session || session.source !== "signaling") return;
      if (payload.sessionId && payload.sessionId !== session.id) return;
      const fromEndpointId = payload.fromEndpointId;
      const signal = payload.signal || {};
      if (!fromEndpointId || !signal.kind) return;

      if (signal.kind === "media-refresh-request") {
        if (localEndpointRole !== "operating-room" || session.ownerEndpointId !== signalingEndpointIdRef.current) {
          setStatus(`${endpointLabelById(fromEndpointId)} 请求重新发布媒体，但本端不是手术室 owner。`);
          return;
        }
        if (autoRepublishInFlight.current) return;
        autoRepublishInFlight.current = true;
        setStatus(`${endpointLabelById(fromEndpointId)} 请求重新发布媒体，正在重新协商。`);
        startSubscribedWebRtcMedia({ auto: true, refreshRequestFrom: fromEndpointId }).finally(() => {
          autoRepublishInFlight.current = false;
        });
        return;
      }

      if (signal.kind === "media-offer") {
        const channelIds = normalizeChannelSelection(signal.channelIds || signal.channelId || "ch1");
        const channelId = channelIds[0];
        const trackMetadata = Array.isArray(signal.tracks)
          ? signal.tracks
              .filter((item) => item && item.kind === "video" && typeof item.channelId === "string")
              .map((item) => ({
                kind: item.kind,
                channelId: item.channelId,
                streamId: typeof item.streamId === "string" ? item.streamId : "",
                trackId: typeof item.trackId === "string" ? item.trackId : ""
              }))
          : [];
        mediaPeerChannels.current.set(fromEndpointId, channelId);
        closeMediaPeerConnection(fromEndpointId);
        mediaPeerChannels.current.set(fromEndpointId, channelId);
        mediaPeerTrackMetadata.current.set(fromEndpointId, trackMetadata);
        const peerConnection = createMediaPeerConnection(fromEndpointId);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.description));
        await flushQueuedMediaIceCandidates(fromEndpointId, peerConnection);
        if (session.mode === "interactive") {
          try {
            await addInteractionAudioToPeerConnection(peerConnection, fromEndpointId);
          } catch (error) {
            setAudioCall({ state: "error", label: error.message });
            setStatus(`本地麦克风未加入 WebRTC 音频：${error.message}`);
          }
        }
        const answer = await peerConnection.createAnswer();
        await setLowLatencyLocalDescription(peerConnection, answer);
        sendSignaling("peer.signal", {
          sessionId: session.id,
          toEndpointId: fromEndpointId,
          signal: {
            kind: "media-answer",
            channelId,
            channelIds,
            description: peerConnection.localDescription
          }
        });
        setWebrtcMediaState({
          state: "receiving",
          label: `正在接收 ${endpointLabelById(fromEndpointId)} 的 ${channelLabelById(channelId)}`
        });
        return;
      }

      if (signal.kind === "media-answer") {
        const peerConnection = mediaPeerConnections.current.get(fromEndpointId);
        if (!peerConnection) return;
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.description));
        await flushQueuedMediaIceCandidates(fromEndpointId, peerConnection);
        setWebrtcMediaState({
          state: "publishing",
          label: `媒体链路已协商：${endpointLabelById(fromEndpointId)}`
        });
        return;
      }

      if (signal.kind === "ice") {
        await addMediaIceCandidate(fromEndpointId, signal.candidate);
        return;
      }

      if (signal.kind === "media-stop") {
        const selfId = signalingEndpointIdRef.current;
        if (localEndpointRole === "operating-room" && session.ownerEndpointId === selfId) {
          cleanupWebRtcMediaForEndpoint(fromEndpointId, `${endpointLabelById(fromEndpointId)} 已停止媒体链路。`);
        } else {
          cleanupWebRtcMedia(`${endpointLabelById(fromEndpointId)} 已停止媒体链路。`);
        }
      }
    } catch (error) {
      setWebrtcMediaState({ state: "error", label: error.message });
      setStatus(`WebRTC 协商失败：${error.message}`);
    }
  }

  function handleSignalingMessage(message) {
    const { type, payload = {} } = message;
    if (type === "endpoint.registered") {
      setSignalingState({ connected: true, label: `已注册 ${payload.endpoint?.name || signalingEndpointIdRef.current}` });
      setStatus("信令服务器已连接，本端已注册。");
      sendSignaling("endpoint.list");
      sendSignaling("session.list");
      return;
    }

    if (type === "directory.updated" || type === "directory.snapshot") {
      setDirectoryFromSignaling(payload.endpoints);
      return;
    }

    if (type === "session.snapshot" || type === "sessions.updated") {
      setSessionsFromSignaling(payload.sessions);
      return;
    }

    if (type === "call.requested") {
      const call = payload.call;
      setPendingCall({
        id: call.callId,
        source: "signaling",
        direction: "signaling-outgoing",
        from: localEndpointName.trim() || signalingEndpointIdRef.current,
        to: endpointLabelById(call.toEndpointId),
        requestedMode: call.requestedMode,
        signalingCallId: call.callId
      });
      setOverLimitNotice("");
      setStatus(`信令呼叫已发出，呼叫 ID：${payload.call?.callId || "-"}`);
      return;
    }

    if (type === "call.incoming") {
      const call = payload.call;
      setPendingCall({
        id: call.callId,
        source: "signaling",
        direction: "signaling",
        from: endpointLabel(payload.from),
        to: localEndpointName.trim() || signalingEndpointIdRef.current,
        requestedMode: call.requestedMode,
        signalingCallId: call.callId
      });
      setOverLimitNotice("");
      setStatus(`${endpointLabel(payload.from)} 通过信令发起 ${modeLabel(call.requestedMode)} 呼叫。`);
      return;
    }

    if (type === "call.rejected") {
      setPendingCall(null);
      setOverLimitNotice("");
      setStatus("信令呼叫已被拒绝。");
      return;
    }

    if (type === "call.canceled") {
      setPendingCall(null);
      setOverLimitNotice("");
      setStatus(`信令呼叫已取消：${canceledReasonLabel(payload.reason)}。`);
      return;
    }

    if (type === "session.started") {
      applySignalingSession(payload.session, true, true);
      setStatus(`信令会话已建立，最终模式为 ${modeLabel(payload.session?.mode)}。`);
      return;
    }

    if (type === "session.resumed") {
      applySignalingSession(payload.session, true, true);
      setStatus(`信令会话已恢复，最终模式为 ${modeLabel(payload.session?.mode)}。`);
      return;
    }

    if (type === "session.joined") {
      applySignalingSession(payload.session, false, true);
      return;
    }

    if (type === "session.updated" || type === "session.subscribed" || type === "session.annotation.updated") {
      applySignalingSession(payload.session);
      return;
    }

    if (type === "peer.signal") {
      handlePeerSignal(payload);
      return;
    }

    if (type === "session.left") {
      clearLocalSession("已离开信令会话。");
      return;
    }

    if (type === "session.ended") {
      const action = payload.reason === "endpoint_disconnected" ? "断开" : "结束";
      clearLocalSession(`信令会话已由 ${endpointLabelById(payload.endedByEndpointId)} ${action}。`);
      return;
    }

    if (type === "endpoint.replaced") {
      signalingCloseMessageRef.current = `本端终端 ID ${payload.endpointId || signalingEndpointIdRef.current} 已被其他连接接管，信令连接已关闭。`;
      setStatus("本端终端 ID 已被其他连接接管，信令连接即将关闭。");
      return;
    }

    if (type === "error") {
      const messageText = signalingErrorLabel(payload);
      if (payload.code === "participant_limit") {
        setOverLimitNotice("信令服务器拒绝加入：已达到参与上限。");
        setStatus(`信令错误：${messageText}。`);
        return;
      }
      if (payload.code === "endpoint_busy") {
        setOverLimitNotice("信令服务器拒绝呼叫：本端或目标终端忙线。");
        setStatus(`信令错误：${messageText}。`);
        return;
      }
      if (payload.code === "unauthorized") {
        signalingCloseMessageRef.current = `信令错误：${messageText}。`;
        setSignalingState({ connected: false, label: "连接错误" });
        setStatus(`信令错误：${messageText}。`);
        signalingSocket.current?.close();
        return;
      }
      setStatus(`信令错误：${messageText}。`);
    }
  }

  function connectSignaling() {
    if (!window.WebSocket) {
      setStatus("当前环境不支持 WebSocket。");
      return;
    }
    signalingSocket.current?.close();
    const endpointId = localEndpointId.trim() || "or-local";
    const endpointName = localEndpointName.trim() || endpointId;
    const endpointToken = signalingToken.trim();
    signalingEndpointIdRef.current = endpointId;
    signalingCloseMessageRef.current = "";
    setSignalingState({ connected: false, label: "连接中" });
    setStatus("正在连接信令服务器...");

    const nextUrl = signalingUrl.trim() || defaultSignalingUrlForPage();
    if (!isValidWebSocketUrl(nextUrl)) {
      setSignalingState({ connected: false, label: "连接错误" });
      setStatus("信令地址无效：必须使用 ws:// 或 wss:// 地址。");
      return;
    }

    let ws;
    try {
      ws = new WebSocket(nextUrl);
    } catch (error) {
      setSignalingState({ connected: false, label: "连接错误" });
      setStatus(`信令地址无效：${error.message}`);
      return;
    }
    signalingSocket.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "endpoint.register",
          requestId: `register-${Date.now()}`,
          payload: {
            endpointId,
            authToken: endpointToken || undefined,
            role: localEndpointRole,
            name: endpointName,
            address: "127.0.0.1",
            capabilities: capabilitiesForRole(localEndpointRole),
            channels:
              localEndpointRole === "operating-room"
                ? CHANNELS.map((channel) => ({
                    id: channel.id,
                    label: channel.label,
                    role: channel.role
                  }))
                : []
          }
        })
      );
    };
    ws.onmessage = (event) => {
      try {
        handleSignalingMessage(JSON.parse(event.data));
      } catch (error) {
        setStatus(`信令消息解析失败：${error.message}`);
      }
    };
    ws.onerror = () => {
      setSignalingState({ connected: false, label: "连接错误" });
      setStatus("信令服务器连接错误。");
    };
    ws.onclose = () => {
      if (signalingSocket.current === ws) {
        const closeMessage = signalingCloseMessageRef.current || "信令连接已断开，已清理信令会话状态。";
        const sessionWasSignaling = activeSessionRef.current?.source === "signaling";
        signalingCloseMessageRef.current = "";
        signalingSocket.current = null;
        setPendingCall(null);
        activeSessionRef.current = null;
        if (sessionWasSignaling) {
          stopInteractionAudio();
          cleanupWebRtcMedia();
        }
        setActiveSession((session) => (session?.source === "signaling" ? null : session));
        setOverLimitNotice("");
        setSignalingDirectory([]);
        setSignalingSessions([]);
        setSignalingTargetId("");
        setSignalingHealth("-");
        setSignalingEvents([]);
        setSignalingEventsStatus("-");
        setSignalingState({ connected: false, label: "未连接" });
        setStatus(closeMessage);
      }
    };
  }

  function disconnectSignaling() {
    const sessionWasSignaling = activeSessionRef.current?.source === "signaling";
    signalingSocket.current?.close();
    signalingSocket.current = null;
    signalingCloseMessageRef.current = "";
    setPendingCall(null);
    activeSessionRef.current = null;
    if (sessionWasSignaling) {
      stopInteractionAudio();
      cleanupWebRtcMedia();
    }
    setActiveSession((session) => (session?.source === "signaling" ? null : session));
    setOverLimitNotice("");
    setSignalingDirectory([]);
    setSignalingSessions([]);
    setSignalingTargetId("");
    setSignalingHealth("-");
    setSignalingEvents([]);
    setSignalingEventsStatus("-");
    setSignalingState({ connected: false, label: "未连接" });
    setStatus("信令连接已断开，已清理信令会话状态。");
  }

  function requestSignalingCall() {
    const target = signalingDirectory.find((item) => item.endpointId === signalingTargetId);
    if (!target) {
      setStatus("请先选择在线信令目标。");
      return;
    }
    if (sendSignaling("call.request", { toEndpointId: target.endpointId, mode: requestMode, participantLimit })) {
      setStatus(`已通过信令向 ${endpointLabel(target)} 发起 ${modeLabel(requestMode)} 呼叫。`);
    }
  }

  async function checkSignalingHealth() {
      const nextUrl = signalingUrl.trim() || defaultSignalingUrlForPage();
    if (!isValidWebSocketUrl(nextUrl)) {
      setSignalingHealth("地址无效");
      setStatus("信令地址无效：必须使用 ws:// 或 wss:// 地址。");
      return;
    }
    try {
      const response = await fetch(healthUrlFromSignalingUrl(nextUrl), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      const summary = `${health.endpoints} 终端 / ${health.sessions} 会话 / ${health.pendingCalls} 呼叫`;
      const details = [];
      if (Number.isFinite(health.uptimeSeconds)) details.push(`运行 ${Math.floor(health.uptimeSeconds)} 秒`);
      if (Number.isFinite(health.eventLogSize) && Number.isFinite(health.eventLogLimit)) {
        details.push(`事件 ${health.eventLogSize}/${health.eventLogLimit}`);
      }
      setSignalingHealth(details.length ? `${summary} / ${details.join(" / ")}` : summary);
      setStatus("信令健康检查正常。");
    } catch (error) {
      setSignalingHealth("检查失败");
      setStatus(`信令健康检查失败：${error.message}`);
    }
  }

  async function refreshSignalingEvents() {
    const nextUrl = signalingUrl.trim() || defaultSignalingUrlForPage();
    if (!isValidWebSocketUrl(nextUrl)) {
      setSignalingEventsStatus("地址无效");
      setStatus("信令地址无效：必须使用 ws:// 或 wss:// 地址。");
      return;
    }
    try {
      const headers = signalingToken.trim() ? { Authorization: `Bearer ${signalingToken.trim()}` } : {};
      const response = await fetch(eventsUrlFromSignalingUrl(nextUrl), { cache: "no-store", headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const events = await response.json();
      if (!Array.isArray(events)) throw new Error("事件日志格式无效");
      const visibleEvents = events.slice(-10).reverse();
      setSignalingEvents(visibleEvents);
      setSignalingEventsStatus(`${events.length} 条，显示 ${visibleEvents.length} 条`);
      setStatus(`已读取 ${events.length} 条信令事件。`);
    } catch (error) {
      setSignalingEventsStatus("读取失败");
      setStatus(`信令事件读取失败：${error.message}`);
    }
  }

  function joinSignalingSession() {
    const sessionId = joinSessionId.trim();
    if (!sessionId) {
      setStatus("请输入要加入的信令会话 ID。");
      return;
    }
    if (sendSignaling("session.join", { sessionId })) {
      setStatus(`已请求加入信令会话：${sessionId}。`);
    }
  }

  function refreshSignalingSessions() {
    if (sendSignaling("session.list")) {
      setStatus("已请求刷新信令会话目录。");
    }
  }

  function syncSignalingAnnotation(text, visible) {
    if (localEndpointRole !== "operating-room") return;
    if (activeSession?.source !== "signaling") return;
    sendSignaling("session.annotation", {
      sessionId: activeSession.id,
      text,
      visible
    });
  }

  function updateAnnotationText(value) {
    setAnnotationText(value);
    if (annotationVisible) syncSignalingAnnotation(value, annotationVisible);
  }

  function updateAnnotationVisible(checked) {
    setAnnotationVisible(checked);
    syncSignalingAnnotation(annotationText, checked);
  }

  async function openRemotePopout(channelId) {
    if (!activeSession) return;
    const channel = CHANNELS.find((item) => item.id === channelId);
    if (!channel) return;
    if (!remoteStreamForChannel(channelId)) {
      await startPreview(channel);
    }
    const stream = remoteStreamForChannel(channelId);
    const targetDisplay = displayTargets.find((display) => String(display.id) === selectedDisplayId);
    const targetArea = targetDisplay?.workArea || targetDisplay?.bounds;
    const width = targetArea?.width ? Math.max(640, Math.min(1280, Math.trunc(targetArea.width))) : 960;
    const height = targetArea?.height ? Math.max(420, Math.min(800, Math.trunc(targetArea.height))) : 620;
    const position =
      targetArea && Number.isFinite(targetArea.x) && Number.isFinite(targetArea.y)
        ? `,left=${Math.trunc(targetArea.x)},top=${Math.trunc(targetArea.y)}`
        : "";
    const popup = window.open("", "_blank", `popup,width=${width},height=${height}${position}`);
    if (!popup) {
      setStatus("扩展窗口打开失败，可能被浏览器拦截。");
      return;
    }

    const doc = popup.document;
    doc.title = `${channel.label} ${channel.role}`;
    doc.body.style.margin = "0";
    doc.body.style.background = "#101820";
    doc.body.style.color = "#ffffff";
    doc.body.style.fontFamily = "Microsoft YaHei, Segoe UI, Arial, sans-serif";

    const wrapper = doc.createElement("main");
    wrapper.style.display = "grid";
    wrapper.style.gridTemplateRows = "auto 1fr";
    wrapper.style.minHeight = "100vh";

    const title = doc.createElement("h1");
    title.textContent = `${channel.label} ${channel.role}`;
    title.style.margin = "0";
    title.style.padding = "12px 16px";
    title.style.fontSize = "18px";
    title.style.background = "#17202a";

    const video = doc.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.controls = true;
    video.srcObject = stream;
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "contain";
    video.style.background = "#000000";

    wrapper.append(title, video);
    doc.body.replaceChildren(wrapper);
    video.play().catch(() => {});
    setStatus(
      targetDisplay
        ? `${channel.label} 已打开扩展窗口，目标：${displayLabel(targetDisplay)}。`
        : `${channel.label} 已打开扩展窗口，可拖动到其他显示器。`
    );
  }

  function requestCall(direction) {
    const target = selectedTarget();
    const address = customAddress.trim() || target.address;
    const call =
      direction === "or-to-teaching"
        ? {
            id: Date.now(),
            direction,
            from: "手术室端",
            to: `${target.name} (${address})`,
            requestedMode: requestMode
          }
        : {
            id: Date.now(),
            direction,
            from: `${target.name} (${address})`,
            to: "手术室端",
            requestedMode: requestMode
          };
    setPendingCall(call);
    setStatus(`${call.from} 已向 ${call.to} 发起 ${modeLabel(call.requestedMode)} 呼叫。`);
  }

  function acceptCall() {
    if (!pendingCall) return;
    if (pendingCall.direction === "signaling-outgoing") return;
    if (pendingCall.source === "signaling") {
      if (
        sendSignaling("call.accept", {
          callId: pendingCall.signalingCallId,
          mode: confirmMode,
          participantLimit
        })
      ) {
        setStatus("已通过信令发送接受确认，等待会话建立。");
      }
      return;
    }
    const finalMode = resolveMode(pendingCall.requestedMode, confirmMode);
    const participants = ["手术室端", pendingCall.direction === "or-to-teaching" ? pendingCall.to : pendingCall.from];
    setActiveSession({
      id: Date.now(),
      source: "local",
      startedAt: new Date().toISOString(),
      mode: finalMode,
      participants,
      participantLimit,
      subscribedChannels: ["ch1"]
    });
    setLayoutMode("single");
    setPendingCall(null);
    setOverLimitNotice("");
    setStatus(`互动连接已建立，最终模式为 ${modeLabel(finalMode)}，默认拉取通道 1。`);
  }

  function rejectCall() {
    if (!pendingCall) return;
    if (pendingCall.direction === "signaling-outgoing") {
      sendSignaling("call.cancel", { callId: pendingCall.signalingCallId });
      setPendingCall(null);
      setStatus("已通过信令取消呼叫。");
      return;
    }
    if (pendingCall.source === "signaling") {
      sendSignaling("call.reject", { callId: pendingCall.signalingCallId });
      setPendingCall(null);
      setStatus("已通过信令拒绝呼叫。");
      return;
    }
    setStatus(`${pendingCall.to} 已拒绝呼叫。`);
    setPendingCall(null);
  }

  function clearLocalSession(message = "互动连接已结束。") {
    stopInteractionAudio();
    cleanupWebRtcMedia();
    activeSessionRef.current = null;
    setActiveSession(null);
    setAnnotationVisible(false);
    setOverLimitNotice("");
    setStatus(message);
  }

  function closeSession() {
    if (activeSession?.source === "signaling") {
      if (sendSignaling("session.end", { sessionId: activeSession.id })) {
        setStatus("已发送信令会话结束请求。");
      }
      return;
    }
    clearLocalSession();
  }

  function leaveSession() {
    if (activeSession?.source === "signaling") {
      if (sendSignaling("session.leave", { sessionId: activeSession.id })) {
        setStatus("已发送离开信令会话请求。");
      }
      return;
    }
    clearLocalSession("已离开互动连接。");
  }

  async function toggleRemoteChannel(channelId, checked) {
    if (!activeSession) return;
    let nextChannels;
    if (checked) {
      const channel = CHANNELS.find((item) => item.id === channelId);
      if (channel && !previewStreams.current[channelId]) {
        await startPreview(channel);
      }
      nextChannels = Array.from(new Set([...activeSession.subscribedChannels, channelId]));
      setActiveSession((session) => ({
        ...session,
        subscribedChannels: nextChannels
      }));
    } else {
      const remaining = activeSession.subscribedChannels.filter((id) => id !== channelId);
      nextChannels = remaining.length > 0 ? remaining : ["ch1"];
      setActiveSession((session) => ({
        ...session,
        subscribedChannels: nextChannels
      }));
    }
    if (activeSession.source === "signaling") {
      sendSignaling("session.subscribe", { sessionId: activeSession.id, channels: nextChannels });
    }
  }

  async function startInteractionAudio() {
    if (!activeSession || activeSession.mode !== "interactive") {
      setStatus("当前不是交互模式，不能建立双向音频。");
      return;
    }
    try {
      const stream = await ensureInteractionAudioStream();
      const renegotiatedPeers = [];
      if (activeSession.source === "signaling") {
        for (const endpointId of activeRemoteEndpointIds()) {
          const peerConnection = mediaPeerConnections.current.get(endpointId);
          if (!peerConnection) continue;
          await addInteractionAudioToPeerConnection(peerConnection, endpointId);
          const videoChannelIds = (mediaPeerTrackMetadata.current.get(endpointId) || [])
            .filter((item) => item.kind === "video")
            .map((item) => item.channelId);
          await renegotiatePeerConnection(
            endpointId,
            videoChannelIds.length ? videoChannelIds : mediaPeerChannels.current.get(endpointId) || "ch1"
          );
          renegotiatedPeers.push(endpointId);
        }
      }
      setAudioCall({
        state: "connected",
        label: `已建立，低延迟本地音频轨道 ${stream.getAudioTracks().length} 路${
          renegotiatedPeers.length ? "，已加入 WebRTC" : ""
        }`
      });
      setStatus(
        renegotiatedPeers.length
          ? `交互音频已按低延迟模式加入 ${renegotiatedPeers.length} 条 WebRTC 媒体链路。`
          : "交互音频已建立，已启用低延迟采集、回声消除、噪声抑制和自动增益约束；当前尚无 WebRTC 媒体链路。"
      );
    } catch (error) {
      setAudioCall({ state: "error", label: error.message });
      setStatus(`交互音频建立失败：${error.message}`);
    }
  }

  function stopInteractionAudio() {
    for (const [endpointId, senders] of localAudioSenders.current.entries()) {
      const peerConnection = mediaPeerConnections.current.get(endpointId);
      if (!peerConnection) continue;
      for (const sender of senders) {
        try {
          peerConnection.removeTrack(sender);
        } catch {
          // Ignore already-removed senders during cleanup.
        }
      }
    }
    localAudioSenders.current.clear();
    stopStream(interactionAudioStream.current);
    interactionAudioStream.current = null;
    setAudioCall({ state: "idle", label: "未建立" });
  }

  function simulateParticipantJoin() {
    if (!activeSession) return;
    if (activeSession.participants.length >= activeSession.participantLimit) {
      const message = `已达到手术室端设置的 ${activeSession.participantLimit} 人上限，新用户被拒绝。`;
      setOverLimitNotice(message);
      setStatus(message);
      return;
    }
    const nextName = `观摩端 ${activeSession.participants.length}`;
    setActiveSession((session) => ({
      ...session,
      participants: [...session.participants, nextName]
    }));
    setStatus(`${nextName} 已加入会议。`);
  }

  function updateParticipantLimit(value) {
    const next = Math.max(2, Math.min(16, Number(value) || 2));
    setParticipantLimit(next);
    setActiveSession((session) => (session ? { ...session, participantLimit: next } : session));
  }

  function displayedRemoteChannels() {
    if (!activeSession) return [];
    const subscribed = activeSession.subscribedChannels;
    if (layoutMode === "single") return subscribed.slice(0, 1);
    if (layoutMode === "dual") return subscribed.slice(0, 2);
    return subscribed.slice(0, 4);
  }

  const anyRecording = CHANNELS.some((channel) => activeRecorders.current[channel.id]);
  const remoteChannels = displayedRemoteChannels();
  const remoteMediaDiagnostics = activeSession?.subscribedChannels.map((channelId) => ({
    channelId,
    ...remoteMediaHealth(channelId)
  })) || [];
  const normalizedRecordingFilter = recordingFilter.trim().toLowerCase();
  const visibleRecordings = normalizedRecordingFilter
    ? recordings.filter((recording) => recordingFilterText(recording).includes(normalizedRecordingFilter))
    : recordings;
  const peerConnectionDiagnostics = Array.from(mediaPeerConnections.current.entries())
    .filter(([, peerConnection]) => peerConnection.connectionState !== "closed")
    .map(([endpointId, peerConnection]) => peerConnectionHealth(endpointId, peerConnection));
  const remoteEndpointIds = activeSession?.participantIds?.filter((id) => id !== signalingEndpointIdRef.current) || [];
  const signalingTargets = signalingDirectory.filter((endpoint) => endpoint.endpointId !== signalingEndpointIdRef.current);
  const joinableSignalingSessions = signalingSessions.filter(
    (session) => !session.participants?.includes(signalingEndpointIdRef.current)
  );
  const canEndActiveSession =
    Boolean(activeSession) &&
    (activeSession.source !== "signaling" ||
      activeSession.participants.length <= 2 ||
      activeSession.ownerEndpointId === signalingEndpointIdRef.current);
  const selectedSignalingTarget = signalingTargets.find((endpoint) => endpoint.endpointId === signalingTargetId);
  const selectedTargetChannels =
    selectedSignalingTarget?.channels?.map((channel) => `${channel.id} ${channel.label}`).join("、") || "-";
  const audioDiagnostics = [
    navigator.mediaDevices?.getUserMedia ? "支持采集" : "不支持采集",
    window.isSecureContext ? "安全上下文" : "非安全上下文",
    `输入 ${audioDevices.length}`,
    `输出 ${audioOutputDevices.length}`,
    typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function"
      ? "可选输出"
      : "系统默认输出",
    audioDeviceId ? `麦克风 ${audioInputLabel(audioDeviceId)}` : "未选麦克风",
    audioOutputDeviceId ? `回放 ${audioOutputLabel(audioOutputDeviceId)}` : "系统回放"
  ].join(" / ");

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>手术示教 Phase 3 PoC</h1>
          <p>4 路采集录制和信令控制已通过，当前验证按订阅多通道 WebRTC 远端视频链路。</p>
        </div>
        <div className="top-actions">
          <button onClick={requestDevicePermissionAndRefresh}>授权并刷新设备</button>
          <button onClick={startAllPreviews}>启动全部预览</button>
          <button onClick={startSelectedRecording} disabled={anyRecording}>
            开始选中通道录制
          </button>
          <button className="danger" onClick={stopAllRecording} disabled={!anyRecording}>
            停止录制
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="video-grid">
          {CHANNELS.map((channel) => (
            <article className="channel-card" key={channel.id}>
              <div className="channel-head">
                <div>
                  <h2>{channel.label}</h2>
                  <span>{channel.role}</span>
                </div>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={channelConfig[channel.id].selectedForRecording}
                    onChange={(event) =>
                      updateChannel(channel.id, { selectedForRecording: event.target.checked })
                    }
                  />
                  录制
                </label>
              </div>
              <div className="preview-frame">
                <video
                  ref={(node) => {
                    videoRefs.current[channel.id] = node;
                  }}
                  muted
                  playsInline
                />
                {activeRecorders.current[channel.id] && <div className="recording-badge">REC</div>}
              </div>
              <div className="channel-controls">
                <select
                  value={channelConfig[channel.id].sourceMode}
                  onChange={(event) => updateChannel(channel.id, { sourceMode: event.target.value })}
                >
                  <option value="mock">模拟源</option>
                  <option value="device">USB/摄像头设备</option>
                </select>
                <select
                  value={channelConfig[channel.id].deviceId}
                  disabled={channelConfig[channel.id].sourceMode !== "device"}
                  onChange={(event) => updateChannel(channel.id, { deviceId: event.target.value })}
                >
                  <option value="">选择视频设备</option>
                  {videoDevices.map((device, index) => (
                    <option value={device.deviceId} key={device.deviceId}>
                      {device.label || `视频输入 ${index + 1}`}
                    </option>
                  ))}
                </select>
                <button onClick={() => startPreview(channel)}>预览</button>
                <button onClick={() => stopPreview(channel)}>停止</button>
                {activeRecorders.current[channel.id] ? (
                  <button className="danger" onClick={() => stopRecording(channel)}>
                    停止录制
                  </button>
                ) : (
                  <button onClick={() => startRecording(channel)}>录制本通道</button>
                )}
              </div>
              <div className="ptz-controls" aria-label={`${channel.label} 云台镜头控制`}>
                <button aria-label={`${channel.label} 云台左`} onClick={() => adjustCameraControl(channel, "pan", -1)}>
                  ←
                </button>
                <button aria-label={`${channel.label} 云台上`} onClick={() => adjustCameraControl(channel, "tilt", 1)}>
                  ↑
                </button>
                <button aria-label={`${channel.label} 云台下`} onClick={() => adjustCameraControl(channel, "tilt", -1)}>
                  ↓
                </button>
                <button aria-label={`${channel.label} 云台右`} onClick={() => adjustCameraControl(channel, "pan", 1)}>
                  →
                </button>
                <button aria-label={`${channel.label} 镜头缩小`} onClick={() => adjustCameraControl(channel, "zoom", -1)}>
                  −
                </button>
                <button aria-label={`${channel.label} 镜头放大`} onClick={() => adjustCameraControl(channel, "zoom", 1)}>
                  +
                </button>
              </div>
            </article>
          ))}
        </section>

        <aside className="side-panel">
          <section className="panel-block">
            <h2>音频</h2>
            <label className="checkline">
              <input
                type="checkbox"
                checked={includeAudio}
                onChange={(event) => setIncludeAudio(event.target.checked)}
              />
              录制时包含音频
            </label>
            <label className="annotation-input">
              音频输入设备
              <select value={audioDeviceId} onChange={(event) => setAudioDeviceId(event.target.value)}>
                <option value="">不选择音频输入</option>
                {audioDevices.map((device, index) => (
                  <option value={device.deviceId} key={device.deviceId}>
                    {device.label || `音频输入 ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="annotation-input">
              音频输出设备
              <select value={audioOutputDeviceId} onChange={(event) => handleAudioOutputChange(event.target.value)}>
                <option value="">系统默认音频输出</option>
                {audioOutputDevices.map((device, index) => (
                  <option value={device.deviceId} key={device.deviceId}>
                    {device.label || `音频输出 ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">当前阶段已接入按订阅多通道 WebRTC 视频 PoC；交互模式下音频通话会进入同一 WebRTC 媒体链路。</p>
          </section>

          <section className="panel-block">
            <h2>状态</h2>
            <dl className="status-list">
              <div>
                <dt>设备授权</dt>
                <dd>{isPermissionReady ? "已请求" : "未请求"}</dd>
              </div>
              <div>
                <dt>录制格式</dt>
                <dd>{supportedMimeType || "不支持"}</dd>
              </div>
              <div>
                <dt>交互音频</dt>
                <dd>{audioCall.label}</dd>
              </div>
              <div>
                <dt>音频诊断</dt>
                <dd>{audioDiagnostics}</dd>
              </div>
              <div>
                <dt>媒体链路</dt>
                <dd>{webrtcMediaState.label}</dd>
              </div>
              <div>
                <dt>媒体统计</dt>
                <dd>{webrtcStatsLabel}</dd>
              </div>
              <div>
                <dt>ICE 服务</dt>
                <dd>{webrtcIceServers.length ? `${webrtcIceServers.length} 组` : "未配置"}</dd>
              </div>
              <div>
                <dt>存储目录</dt>
                <dd>{appInfo?.recordingsDir || "-"}</dd>
              </div>
            </dl>
            <button onClick={openRecordingRoot}>打开录像目录</button>
          </section>

          <section className="panel-block">
            <h2>患者绑定</h2>
            <label className="annotation-input">
              HIS ID
              <input value={patientQuery} onChange={(event) => setPatientQuery(event.target.value)} />
            </label>
            <div className="button-row">
              <button onClick={queryMockPatient}>模拟 HIS 查询</button>
              <button onClick={clearPatientBinding} disabled={!currentPatient}>
                清除绑定
              </button>
            </div>
            <p className="hint">{patientStatus}</p>
            {currentPatient && (
              <dl className="status-list compact">
                <div>
                  <dt>术式</dt>
                  <dd>{currentPatient.surgery}</dd>
                </div>
                <div>
                  <dt>基本信息</dt>
                  <dd>
                    {currentPatient.sex} / {currentPatient.age} 岁
                  </dd>
                </div>
              </dl>
            )}
          </section>

          <section className="panel-block grow">
            <div className="section-title-row">
              <h2>录像索引</h2>
              <button onClick={refreshRecordings}>刷新</button>
            </div>
            <label className="annotation-input">
              录像搜索
              <input
                value={recordingFilter}
                onChange={(event) => setRecordingFilter(event.target.value)}
                placeholder="文件、通道、患者、HIS ID"
              />
            </label>
            <div className="recording-list">
              {recordings.length === 0 && <p className="hint">暂无录像。完成录制后会自动生成索引。</p>}
              {recordings.length > 0 && visibleRecordings.length === 0 && <p className="hint">没有匹配的录像。</p>}
              {visibleRecordings.map((item) => (
                <div
                  className={`recording-item ${selectedPlayback?.id === item.id ? "active" : ""}`}
                  key={item.id}
                >
                  <button className="recording-main" onClick={() => setSelectedPlayback(item)}>
                    <strong>{item.channelLabel}</strong>
                    <span>{new Date(item.startedAt).toLocaleString()}</span>
                    <span>
                      {formatDuration(item.durationMs)} / {formatBytes(item.bytes)}
                    </span>
                    {item.patient && (
                      <span>
                        患者：{item.patient.name} / {item.patient.hisId}
                      </span>
                    )}
                  </button>
                  <div className="recording-actions">
                    <button onClick={() => revealRecording(item)}>定位</button>
                    <button onClick={() => exportRecording(item)}>导出</button>
                    <button onClick={() => uploadRecordingToFtp(item)}>上传FTP</button>
                    <button className="danger" onClick={() => deleteRecording(item)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>

      <section className="interaction-workbench">
        <div className="interaction-left">
          <section className="panel-block">
            <h2>信令控制面</h2>
            <div className="form-grid signal-grid">
              <label>
                信令地址
                <input
                  value={signalingUrl}
                  onChange={(event) => setSignalingUrl(event.target.value)}
                  disabled={signalingState.connected}
                />
              </label>
              <label>
                信令令牌
                <input
                  type="password"
                  value={signalingToken}
                  onChange={(event) => setSignalingToken(event.target.value)}
                  disabled={signalingState.connected}
                />
              </label>
              <label>
                本端 ID
                <input
                  value={localEndpointId}
                  onChange={(event) => setLocalEndpointId(event.target.value)}
                  disabled={signalingState.connected}
                />
              </label>
              <label>
                本端名称
                <input
                  value={localEndpointName}
                  onChange={(event) => setLocalEndpointName(event.target.value)}
                  disabled={signalingState.connected}
                />
              </label>
              <label>
                本端角色
                <select
                  value={localEndpointRole}
                  onChange={(event) => setLocalEndpointRole(event.target.value)}
                  disabled={signalingState.connected}
                >
                  <option value="operating-room">手术室端</option>
                  <option value="teaching-room">示教室端</option>
                  <option value="observer">观摩端</option>
                </select>
              </label>
              <label>
                信令目标
                <select
                  value={signalingTargetId}
                  disabled={signalingTargets.length === 0}
                  onChange={(event) => setSignalingTargetId(event.target.value)}
                >
                  <option value="">选择在线终端</option>
                  {signalingTargets.map((endpoint) => (
                    <option value={endpoint.endpointId} key={endpoint.endpointId}>
                      {endpointLabel(endpoint)} / {endpoint.role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                加入会话 ID
                <input value={joinSessionId} onChange={(event) => setJoinSessionId(event.target.value)} />
              </label>
              <label>
                会话目录
                <select
                  value={
                    joinableSignalingSessions.some((session) => session.sessionId === joinSessionId.trim())
                      ? joinSessionId.trim()
                      : ""
                  }
                  disabled={joinableSignalingSessions.length === 0}
                  onChange={(event) => setJoinSessionId(event.target.value)}
                >
                  <option value="">选择可加入会话</option>
                  {joinableSignalingSessions.map((session) => (
                    <option value={session.sessionId} key={session.sessionId}>
                      {sessionDirectoryLabel(session)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <dl className="status-list compact">
              <div>
                <dt>连接状态</dt>
                <dd>{signalingState.label}</dd>
              </div>
              <div>
                <dt>在线目录</dt>
                <dd>{signalingDirectory.length} 个终端</dd>
              </div>
              <div>
                <dt>会话目录</dt>
                <dd>{signalingSessions.length} 个会话</dd>
              </div>
              <div>
                <dt>健康检查</dt>
                <dd>{signalingHealth}</dd>
              </div>
              <div>
                <dt>事件日志</dt>
                <dd>{signalingEventsStatus}</dd>
              </div>
              <div>
                <dt>目标通道</dt>
                <dd>{selectedTargetChannels}</dd>
              </div>
            </dl>
            <div className="button-row">
              <button onClick={connectSignaling} disabled={signalingState.connected}>
                连接信令
              </button>
              <button onClick={disconnectSignaling} disabled={!signalingState.connected}>
                断开
              </button>
              <button onClick={checkSignalingHealth}>检查健康</button>
              <button onClick={refreshSignalingEvents}>刷新事件</button>
              <button onClick={refreshSignalingSessions} disabled={!signalingState.connected}>
                刷新会话
              </button>
              <button
                onClick={requestSignalingCall}
                disabled={!signalingState.connected || !signalingTargetId || Boolean(activeSession || pendingCall)}
              >
                信令呼叫选中终端
              </button>
              <button
                onClick={joinSignalingSession}
                disabled={!signalingState.connected || !joinSessionId.trim() || Boolean(activeSession || pendingCall)}
              >
                加入信令会话
              </button>
            </div>
            <div className="signal-events">
              {signalingEvents.length === 0 ? (
                <p className="hint">暂无信令事件。</p>
              ) : (
                signalingEvents.map((event) => {
                  const details = signalingEventDetails(event);
                  return (
                    <div className="signal-event" key={event.eventId || `${event.type}-${event.at}`}>
                      <span>{event.at ? new Date(event.at).toLocaleTimeString() : "-"}</span>
                      <div>
                        <strong>{signalingEventLabel(event)}</strong>
                        {details ? <small>{details}</small> : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <p className="hint">该面板负责 C/S 控制面；真实媒体当前验证通道 1 至通道 4 的浏览器 WebRTC P2P 按订阅链路。</p>
          </section>

          <section className="panel-block">
            <h2>阶段 2 呼叫控制</h2>
            <div className="form-grid">
              <label>
                通讯录
                <select value={callTargetId} onChange={(event) => setCallTargetId(event.target.value)}>
                  {ADDRESS_BOOK.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name} / {item.address} / {item.type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                IP 地址覆盖
                <input
                  value={customAddress}
                  onChange={(event) => setCustomAddress(event.target.value)}
                  placeholder="留空则使用通讯录地址"
                />
              </label>
              <label>
                发起模式
                <select value={requestMode} onChange={(event) => setRequestMode(event.target.value)}>
                  <option value="interactive">交互模式</option>
                  <option value="view">仅收看</option>
                </select>
              </label>
              <label>
                接受确认
                <select value={confirmMode} onChange={(event) => setConfirmMode(event.target.value)}>
                  <option value="interactive">确认交互</option>
                  <option value="view">确认仅收看</option>
                </select>
              </label>
              <label>
                手术室参与上限
                <input
                  type="number"
                  min="2"
                  max="16"
                  value={participantLimit}
                  onChange={(event) => updateParticipantLimit(event.target.value)}
                />
              </label>
            </div>
            <div className="button-row">
              <button onClick={() => requestCall("teaching-to-or")} disabled={Boolean(activeSession || pendingCall)}>
                示教室呼叫手术室
              </button>
              <button onClick={() => requestCall("or-to-teaching")} disabled={Boolean(activeSession || pendingCall)}>
                手术室呼叫示教室
              </button>
              <button onClick={acceptCall} disabled={!pendingCall || pendingCall.direction === "signaling-outgoing"}>
                接受呼叫
              </button>
              <button className="danger" onClick={rejectCall} disabled={!pendingCall}>
                {pendingCall?.direction === "signaling-outgoing" ? "取消呼叫" : "拒绝"}
              </button>
              <button onClick={leaveSession} disabled={!activeSession}>
                离开会话
              </button>
              <button className="danger" onClick={closeSession} disabled={!canEndActiveSession}>
                结束连接
              </button>
            </div>
            {pendingCall && (
              <div className="call-banner">
                <strong>待确认呼叫</strong>
                <span>
                  {pendingCall.from} → {pendingCall.to}，请求 {modeLabel(pendingCall.requestedMode)}
                </span>
              </div>
            )}
          </section>

          <section className="panel-block">
            <h2>会话状态</h2>
            {activeSession ? (
              <dl className="session-list">
                <div>
                  <dt>会话 ID</dt>
                  <dd>{activeSession.id}</dd>
                </div>
                <div>
                  <dt>最终模式</dt>
                  <dd>{modeLabel(activeSession.mode)}</dd>
                </div>
                <div>
                  <dt>默认画面</dt>
                  <dd>通道 1</dd>
                </div>
                <div>
                  <dt>参与数量</dt>
                  <dd>
                    {activeSession.participants.length} / {activeSession.participantLimit}
                  </dd>
                </div>
                <div>
                  <dt>参与方</dt>
                  <dd>{activeSession.participants.join("、")}</dd>
                </div>
              </dl>
            ) : (
              <p className="hint">尚未建立互动连接。先发起呼叫，再由接收方确认模式。</p>
            )}
            <div className="button-row">
              <button onClick={simulateParticipantJoin} disabled={!activeSession}>
                模拟新增参会者
              </button>
              <button onClick={startInteractionAudio} disabled={!activeSession || activeSession.mode !== "interactive"}>
                建立音频通话
              </button>
              <button onClick={stopInteractionAudio} disabled={audioCall.state !== "connected"}>
                停止音频
              </button>
              <button
                onClick={() => startSubscribedWebRtcMedia()}
                disabled={!activeSession || activeSession.source !== "signaling" || localEndpointRole !== "operating-room"}
              >
                发布订阅通道媒体
              </button>
              <button
                onClick={() => stopWebRtcMedia()}
                disabled={webrtcMediaState.state === "idle"}
              >
                停止媒体链路
              </button>
              <button
                onClick={requestMediaRefresh}
                disabled={!activeSession || activeSession.source !== "signaling" || localEndpointRole === "operating-room"}
              >
                请求重发媒体
              </button>
            </div>
            {overLimitNotice && <p className="notice">{overLimitNotice}</p>}
          </section>

          <section className="panel-block">
            <h2>媒体诊断</h2>
            {activeSession ? (
              <>
                <dl className="diagnostic-list">
                  {remoteMediaDiagnostics.map((item) => (
                    <div key={item.channelId}>
                      <dt>{channelLabelById(item.channelId)}</dt>
                      <dd>
                        <span className={`diagnostic-state diagnostic-state-${item.state}`}>{item.label}</span>
                        <span>{item.detail}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <h3 className="subhead">连接诊断</h3>
                {peerConnectionDiagnostics.length ? (
                  <dl className="diagnostic-list peer-diagnostic-list">
                    {peerConnectionDiagnostics.map((item) => (
                      <div key={item.endpointId}>
                        <dt>{endpointLabelById(item.endpointId)}</dt>
                        <dd>
                          <span className={`diagnostic-state peer-diagnostic-state peer-diagnostic-state-${item.state}`}>
                            {item.label}
                          </span>
                          <span>{item.detail}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="hint">尚未建立 WebRTC PeerConnection。</p>
                )}
              </>
            ) : (
              <p className="hint">建立信令会话后显示各订阅通道的远端媒体状态。</p>
            )}
          </section>

          <section className="panel-block">
            <h2>按需拉取与布局</h2>
            <div className="channel-pulls">
              {CHANNELS.map((channel) => (
                <label className="checkline" key={channel.id}>
                  <input
                    type="checkbox"
                    disabled={!activeSession}
                    checked={activeSession?.subscribedChannels.includes(channel.id) || false}
                    onChange={(event) => toggleRemoteChannel(channel.id, event.target.checked)}
                  />
                  {channel.label} {channel.role}
                </label>
              ))}
            </div>
            <div className="button-row">
              <button onClick={() => setLayoutMode("single")} className={layoutMode === "single" ? "active" : ""}>
                单画面
              </button>
              <button onClick={() => setLayoutMode("dual")} className={layoutMode === "dual" ? "active" : ""}>
                双画面
              </button>
              <button onClick={() => setLayoutMode("quad")} className={layoutMode === "quad" ? "active" : ""}>
                四画面
              </button>
            </div>
            <label className="annotation-input">
              扩展显示器
              <select value={selectedDisplayId} onChange={(event) => setSelectedDisplayId(event.target.value)}>
                <option value="">默认窗口位置</option>
                {displayTargets.map((display) => (
                  <option value={String(display.id)} key={display.id}>
                    {displayLabel(display)}
                  </option>
                ))}
              </select>
            </label>
            <div className="button-row">
              <button onClick={() => refreshDisplayTargets()}>刷新显示器</button>
            </div>
            <label className="annotation-input">
              标注内容
              <input
                value={annotationText}
                onChange={(event) => updateAnnotationText(event.target.value)}
                disabled={localEndpointRole !== "operating-room"}
              />
            </label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={annotationVisible}
                onChange={(event) => updateAnnotationVisible(event.target.checked)}
                disabled={!activeSession || localEndpointRole !== "operating-room"}
              />
              手术室端标注远端可见
            </label>
          </section>
        </div>

        <section className="remote-stage">
          <div className="remote-head">
            <div>
              <h2>远端显示区</h2>
              <p>{activeSession ? "已建立连接，按需显示订阅通道。" : "未连接，等待呼叫确认。"}</p>
            </div>
            <span>{layoutMode === "single" ? "单画面" : layoutMode === "dual" ? "双画面" : "四画面"}</span>
          </div>
          <div className={`remote-grid layout-${layoutMode}`}>
            {activeSession ? (
              remoteChannels.map((channelId) => {
                const channel = CHANNELS.find((item) => item.id === channelId);
                const mediaHealth = remoteMediaHealth(channelId);
                return (
                  <div className="remote-video-tile" key={channelId}>
                    <video
                      ref={(node) => {
                        remoteVideoRefs.current[channelId] = node;
                      }}
                      muted
                      playsInline
                    />
                    <div className="remote-label">
                      {channel?.label} {channel?.role}
                    </div>
                    <div className={`remote-health remote-health-${mediaHealth.state}`}>{mediaHealth.label}</div>
                    <button className="popout-button" onClick={() => openRemotePopout(channelId)}>
                      扩展窗口
                    </button>
                    {annotationVisible && <div className="annotation">{annotationText}</div>}
                  </div>
                );
              })
            ) : (
              <div className="empty-remote">连接建立后默认显示通道 1，并可按需拉取其他通道。</div>
            )}
          </div>
        </section>
      </section>

      <section className="playback-panel">
        <div>
          <h2>基础回放</h2>
          <p>{selectedPlayback ? selectedPlayback.fileName : "请选择一条录像记录。"}</p>
          <div className="button-row">
            <button onClick={() => enqueueAiJob(selectedPlayback)} disabled={!selectedPlayback}>
              加入 AI 队列
            </button>
            <span>AI 队列：{aiJobs.length}</span>
          </div>
          <div className="ai-job-list">
            {aiJobs.length === 0 && <p className="hint">暂无 AI 任务。</p>}
            {aiJobs.slice(0, 5).map((job) => (
              <div className="ai-job-item" key={job.id}>
                <strong>{job.channelLabel || job.fileName}</strong>
                <span>{job.status}</span>
                <span>{formatDuration(job.durationMs)} / {formatBytes(job.bytes)}</span>
                <span>{job.patient ? `${job.patient.name} / ${job.patient.hisId}` : "未绑定患者"}</span>
              </div>
            ))}
          </div>
        </div>
        <video src={selectedPlayback?.fileUrl || ""} controls />
      </section>

      <footer className="footer">
        <span>{status}</span>
      </footer>

      <div className="remote-audio-sinks" aria-hidden="true">
        {remoteEndpointIds.map((endpointId) => (
          <audio
            autoPlay
            playsInline
            key={endpointId}
            ref={(node) => {
              remoteAudioRefs.current[endpointId] = node;
            }}
          />
        ))}
      </div>
    </div>
  );
}

async function bootstrap() {
  const runtimeConfig = await loadRuntimeConfig();
  createRoot(document.getElementById("root")).render(<App initialConfig={runtimeConfig} />);
}

bootstrap();
