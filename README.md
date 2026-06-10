# 手术示教软件 PoC

[![CI](https://github.com/ticopapa327-dot/surgical-teaching-phase1-poc/actions/workflows/ci.yml/badge.svg)](https://github.com/ticopapa327-dot/surgical-teaching-phase1-poc/actions/workflows/ci.yml)

这是手术示教软件的 Windows 桌面 PoC 工程，当前覆盖阶段 1、阶段 2 与阶段 3 初步媒体链路的核心验证内容。

## 当前能力

### 阶段 1：采集、预览、录制

- 4 路 USB/UVC 视频输入预览。
- 无采集卡时使用 4 路模拟源进行功能验证。
- USB/UVC 摄像机预览通道提供云台方向和镜头变倍控制入口；设备或浏览器不支持时给出明确提示。
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
- 提供轻量 WebSocket 信令服务器，用于验证 C/S 呼叫控制、终端注册、通讯录、会话订阅、离会和参与上限。
- 前端工作台可连接本地信令服务器，注册本端、读取在线目录、选择目标终端并通过信令进入已接受会话，也可从会话目录选择或手工输入会话 ID 加入既有会话。
- 信令服务提供轻量会话目录摘要，用于观摩端发现可加入会议；该目录不包含标注内容、订阅细节、患者信息或媒体房间数据。
- 终端注册时可上报视频通道清单，通讯录可返回目标终端绑定的通道元数据。
- 前端按本端角色上报能力和通道：手术室端发布 4 路通道，观摩端仅声明收看能力。
- 信令服务会对终端注册、订阅通道和参与人数上限做基础归一化，并支持重复 endpointId 注册时由新连接替换旧连接、恢复既有会话状态。
- 信令服务支持可选共享令牌门禁，可通过环境变量启用；启用后 WebSocket 注册和 HTTP 目录接口需要令牌，该能力只用于 PoC 入口保护，不替代生产级鉴权。
- 信令服务提供内存型控制面事件日志，可通过 HTTP 或前端“刷新事件”查询最近事件摘要；`/events` 支持 `limit` 查询参数；该日志用于调试和验收追踪，不替代生产审计。
- 信令呼叫具备忙线保护、待处理超时和 WebSocket 心跳清理，避免未确认呼叫或半开连接长期占用终端状态。
- 标注文本和可见状态可通过信令会话广播给远端参与方。
- 信令会话支持显式结束、参与方离会并向相关参与方广播状态事件。
- 会话参与方异常断开时，服务端会按 owner 和剩余人数决定保留或结束会话，并通知剩余参与方。
- 信令服务支持会话内 `peer.signal` 透传，用于后续 WebRTC offer、answer 和 ICE 候选协商。
- 前端可调用信令 `/health` 显示终端、会话和待处理呼叫数量。
- 提供模拟 HIS 查询与患者绑定面板，新录像可写入患者元数据。
- 录像可加入本地模拟 AI 处理队列，为后续识别服务预留任务接口。
- 录像索引支持搜索、定位、导出、FTP 上传和删除；Electron 模式下导出为文件复制并可按环境变量上传 FTP，浏览器测试模式下导出为 Blob 下载且 FTP 上传不可用。
- 远端画面支持打开独立扩展窗口；Electron 模式下可读取 Windows 显示器清单并将弹窗定位到指定显示器，浏览器模式下回退为默认弹窗。

### 阶段 3：按订阅 WebRTC 媒体 PoC

- 手术室端可在已建立信令会话后，按远端订阅发布通道 1 至通道 4 的视频媒体。
- 发布中远端订阅、参与方或远端重连发生变化时，手术室端会按新的会话状态自动重新协商媒体链路。
- 示教室端可通过既有 `peer.signal` 透传完成 WebRTC offer、answer 和 ICE 协商。
- 示教室端远端显示区优先显示收到的真实远端 MediaStream，不再只能依赖本地模拟预览流。
- 示教室端或观摩端在黑屏、停止媒体链路或诊断异常后，可通过信令请求手术室端重新发布订阅媒体。
- 接收端停止媒体链路时只通知手术室 owner 清理该接收端对应的 PeerConnection，不影响其他仍在接收的示教室端或观摩端。
- 交互模式下可将本地麦克风加入 WebRTC 链路，双端均可接收远端音频。
- 音频面板支持选择麦克风输入和远端音频回放输出设备；输出选择依赖浏览器 `setSinkId` 能力，不支持时回退系统默认输出。
- 状态区显示视频发送/接收码率、包发/收/丢、音频缓冲、jitter、RTT 和 ICE 候选类型路由，便于判断黑屏、延迟或 TURN/relay 路径问题。
- 提供“复制诊断快照”，输出控制面、通道、音频、媒体、结构化 WebRTC 指标、PeerConnection 和最近 10 条信令事件摘要；快照不包含信令令牌、设备 ID、患者信息、SDP、ICE candidate 原文或媒体数据。
- 当前只验证少量浏览器 P2P 按订阅多路视频和基础音频链路，不包含 SFU、生产级多方转发、TURN 中继、RTSP/SRT 接入和手机直播分发。

## 技术边界

本工程采用 Electron + React + MediaRecorder 实现，适合快速验证 USB 采集卡是否以标准摄像头设备暴露、四画面预览是否稳定、选择性录制流程是否成立，以及呼叫/订阅/布局控制流是否合理。

当前阶段 3 已可通过浏览器 WebRTC P2P 按远端订阅建立多通道真实远端视频链路，并在交互模式下承载基础远端音频，但它不等同于生产级媒体服务或 SFU。真实跨网段、多人会议、Android 会议平板、手机直播和弱网恢复必须在后续阶段接入媒体服务后重新验证。

信令服务器只负责控制平面和 WebRTC 协商消息透传，不转发音视频媒体流。后续真实部署应将信令服务、媒体服务和业务服务拆分设计。

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

默认监听 `ws://127.0.0.1:7077/signal`，健康检查地址为 `http://127.0.0.1:7077/health`，在线会话摘要地址为 `http://127.0.0.1:7077/sessions`，控制面事件地址为 `http://127.0.0.1:7077/events`。
只读取最近事件时可使用 `http://127.0.0.1:7077/events?limit=10`。

信令服务支持以下环境变量：

- `SIGNALING_HOST`：监听地址，默认 `127.0.0.1`。
- `SIGNALING_PORT`：监听端口，默认 `7077`。
- `SIGNALING_AUTH_TOKEN`：可选共享令牌；设置后 WebSocket 注册和 HTTP 目录/事件接口需要令牌。
- `SIGNALING_CALL_TIMEOUT_MS`：待处理呼叫超时时间，默认 `60000`。
- `SIGNALING_HEARTBEAT_MS`：WebSocket 心跳间隔，默认 `30000`；设置为 `0` 可关闭心跳。
- `SIGNALING_EVENT_LOG_LIMIT`：内存事件日志保留条数，默认 `200`，范围 `20` 到 `1000`。

Electron 客户端支持以下 FTP 上传环境变量；未设置 `UST_FTP_HOST` 时点击“上传FTP”会明确提示 `ftp_not_configured`：

- `UST_FTP_HOST`：FTP 服务器地址。
- `UST_FTP_PORT`：FTP 端口，默认 `21`。
- `UST_FTP_USER`：用户名，默认 `anonymous`。
- `UST_FTP_PASSWORD`：密码，默认 `anonymous@`。
- `UST_FTP_SECURE`：可选，`true`/`1`/`yes` 启用 FTPS，`implicit` 使用隐式 FTPS。
- `UST_FTP_REMOTE_DIR`：可选远端目录。
- `UST_FTP_VERBOSE`：设置为 `1` 时输出 FTP 客户端调试日志。

局域网双机测试可直接使用一键启动：

```powershell
npm run dev:lan:check
npm run dev:lan
```

`dev:lan:check` 只检查端口占用并打印网卡名称、局域网访问地址和防火墙放行命令，不启动服务。`dev:lan` 会同时启动 `0.0.0.0:7077` 信令服务和 `0.0.0.0:5173` 前端页面，完成 `/health` 与前端页面探测后输出 `Services ready`。
开发自检可运行 `npm run dev:lan:smoke`，该命令启动服务并在 ready 探测通过后自动退出。
多网卡机器可设置 `UST_PREFERRED_ADAPTER` 优先推荐指定网卡名称片段，例如：

```powershell
$env:UST_PREFERRED_ADAPTER="以太网"
npm run dev:lan:check
```

## 配置

前端启动时会读取 [public/config.json](public/config.json) 作为运行时默认配置。当前支持：

- `signalingUrl`：默认信令服务器地址。当前端从局域网 IP 打开且配置仍为 `127.0.0.1` 时，软件会自动改用页面所在主机的 `7077` 端口。
- `signalingToken`：可选信令共享令牌；为空时不发送。
- `localEndpoint.id`：本端终端 ID。默认占位值会自动替换为浏览器本地保存的唯一 ID，避免两台电脑使用同一 `endpointId` 互相顶号。
- `localEndpoint.name`：本端显示名称。
- `localEndpoint.role`：本端角色，支持 `operating-room`、`teaching-room`、`observer`。
- `webrtc.iceServers`：可选 STUN/TURN 配置数组，默认空数组，适合同一局域网 P2P 测试；跨网段联调时可填入 `{ "urls": "turn:host:3478", "username": "...", "credential": "..." }`。

可参考 [public/config.example.json](public/config.example.json) 配置局域网信令地址和 STUN/TURN。不要把真实 TURN 用户名、密码或医院内网密钥提交到公开仓库。

## 验证

```powershell
npm run verify
```

`verify` 会依次执行构建、高危依赖审计、脚本级测试、前端烟测和信令契约测试。也可以单独执行：

```powershell
npm run build
npm run audit:high
npm run test:scripts
npm run test:smoke
npm run test:media
npm run test:media:repeat
npm run test:signaling
```

`test:smoke` 使用系统 Chrome 打开 Vite 页面，验证页面渲染、模拟预览、呼叫确认、多路拉取、布局切换、标注、参与上限提示、前端连接真实 WebSocket 信令服务器后进入已接受会话，以及双页面/三页面 WebRTC 按订阅多路视频和音频链路。

`test:media` 只运行 Phase 3 WebRTC 媒体用例；`test:media:repeat` 对这些用例执行 `--repeat-each=2`，用于提交前或现场复现后做媒体链路稳定性复测。

`test:signaling` 启动本地 WebSocket 信令服务器，模拟手术室端、示教室端和观摩端，验证注册、通讯录、会话目录、呼叫、接受、默认通道、订阅、参与上限拒绝、协议错误分支和心跳清理。

现场保存的诊断快照 JSON 可用 `node scripts/summarize-diagnostics.cjs snapshot-a.json snapshot-b.json > diagnostics.csv` 汇总为 CSV。

## 文档

- [贡献说明](CONTRIBUTING.md)
- [安全说明](SECURITY.md)
- [软件架构说明](docs/architecture.md)
- [阶段 1 测试计划](docs/phase1-test-plan.md)
- [阶段 2 测试计划](docs/phase2-test-plan.md)
- [Phase 2 阶段状态与边界](docs/phase2-status.md)
- [Phase 2 交付交接说明](docs/phase2-handoff.md)
- [Phase 3 按订阅 WebRTC 媒体 PoC 说明](docs/phase3-media-poc.md)
- [两台电脑手术室与示教室模拟测试使用手册](docs/two-pc-test-manual.md)
- [Phase 2 信令协议说明](docs/signaling-protocol.md)
- [阶段 3 患者绑定测试计划](docs/phase3-test-plan.md)
- [AI 处理接口预留说明](docs/ai-interface.md)

## 已知限制

- 录制格式由 Chromium MediaRecorder 决定，通常为 WebM。
- 音频回声消除当前只能验证浏览器侧约束，实际双端效果必须现场复测。
- 阶段 3 当前只验证少量浏览器 P2P 按订阅多路视频和基础音频，不包含真实 SFU、远端网络抖动、TURN 中继和 Android 平板端原生能力。
- 信令服务器当前只做控制面验证；可选共享令牌和内存事件日志不等同于生产级鉴权或审计，仍不做用户级权限、持久化、TLS、合规审计和媒体转发。
- 真实 HIS 联网、生产级录像归档策略、厂商 SDK 云台控制和手机直播仍属于后续阶段或专项扩展验证项；当前 FTP 上传仅为 Electron 客户端环境变量配置的 PoC 能力，当前云台控制仅验证浏览器可用的 UVC PTZ 能力。
