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
const DEFAULT_APP_CONFIG = {
  signalingUrl: DEFAULT_SIGNALING_URL,
  localEndpoint: {
    id: "or-local",
    name: "手术室端本机",
    role: "operating-room"
  }
};

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];

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
    openRoot: async () => ({ ok: true })
  }
};

function getSupportedMimeType() {
  if (!window.MediaRecorder) return "";
  return MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) return DEFAULT_APP_CONFIG;
    return { ...DEFAULT_APP_CONFIG, ...(await response.json()) };
  } catch {
    return DEFAULT_APP_CONFIG;
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

function healthUrlFromSignalingUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function endpointLabel(endpoint) {
  if (!endpoint) return "未知终端";
  return `${endpoint.name || endpoint.endpointId}${endpoint.address ? ` (${endpoint.address})` : ""}`;
}

function sessionChannelsForEndpoint(session, endpointId) {
  const channels = session.subscriptions?.[endpointId];
  return Array.isArray(channels) && channels.length ? channels : ["ch1"];
}

function App({ initialConfig = DEFAULT_APP_CONFIG }) {
  const [appInfo, setAppInfo] = useState(null);
  const [videoDevices, setVideoDevices] = useState([]);
  const [audioDevices, setAudioDevices] = useState([]);
  const [channelConfig, setChannelConfig] = useState(createDefaultChannelConfig);
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [recordings, setRecordings] = useState([]);
  const [status, setStatus] = useState("准备就绪");
  const [selectedPlayback, setSelectedPlayback] = useState(null);
  const [isPermissionReady, setPermissionReady] = useState(false);
  const [recordingSessionId, setRecordingSessionId] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const [patientQuery, setPatientQuery] = useState("HIS-001");
  const [currentPatient, setCurrentPatient] = useState(null);
  const [patientStatus, setPatientStatus] = useState("未绑定患者");
  const [aiJobs, setAiJobs] = useState([]);

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
  const [signalingTargetId, setSignalingTargetId] = useState("");
  const [signalingHealth, setSignalingHealth] = useState("-");

  const [callTargetId, setCallTargetId] = useState(ADDRESS_BOOK[0].id);
  const [customAddress, setCustomAddress] = useState("");
  const [requestMode, setRequestMode] = useState("interactive");
  const [confirmMode, setConfirmMode] = useState("interactive");
  const [participantLimit, setParticipantLimit] = useState(2);
  const [pendingCall, setPendingCall] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [layoutMode, setLayoutMode] = useState("single");
  const [annotationText, setAnnotationText] = useState("请关注术野关键区域");
  const [annotationVisible, setAnnotationVisible] = useState(false);
  const [audioCall, setAudioCall] = useState({ state: "idle", label: "未建立" });
  const [overLimitNotice, setOverLimitNotice] = useState("");

  const videoRefs = useRef({});
  const remoteVideoRefs = useRef({});
  const previewStreams = useRef({});
  const activeRecorders = useRef({});
  const pendingWrites = useRef({});
  const interactionAudioStream = useRef(null);
  const signalingSocket = useRef(null);
  const signalingEndpointIdRef = useRef(localEndpointId);
  const signalingDirectoryRef = useRef([]);

  const supportedMimeType = useMemo(getSupportedMimeType, []);

  useEffect(() => {
    api.getAppInfo().then(setAppInfo);
    refreshRecordings();
    return () => {
      Object.values(previewStreams.current).forEach(stopStream);
      stopStream(interactionAudioStream.current);
      signalingSocket.current?.close();
    };
  }, []);

  useEffect(() => {
    signalingEndpointIdRef.current = localEndpointId.trim() || "or-local";
  }, [localEndpointId]);

  useEffect(() => {
    signalingDirectoryRef.current = signalingDirectory;
  }, [signalingDirectory]);

  useEffect(() => {
    if (!activeSession) return;
    for (const channelId of activeSession.subscribedChannels) {
      const video = remoteVideoRefs.current[channelId];
      const stream = previewStreams.current[channelId];
      if (video && video.srcObject !== stream) {
        video.srcObject = stream || null;
        if (stream) video.play().catch(() => {});
      }
    }
  }, [activeSession, previewVersion, layoutMode]);

  async function refreshRecordings() {
    const items = await api.recordings.list();
    setRecordings(items);
  }

  async function requestDevicePermissionAndRefresh() {
    setStatus("正在请求摄像头和麦克风权限...");
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setPermissionReady(true);
    } catch (error) {
      setStatus(`设备授权失败：${error.message}`);
    } finally {
      stopStream(stream);
    }
    await refreshDevices();
  }

  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus("当前环境不支持媒体设备枚举。");
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videos = devices.filter((device) => device.kind === "videoinput");
    const audios = devices.filter((device) => device.kind === "audioinput");
    setVideoDevices(videos);
    setAudioDevices(audios);
    setStatus(`已发现 ${videos.length} 个视频输入、${audios.length} 个音频输入。`);
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
    if (!videoTrack) throw new Error(`${channel.label} 没有可录制的视频轨道`);

    const audioTracks = await getAudioTracksForRecording();
    const recordStream = new MediaStream([videoTrack.clone(), ...audioTracks]);
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

    recorder.onstop = async () => {
      await Promise.allSettled(writes);
      const active = activeRecorders.current[channel.id];
      await api.recordings.close({
        recordingId: created.id,
        stoppedAt: new Date().toISOString(),
        durationMs: active ? Date.now() - active.startedAtMs : null
      });
      stopStream(recordStream);
      delete activeRecorders.current[channel.id];
      delete pendingWrites.current[channel.id];
      await refreshRecordings();
      setStatus(`${channel.label} 录制已完成。`);
    };

    activeRecorders.current[channel.id] = {
      recorder,
      recordingId: created.id,
      startedAtMs: Date.now()
    };
    recorder.start(1000);
    setStatus(`${channel.label} 正在录制。`);
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
      patient: recording.patient || null,
      status: "queued",
      createdAt: new Date().toISOString()
    };
    setAiJobs((jobs) => [job, ...jobs]);
    setStatus(`AI 处理任务已加入本地模拟队列：${recording.channelLabel}`);
  }

  function selectedTarget() {
    return ADDRESS_BOOK.find((item) => item.id === callTargetId) || ADDRESS_BOOK[0];
  }

  function endpointLabelById(endpointId) {
    const endpoint = signalingDirectoryRef.current.find((item) => item.endpointId === endpointId);
    return endpoint ? endpointLabel(endpoint) : endpointId;
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

  function applySignalingSession(session, resetLayout = false) {
    if (!session) return;
    const endpointId = signalingEndpointIdRef.current;
    setActiveSession({
      id: session.sessionId,
      source: "signaling",
      startedAt: session.startedAt,
      mode: session.mode,
      participants: session.participants.map(endpointLabelById),
      participantLimit: session.participantLimit,
      subscribedChannels: sessionChannelsForEndpoint(session, endpointId)
    });
    if (session.annotation) {
      setAnnotationText(session.annotation.text || "");
      setAnnotationVisible(Boolean(session.annotation.visible));
    }
    if (resetLayout) setLayoutMode("single");
    setPendingCall(null);
    setOverLimitNotice("");
  }

  function handleSignalingMessage(message) {
    const { type, payload = {} } = message;
    if (type === "endpoint.registered") {
      setSignalingState({ connected: true, label: `已注册 ${payload.endpoint?.name || signalingEndpointIdRef.current}` });
      setStatus("信令服务器已连接，本端已注册。");
      sendSignaling("endpoint.list");
      return;
    }

    if (type === "directory.updated" || type === "directory.snapshot") {
      setDirectoryFromSignaling(payload.endpoints);
      return;
    }

    if (type === "call.requested") {
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
      setStatus(`${endpointLabel(payload.from)} 通过信令发起 ${modeLabel(call.requestedMode)} 呼叫。`);
      return;
    }

    if (type === "call.rejected") {
      setPendingCall(null);
      setStatus("信令呼叫已被拒绝。");
      return;
    }

    if (type === "session.started") {
      applySignalingSession(payload.session, true);
      setStatus(`信令会话已建立，最终模式为 ${modeLabel(payload.session?.mode)}。`);
      return;
    }

    if (
      type === "session.updated" ||
      type === "session.subscribed" ||
      type === "session.joined" ||
      type === "session.annotation.updated"
    ) {
      applySignalingSession(payload.session);
      return;
    }

    if (type === "session.ended") {
      const action = payload.reason === "endpoint_disconnected" ? "断开" : "结束";
      clearLocalSession(`信令会话已由 ${endpointLabelById(payload.endedByEndpointId)} ${action}。`);
      return;
    }

    if (type === "error") {
      const messageText = payload.message || payload.code || "未知信令错误";
      if (payload.code === "participant_limit") setOverLimitNotice("信令服务器拒绝加入：已达到参与上限。");
      setStatus(`信令错误：${messageText}`);
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
    signalingEndpointIdRef.current = endpointId;
    setSignalingState({ connected: false, label: "连接中" });
    setStatus("正在连接信令服务器...");

    const nextUrl = signalingUrl.trim() || DEFAULT_SIGNALING_URL;
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
            role: localEndpointRole,
            name: endpointName,
            address: "127.0.0.1",
            capabilities: ["call-control", "publish-video", "subscribe-video", "interactive-audio"],
            channels: CHANNELS.map((channel) => ({
              id: channel.id,
              label: channel.label,
              role: channel.role
            }))
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
      if (signalingSocket.current === ws) signalingSocket.current = null;
      setSignalingState({ connected: false, label: "未连接" });
    };
  }

  function disconnectSignaling() {
    signalingSocket.current?.close();
    signalingSocket.current = null;
    setSignalingDirectory([]);
    setSignalingTargetId("");
    setSignalingState({ connected: false, label: "未连接" });
    setStatus("信令连接已断开。");
  }

  function requestSignalingCall() {
    const target = signalingDirectory.find((item) => item.endpointId === signalingTargetId);
    if (!target) {
      setStatus("请先选择在线信令目标。");
      return;
    }
    if (sendSignaling("call.request", { toEndpointId: target.endpointId, mode: requestMode })) {
      setStatus(`已通过信令向 ${endpointLabel(target)} 发起 ${modeLabel(requestMode)} 呼叫。`);
    }
  }

  async function checkSignalingHealth() {
    const nextUrl = signalingUrl.trim() || DEFAULT_SIGNALING_URL;
    if (!isValidWebSocketUrl(nextUrl)) {
      setSignalingHealth("地址无效");
      setStatus("信令地址无效：必须使用 ws:// 或 wss:// 地址。");
      return;
    }
    try {
      const response = await fetch(healthUrlFromSignalingUrl(nextUrl), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      setSignalingHealth(`${health.endpoints} 终端 / ${health.sessions} 会话 / ${health.pendingCalls} 呼叫`);
      setStatus("信令健康检查正常。");
    } catch (error) {
      setSignalingHealth("检查失败");
      setStatus(`信令健康检查失败：${error.message}`);
    }
  }

  function syncSignalingAnnotation(text, visible) {
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
    if (!previewStreams.current[channelId]) {
      await startPreview(channel);
    }
    const stream = previewStreams.current[channelId];
    const popup = window.open("", "_blank", "popup,width=960,height=620");
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
    setStatus(`${channel.label} 已打开扩展窗口，可拖动到其他显示器。`);
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
    stopInteractionAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      interactionAudioStream.current = stream;
      setAudioCall({
        state: "connected",
        label: `已建立，本地音频轨道 ${stream.getAudioTracks().length} 路`
      });
      setStatus("交互音频已建立，已启用回声消除、噪声抑制和自动增益约束。");
    } catch (error) {
      setAudioCall({ state: "error", label: error.message });
      setStatus(`交互音频建立失败：${error.message}`);
    }
  }

  function stopInteractionAudio() {
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
  const signalingTargets = signalingDirectory.filter((endpoint) => endpoint.endpointId !== signalingEndpointIdRef.current);
  const selectedSignalingTarget = signalingTargets.find((endpoint) => endpoint.endpointId === signalingTargetId);
  const selectedTargetChannels =
    selectedSignalingTarget?.channels?.map((channel) => `${channel.id} ${channel.label}`).join("、") || "-";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>手术示教 Phase 2 PoC</h1>
          <p>4 路采集录制稳定性已通过，当前验证呼叫、互动、按需拉流、布局和会议上限。</p>
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
            <select value={audioDeviceId} onChange={(event) => setAudioDeviceId(event.target.value)}>
              <option value="">不选择音频输入</option>
              {audioDevices.map((device, index) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `音频输入 ${index + 1}`}
                </option>
              ))}
            </select>
            <p className="hint">阶段 2 的音频通话使用本地音频采集验证回声消除约束，真实远端通话需接入媒体服务后复测。</p>
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
                <dt>存储目录</dt>
                <dd>{appInfo?.recordingsDir || "-"}</dd>
              </div>
            </dl>
            <button onClick={() => api.recordings.openRoot()}>打开录像目录</button>
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
            <div className="recording-list">
              {recordings.length === 0 && <p className="hint">暂无录像。完成录制后会自动生成索引。</p>}
              {recordings.map((item) => (
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
                    <button onClick={() => api.recordings.reveal(item.id)}>定位</button>
                    <button onClick={() => api.recordings.export(item.id)}>导出</button>
                    <button
                      className="danger"
                      onClick={async () => {
                        await api.recordings.delete(item.id);
                        if (selectedPlayback?.id === item.id) setSelectedPlayback(null);
                        await refreshRecordings();
                      }}
                    >
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
                <input value={signalingUrl} onChange={(event) => setSignalingUrl(event.target.value)} />
              </label>
              <label>
                本端 ID
                <input value={localEndpointId} onChange={(event) => setLocalEndpointId(event.target.value)} />
              </label>
              <label>
                本端名称
                <input value={localEndpointName} onChange={(event) => setLocalEndpointName(event.target.value)} />
              </label>
              <label>
                本端角色
                <select value={localEndpointRole} onChange={(event) => setLocalEndpointRole(event.target.value)}>
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
                <dt>健康检查</dt>
                <dd>{signalingHealth}</dd>
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
              <button
                onClick={requestSignalingCall}
                disabled={!signalingState.connected || !signalingTargetId || Boolean(activeSession || pendingCall)}
              >
                信令呼叫选中终端
              </button>
            </div>
            <p className="hint">该面板只验证 C/S 控制面，音视频媒体仍由本地预览流模拟。</p>
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
              <button onClick={acceptCall} disabled={!pendingCall}>
                接受呼叫
              </button>
              <button className="danger" onClick={rejectCall} disabled={!pendingCall}>
                拒绝
              </button>
              <button className="danger" onClick={closeSession} disabled={!activeSession}>
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
            </div>
            {overLimitNotice && <p className="notice">{overLimitNotice}</p>}
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
              标注内容
              <input value={annotationText} onChange={(event) => updateAnnotationText(event.target.value)} />
            </label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={annotationVisible}
                onChange={(event) => updateAnnotationVisible(event.target.checked)}
                disabled={!activeSession}
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
        </div>
        <video src={selectedPlayback?.fileUrl || ""} controls />
      </section>

      <footer className="footer">
        <span>{status}</span>
      </footer>
    </div>
  );
}

async function bootstrap() {
  const runtimeConfig = await loadRuntimeConfig();
  createRoot(document.getElementById("root")).render(<App initialConfig={runtimeConfig} />);
}

bootstrap();
