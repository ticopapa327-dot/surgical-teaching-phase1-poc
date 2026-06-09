# Phase 2 信令协议说明

## 一、适用范围

本文档描述当前 PoC 已实现的 WebSocket 信令控制面协议，用于验证手术室端、示教室端和观摩端之间的注册、通讯录、呼叫、接受、拒绝、会话订阅和参与上限控制。

当前信令服务只处理控制消息，不传输音视频媒体，不做录像上传，不处理 HIS、FTP、云台控制、Android 原生能力和手机直播分发。

## 二、服务入口

| 类型 | 地址 | 说明 |
|---|---|---|
| WebSocket | `ws://127.0.0.1:7077/signal` | 信令消息通道 |
| HTTP | `http://127.0.0.1:7077/health` | 健康检查 |
| HTTP | `http://127.0.0.1:7077/directory` | 在线终端目录快照 |

服务端口可通过 `SIGNALING_PORT` 环境变量覆盖。

`/health` 返回 `ok`、`endpoints`、`sessions` 和 `pendingCalls`，用于基础运行状态检查。

HTTP 调试接口返回 CORS 头，允许前端工作台从 Vite 或 Electron 页面跨端口读取。

## 三、消息信封

客户端与服务端均使用 JSON 消息：

```json
{
  "type": "message.type",
  "requestId": "optional-request-id",
  "payload": {}
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | 消息类型 |
| `requestId` | 否 | 请求追踪 ID，服务端响应会尽量原样带回 |
| `payload` | 否 | 消息载荷 |

## 四、终端注册与通讯录

### 1. 注册终端

客户端连接后必须先发送 `endpoint.register`。

```json
{
  "type": "endpoint.register",
  "payload": {
    "endpointId": "or-1",
    "role": "operating-room",
    "name": "Operating Room 1",
    "address": "192.168.10.21",
    "capabilities": ["call-control", "publish-video", "subscribe-video"],
    "channels": [
      { "id": "ch1", "label": "Panorama", "role": "overview" },
      { "id": "ch2", "label": "Surgical Field", "role": "field" }
    ]
  }
}
```

服务端返回 `endpoint.registered`，并向所有在线终端广播 `directory.updated`。

### 2. 获取目录

客户端发送 `endpoint.list` 后，服务端返回 `directory.snapshot`。

目录项包含：

| 字段 | 说明 |
|---|---|
| `endpointId` | 终端 ID |
| `role` | 终端角色 |
| `name` | 终端名称 |
| `address` | 终端地址 |
| `capabilities` | 能力列表 |
| `channels` | 该终端公布的可发布或可订阅视频通道元数据 |
| `online` | 在线状态 |
| `registeredAt` | 注册时间 |

## 五、呼叫流程

### 1. 发起呼叫

发起方发送 `call.request`：

```json
{
  "type": "call.request",
  "payload": {
    "toEndpointId": "or-1",
    "mode": "interactive",
    "participantLimit": 4
  }
}
```

`mode` 支持：

| 值 | 说明 |
|---|---|
| `interactive` | 交互模式 |
| `view` | 仅收看 |

服务端向发起方返回 `call.requested`，并向接收方发送 `call.incoming`。

如果发起方是手术室端，`participantLimit` 会作为手术室端设置的会议人数上限进入后续会话。若接收方是手术室端，则以 `call.accept` 中的 `participantLimit` 为准。

### 2. 接受呼叫

接收方发送 `call.accept`：

```json
{
  "type": "call.accept",
  "payload": {
    "callId": "call-...",
    "mode": "interactive",
    "participantLimit": 2
  }
}
```

最终模式规则：

| 发起方请求 | 接收方确认 | 最终模式 |
|---|---|---|
| `interactive` | `interactive` | `interactive` |
| `interactive` | `view` | `view` |
| `view` | `interactive` | `view` |
| `view` | `view` | `view` |

服务端向双方发送 `session.started`。默认订阅通道为 `ch1`。

### 3. 拒绝呼叫

接收方发送 `call.reject` 后，服务端向双方发送 `call.rejected`。

## 六、会话订阅、标注与参与上限

### 1. 订阅通道

会话参与方发送 `session.subscribe`：

```json
{
  "type": "session.subscribe",
  "payload": {
    "sessionId": "session-...",
    "channels": ["ch1", "ch2", "ch3"]
  }
}
```

当前服务端最多保留 4 个订阅通道，并向会话参与方广播 `session.updated`。

### 2. 同步标注

手术室端会话参与方发送 `session.annotation`：

```json
{
  "type": "session.annotation",
  "payload": {
    "sessionId": "session-...",
    "text": "Needle entry",
    "visible": true
  }
}
```

服务端会更新会话中的 `annotation` 字段，并向会话参与方广播 `session.updated`。发送方还会收到 `session.annotation.updated`。非手术室端发送该消息会返回 `annotation_forbidden`。

`annotation` 字段包含：

| 字段 | 说明 |
|---|---|
| `visible` | 标注是否可见 |
| `text` | 标注文本，当前最多保留 200 个字符 |
| `updatedByEndpointId` | 最近一次更新标注的终端 ID |
| `updatedAt` | 最近一次更新时间 |

### 3. 结束会话

会话参与方发送 `session.end`：

```json
{
  "type": "session.end",
  "payload": {
    "sessionId": "session-..."
  }
}
```

服务端删除该会话，并向原会话参与方广播 `session.ended`。

`session.ended` 包含：

| 字段 | 说明 |
|---|---|
| `sessionId` | 被结束的会话 ID |
| `endedByEndpointId` | 发起结束的终端 ID |
| `reason` | 结束原因，当前支持 `requested` 和 `endpoint_disconnected` |
| `endedAt` | 结束时间 |

如果会话参与方的 WebSocket 连接异常关闭，服务端会删除该会话，并向剩余在线参与方广播 `reason` 为 `endpoint_disconnected` 的 `session.ended`。

### 4. 加入会话

在线终端发送 `session.join`：

```json
{
  "type": "session.join",
  "payload": {
    "sessionId": "session-..."
  }
}
```

如果会话人数已达到 `participantLimit`，服务端返回：

```json
{
  "type": "error",
  "payload": {
    "code": "participant_limit",
    "message": "participant limit reached"
  }
}
```

### 5. 离开会话

会话参与方发送 `session.leave`：

```json
{
  "type": "session.leave",
  "payload": {
    "sessionId": "session-..."
  }
}
```

服务端向离会方返回 `session.left`，并向剩余参与方广播 `session.updated`。如果离会后会话不足 2 人，服务端会结束该会话并广播 `reason` 为 `participant_left` 的 `session.ended`。

## 七、WebRTC 协商透传

会话参与方可以发送 `peer.signal`，用于在会话内透传 WebRTC offer、answer 或 ICE candidate。

```json
{
  "type": "peer.signal",
  "payload": {
    "sessionId": "session-...",
    "toEndpointId": "or-1",
    "signal": {
      "type": "offer",
      "sdp": "v=0"
    }
  }
}
```

服务端只做会话参与方校验和消息转发，不解析 SDP，不创建 PeerConnection，不转发媒体流。

目标终端会收到：

```json
{
  "type": "peer.signal",
  "payload": {
    "sessionId": "session-...",
    "fromEndpointId": "teach-1",
    "signal": {
      "type": "offer",
      "sdp": "v=0"
    }
  }
}
```

发送方会收到 `peer.signal.sent`。如果目标不在会话内，服务端返回 `target_not_in_session`。

## 八、当前边界

当前协议未实现以下生产能力：

1. 终端鉴权、权限模型和审计日志。
2. TLS、证书管理和跨网段安全接入。
3. 会话持久化、断线重连、心跳保活、自动重入会话和服务端高可用。
4. 音视频媒体协商、SFU 转发、SRT/RTSP 接入和手机直播分发。
5. 标注权限控制、版本控制和录像回放绑定。
6. HIS 患者信息绑定、录像文件索引和 AI 处理任务分发。

后续进入真实媒体服务阶段时，信令协议应扩展媒体发布、媒体订阅、ICE/SDP 或 SFU 房间控制字段，但控制面仍不应直接承载媒体数据。
