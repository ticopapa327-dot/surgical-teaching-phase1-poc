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
| HTTP | `http://127.0.0.1:7077/sessions` | 在线会话摘要快照 |
| HTTP | `http://127.0.0.1:7077/events` | 控制面事件日志快照 |

服务端口可通过 `SIGNALING_PORT` 环境变量覆盖。
如设置 `SIGNALING_AUTH_TOKEN`，客户端注册时必须在 `endpoint.register.payload.authToken` 中提交相同令牌。HTTP `/directory`、`/sessions` 和 `/events` 也必须通过 `Authorization: Bearer <token>` 或 `?authToken=<token>` 提交令牌；`/health` 保持公开，只返回计数。该令牌只作为 PoC 共享入口门禁，不替代 TLS、用户身份、权限模型或审计。
事件日志为内存环形日志，默认保留最近 200 条，可通过 `SIGNALING_EVENT_LOG_LIMIT` 调整到 20 至 1000 条之间。事件只记录控制面摘要，不记录令牌、患者信息、标注正文或媒体数据。
服务端会按 `SIGNALING_HEARTBEAT_MS` 周期向 WebSocket 客户端发送 ping，默认 30000 ms；客户端未响应 pong 时服务端会终止连接，并按断线清理在线目录、待处理呼叫和会话。将该值设为 `0` 可关闭 PoC 心跳。

`/health` 返回 `ok`、`endpoints`、`sessions` 和 `pendingCalls`，用于基础运行状态检查。
`/sessions` 返回当前在线信令会话摘要，只包含会话 ID、模式、参与上限、参与端 ID、参与人数和开始时间，不包含标注内容、通道订阅详情、患者信息或媒体房间数据。

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
    "authToken": "optional-shared-token",
    "capabilities": ["call-control", "publish-video", "subscribe-video"],
    "channels": [
      { "id": "ch1", "label": "Panorama", "role": "overview" },
      { "id": "ch2", "label": "Surgical Field", "role": "field" }
    ]
  }
}
```

服务端返回 `endpoint.registered`，并向所有在线终端广播 `directory.updated`。如果服务端启用了 `SIGNALING_AUTH_TOKEN` 且客户端未提交正确 `authToken`，服务端返回 `unauthorized` 错误，不会注册该终端。

注册字段会被服务端归一化：`endpointId`、`name`、`address` 必须是非空字符串，否则使用安全默认值；`role` 仅接受 `operating-room`、`teaching-room`、`observer`，非法值回落为 `observer`；`capabilities` 会过滤非字符串、空值和重复值；`channels` 只接受对象项，并对 `id`、`label`、`role` 做默认值和长度限制。

如果新的 WebSocket 使用已在线的 `endpointId` 注册，新连接会接管该终端 ID，旧连接会收到：

```json
{
  "type": "endpoint.replaced",
  "payload": {
    "endpointId": "or-1",
    "replacedAt": "2026-06-10T00:00:00.000Z"
  }
}
```

随后旧连接会被服务端关闭，目录中只保留新连接对应的一个终端。

如果该 `endpointId` 已经处于某个会话中，新连接完成注册后还会收到 `session.resumed`：

```json
{
  "type": "session.resumed",
  "payload": {
    "session": {
      "sessionId": "session-...",
      "mode": "interactive",
      "participants": ["or-1", "teach-1"]
    }
  }
}
```

客户端应据此恢复会话状态。当前恢复只覆盖控制面状态，不代表音视频媒体已经自动重连。

### 2. 获取目录

已注册终端发送 `endpoint.list` 后，服务端返回 `directory.snapshot`。未注册连接调用该消息会返回 `not_registered`。

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

### 3. 获取会话目录

已注册终端可以发送 `session.list` 获取当前在线会话摘要。

```json
{
  "type": "session.list"
}
```

服务端返回 `session.snapshot`：

```json
{
  "type": "session.snapshot",
  "payload": {
    "sessions": [
      {
        "sessionId": "session-...",
        "mode": "interactive",
        "ownerEndpointId": "or-1",
        "participantLimit": 4,
        "participantCount": 2,
        "participants": ["or-1", "teach-1"],
        "startedAt": "2026-06-10T00:00:00.000Z"
      }
    ]
  }
}
```

会话创建、参与方加入、参与方离开或会话结束后，服务端会向在线终端广播 `sessions.updated`，载荷结构与 `session.snapshot` 一致。该目录用于观摩端发现可加入会议，不代表媒体房间已经可用，也不承载完整会议状态。

### 4. 获取控制面事件日志

HTTP `/events` 返回最近控制面事件摘要：

```json
[
  {
    "eventId": "event-...",
    "type": "session.started",
    "at": "2026-06-10T00:00:00.000Z",
    "sessionId": "session-...",
    "mode": "interactive",
    "participantLimit": 4,
    "participants": ["or-1", "teach-1"]
  }
]
```

当前事件日志只用于 PoC 调试和验收追踪，不提供不可抵赖审计、持久化、签名、防篡改或权限分级。

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
`participantLimit` 会被限制在 2 到 16 之间；如果传入值不是有效数字，服务端按 2 处理。
发起方不能呼叫自己的 `endpointId`，服务端会返回 `self_call_forbidden`。
如果发起方或目标方已有待处理呼叫，或已经处于某个会话中，服务端返回 `endpoint_busy`，不会创建新的待处理呼叫。
待处理呼叫会包含 `expiresAt`。默认 60 秒内未接受、拒绝或取消时，服务端会向双方发送 `call.canceled`，其中 `reason` 为 `timeout`。默认超时时间可通过 `SIGNALING_CALL_TIMEOUT_MS` 环境变量覆盖。

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
会话 `ownerEndpointId` 优先指向手术室端，用于表达会议参与上限和后续控制权归属；如果双方都不是手术室端，则回退为接收方。

### 3. 拒绝呼叫

接收方发送 `call.reject` 后，服务端向双方发送 `call.rejected`。

### 4. 取消呼叫

发起方发送 `call.cancel`：

```json
{
  "type": "call.cancel",
  "payload": {
    "callId": "call-..."
  }
}
```

服务端向双方发送 `call.canceled`。如果待处理呼叫中的任一终端断开连接，服务端也会发送 `reason` 为 `endpoint_disconnected` 的 `call.canceled`。

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
订阅通道会被归一化：只保留非空字符串，去重，单个通道 ID 最长 32 个字符；如果没有有效通道，默认回落为 `ch1`。

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

服务端删除该会话，并向原会话参与方广播 `session.ended`。多人会话中只有 `ownerEndpointId` 对应的会话控制方可以结束整场会议；其他参与方应使用 `session.leave` 离开。两人会话中任一方结束连接都会结束会话。

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

如果当前终端已有待处理呼叫，或已经处于另一个会话中，服务端返回 `endpoint_busy`，不会把同一终端加入多个会话。

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

服务端向离会方返回 `session.left`，并向剩余参与方广播 `session.updated`。如果离会方是 `ownerEndpointId` 对应的会话控制方，服务端会结束该会话并广播 `reason` 为 `owner_left` 的 `session.ended`；如果离会后会话不足 2 人，服务端会结束该会话并广播 `reason` 为 `participant_left` 的 `session.ended`。

## 七、WebRTC 协商透传

会话参与方可以发送 `peer.signal`，用于在会话内透传 WebRTC offer、answer、ICE candidate 或轻量媒体控制消息。

```json
{
  "type": "peer.signal",
  "payload": {
    "sessionId": "session-...",
    "toEndpointId": "or-1",
    "signal": {
      "kind": "media-offer",
      "channelId": "ch1",
      "description": {
        "type": "offer",
        "sdp": "v=0"
      }
    }
  }
}
```

服务端只做会话参与方校验和消息转发，不解析 SDP，不创建 PeerConnection，不转发媒体流。

当前前端使用的 `signal.kind` 约定如下：

| kind | 方向 | 说明 |
|---|---|---|
| `media-offer` | 媒体发布端到接收端 | 携带 `channelId` 和 WebRTC offer description；当前可包含通道 1 视频轨道和交互音频轨道。 |
| `media-answer` | 媒体接收端到发布端 | 携带 `channelId` 和 WebRTC answer description；交互模式下可包含应答端本地音频轨道。 |
| `ice` | 双向 | 携带 ICE candidate。 |
| `media-stop` | 双向 | 通知对端清理当前 PoC 媒体链路。 |

目标终端会收到：

```json
{
  "type": "peer.signal",
  "payload": {
    "sessionId": "session-...",
    "fromEndpointId": "teach-1",
    "signal": {
      "kind": "media-offer",
      "channelId": "ch1",
      "description": {
        "type": "offer",
        "sdp": "v=0"
      }
    }
  }
}
```

发送方会收到 `peer.signal.sent`。如果目标不在会话内，服务端返回 `target_not_in_session`。

## 八、错误码

服务端错误统一使用：

```json
{
  "type": "error",
  "requestId": "optional-request-id",
  "payload": {
    "code": "endpoint_busy",
    "message": "caller or target endpoint is busy"
  }
}
```

当前错误码：

| code | 触发条件 |
|---|---|
| `bad_message` | 消息不是合法 JSON 或缺少 `type` |
| `not_registered` | 连接尚未完成 `endpoint.register` |
| `target_offline` | 呼叫目标终端不在线 |
| `self_call_forbidden` | 终端尝试呼叫自己的 `endpointId` |
| `endpoint_busy` | 发起方或目标方已有待处理呼叫，或已经处于会话中 |
| `call_not_found` | `call.accept`、`call.reject` 或 `call.cancel` 指向的待处理呼叫不存在或无权操作 |
| `session_not_found` | 目标会话不存在，或当前终端不是会话参与方 |
| `annotation_forbidden` | 非手术室端尝试更新会话标注 |
| `session_end_forbidden` | 非会话控制方尝试结束多人会话 |
| `target_not_in_session` | `peer.signal` 的目标终端不在当前会话中 |
| `bad_signal` | `peer.signal` 缺少有效 signal 负载 |
| `participant_limit` | 会话参与人数已达到上限 |
| `unauthorized` | 服务端启用共享令牌后，注册消息未提交正确 `authToken` |
| `unknown_type` | 消息类型不在当前协议支持范围内 |

## 九、当前边界

当前协议未实现以下生产能力：

1. 生产级终端鉴权、权限模型和审计日志；当前共享令牌只用于 PoC 门禁。
2. TLS、证书管理和跨网段安全接入。
3. 会话持久化、断线自动重连、自动重入会话和服务端高可用。
4. 音视频媒体协商、SFU 转发、SRT/RTSP 接入和手机直播分发。
5. 标注权限控制、版本控制和录像回放绑定。
6. HIS 患者信息绑定、录像文件索引和 AI 处理任务分发。

后续进入真实媒体服务阶段时，信令协议应扩展媒体发布、媒体订阅、ICE/SDP 或 SFU 房间控制字段，但控制面仍不应直接承载媒体数据。
