# 软件架构说明

## 一、当前 PoC 架构

```mermaid
flowchart LR
  OR["手术室端 Electron/React 客户端"]
  Teaching["示教室端/观摩端客户端"]
  Signaling["WebSocket 信令服务"]
  Recording["本地录像存储与索引"]
  MockHIS["模拟 HIS 数据"]
  AIQueue["本地模拟 AI 队列"]
  FutureMedia["后续媒体服务 SFU/RTSP/SRT/直播"]

  OR <-->|"endpoint.register / call / session / peer.signal"| Signaling
  Teaching <-->|"endpoint.register / call / session / peer.signal"| Signaling
  OR <-->|"WebRTC P2P 按订阅多通道视频"| Teaching
  OR -->|"MediaRecorder 写入"| Recording
  OR -->|"模拟查询"| MockHIS
  OR -->|"录像任务入队"| AIQueue
  OR -.->|"后续接入 SFU/直播媒体服务"| FutureMedia
  Teaching -.->|"后续多方订阅媒体"| FutureMedia
```

## 二、职责划分

| 模块 | 当前职责 | 不承担的职责 |
|---|---|---|
| 前端客户端 | 4 路本地预览、录制、回放、信令控制、按订阅 WebRTC P2P 多通道视频 PoC、患者绑定、AI 队列入口 | 生产级媒体转发、SFU、多方直播 |
| Electron 主进程 | 本地录像文件写入、索引、定位、导出 | HIS、FTP、AI 服务调用 |
| 信令服务 | 注册、在线目录、会话目录、呼叫、会话、订阅、标注、结束、断连清理、可选共享令牌门禁、内存事件日志、`peer.signal` 透传 | 音视频媒体转发、生产级鉴权、持久化审计 |
| 模拟 HIS | 验证患者绑定流程 | 真实医院系统联网 |
| 模拟 AI 队列 | 验证 AI 任务入口 | 模型推理和医学结论 |

## 三、后续生产化拆分

生产化不应把所有能力塞进手术室端单机进程。建议拆分为：

1. 客户端：手术室端、示教室端、Android 会议平板端、手机直播观看端。
2. 信令服务：控制面、鉴权、会话、通讯录。
3. 媒体服务：WebRTC/SFU、RTSP/SRT 接入、直播分发。
4. 文件服务：录像归档、导出、FTP 或对象存储上传。
5. 集成服务：HIS、PACS、AI 任务、审计。

## 四、当前关键边界

当前 PoC 已验证手术室端可按远端订阅，通过 `peer.signal` 完成浏览器 WebRTC P2P 多通道视频协商和显示。该能力仍不是生产媒体服务：真实 USB 4 路长稳运行、延迟、码率、同步、丢包恢复、回声消除、多方会议、TURN 中继和 SFU 转发必须另行验证。
