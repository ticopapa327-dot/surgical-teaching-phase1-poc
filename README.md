# 手术示教软件 PoC

这是手术示教软件的 Windows 桌面 PoC 工程，当前覆盖阶段 1 与阶段 2 的核心验证内容。

## 当前能力

### 阶段 1：采集、预览、录制

- 4 路 USB/UVC 视频输入预览。
- 无采集卡时使用 4 路模拟源进行功能验证。
- 选择部分通道或全部通道录制。
- 通过板载声卡或 USB 麦克风采集音频。
- 录像文件本地存储、索引、基础回放、定位和删除。

### 阶段 2：呼叫与互动

- 示教室端呼叫手术室端。
- 手术室端反向呼叫示教室端。
- 发起方选择仅收看或交互模式。
- 接收方确认仅收看或交互模式。
- 建立连接后默认显示通道 1。
- 根据需要按需拉取通道 2、通道 3、通道 4。
- 支持单画面、双画面、四画面布局切换。
- 交互模式下建立本地音频通话轨道，并启用回声消除、降噪、自动增益约束。
- 手术室端设置参与上限，超过上限时提示新用户被拒绝。
- 支持手术室端标注在远端显示区可见。
- 提供轻量 WebSocket 信令服务器，用于验证 C/S 呼叫控制、终端注册、通讯录、会话订阅和参与上限。
- 前端工作台可连接本地信令服务器，注册本端、读取在线目录、选择目标终端并通过信令进入已接受会话。
- 终端注册时可上报视频通道清单，通讯录可返回目标终端绑定的通道元数据。
- 标注文本和可见状态可通过信令会话广播给远端参与方。
- 信令会话支持显式结束并向参与方广播结束事件。
- 会话参与方异常断开时，服务端会清理会话并通知剩余参与方。
- 信令服务支持会话内 `peer.signal` 透传，用于后续 WebRTC offer、answer 和 ICE 候选协商。
- 前端可调用信令 `/health` 显示终端、会话和待处理呼叫数量。

## 技术边界

本工程采用 Electron + React + MediaRecorder 实现，适合快速验证 USB 采集卡是否以标准摄像头设备暴露、四画面预览是否稳定、选择性录制流程是否成立，以及呼叫/订阅/布局控制流是否合理。

当前阶段 2 的互动工作台是在同一应用内模拟手术室端和示教室端控制流，并复用本地预览流作为远端可订阅画面。它不等同于真实跨终端媒体服务或 SFU。真实跨机器、跨网段、Android 会议平板和手机直播必须在后续阶段接入媒体服务后重新验证。

信令服务器只负责控制平面，不转发音视频媒体流。后续真实部署应将信令服务、媒体服务和业务服务拆分设计。

如果 PoC 发现浏览器媒体栈在长时间录制、多路高分辨率、特定采集卡驱动或低延迟场景下不稳定，生产版应切换或补充 Windows 原生采集层，例如 Media Foundation、DirectShow、厂商 SDK 或 FFmpeg/GStreamer 适配层。

## 运行

```powershell
cd D:\CodeX\UST\phase1-poc
npm install
npm run dev
```

应用启动后先点击 `授权并刷新设备`。如果没有 USB 采集卡，可保持通道为 `模拟源`，直接验证预览、录制、索引、回放和互动拉流流程。

启动信令服务器：

```powershell
npm run server:signaling
```

默认监听 `ws://127.0.0.1:7077/signal`，健康检查地址为 `http://127.0.0.1:7077/health`。

## 配置

前端启动时会读取 [public/config.json](public/config.json) 作为运行时默认配置。当前支持：

- `signalingUrl`：默认信令服务器地址。
- `localEndpoint.id`：本端终端 ID。
- `localEndpoint.name`：本端显示名称。
- `localEndpoint.role`：本端角色，支持 `operating-room`、`teaching-room`、`observer`。

## 验证

```powershell
npm run verify
```

`verify` 会依次执行构建、高危依赖审计、前端烟测和信令契约测试。也可以单独执行：

```powershell
npm run build
npm audit --audit-level=high
npm run test:smoke
npm run test:signaling
```

`test:smoke` 使用系统 Chrome 打开 Vite 页面，验证页面渲染、模拟预览、呼叫确认、多路拉取、布局切换、标注、参与上限提示，以及前端连接真实 WebSocket 信令服务器后进入已接受会话。

`test:signaling` 启动本地 WebSocket 信令服务器，模拟手术室端、示教室端和观摩端，验证注册、通讯录、呼叫、接受、默认通道、订阅和参与上限拒绝。

## 文档

- [阶段 1 测试计划](docs/phase1-test-plan.md)
- [阶段 2 测试计划](docs/phase2-test-plan.md)
- [Phase 2 阶段状态与边界](docs/phase2-status.md)
- [Phase 2 信令协议说明](docs/signaling-protocol.md)

## 已知限制

- 录制格式由 Chromium MediaRecorder 决定，通常为 WebM。
- 音频回声消除当前只能验证浏览器侧约束，实际双端效果必须现场复测。
- 阶段 2 当前验证控制流和本地媒体订阅，不包含真实 SFU、远端网络抖动、NAT 穿越和 Android 平板端原生能力。
- 信令服务器当前只做控制面验证，不做鉴权、持久化、TLS、审计和媒体转发。
- HIS、FTP、云台控制和手机直播仍属于后续阶段或专项扩展验证项。
