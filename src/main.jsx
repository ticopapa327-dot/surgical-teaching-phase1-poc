import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const CHANNELS = [
  { id: "ch1", label: "通道 1", role: "全景" },
  { id: "ch2", label: "通道 2", role: "术野" },
  { id: "ch3", label: "通道 3", role: "腹腔镜" },
  { id: "ch4", label: "通道 4", role: "备用" }
];

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
    openRoot: async () => ({ ok: true })
  }
};

function getSupportedMimeType() {
  if (!window.MediaRecorder) return "";
  return MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || "";
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
    const t = new Date();
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
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "700 58px Microsoft YaHei, sans-serif";
    ctx.fillText(`${channel.label} ${channel.role}`, 56, 112);
    ctx.font = "32px Consolas, monospace";
    ctx.fillText(t.toLocaleString(), 56, 176);
    ctx.font = "28px Microsoft YaHei, sans-serif";
    ctx.fillText("模拟视频源：无 USB 采集卡时用于阶段 1 功能验证", 56, 234);
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

function App() {
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

  const videoRefs = useRef({});
  const previewStreams = useRef({});
  const activeRecorders = useRef({});
  const pendingWrites = useRef({});

  const supportedMimeType = useMemo(getSupportedMimeType, []);

  useEffect(() => {
    api.getAppInfo().then(setAppInfo);
    refreshRecordings();
    return () => {
      Object.values(previewStreams.current).forEach(stopStream);
    };
  }, []);

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

  const anyRecording = CHANNELS.some((channel) => activeRecorders.current[channel.id]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>手术示教 Phase 1 PoC</h1>
          <p>4 路 USB 视频预览、选择性录制、音频采集、文件索引与回放验证</p>
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
            <p className="hint">音频采集默认启用回声消除、噪声抑制和自动增益。实际效果必须现场验证。</p>
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
                <dt>存储目录</dt>
                <dd>{appInfo?.recordingsDir || "-"}</dd>
              </div>
            </dl>
            <button onClick={() => api.recordings.openRoot()}>打开录像目录</button>
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
                  </button>
                  <div className="recording-actions">
                    <button onClick={() => api.recordings.reveal(item.id)}>定位</button>
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

      <section className="playback-panel">
        <div>
          <h2>基础回放</h2>
          <p>{selectedPlayback ? selectedPlayback.fileName : "请选择一条录像记录。"}</p>
        </div>
        <video src={selectedPlayback?.fileUrl || ""} controls />
      </section>

      <footer className="footer">
        <span>{status}</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
