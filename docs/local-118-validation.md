# 118 本机验证说明

## 目标

当前放弃修复 137 后，日常开发验证默认先在 118 本机闭环。本机验证只覆盖代码构建、脚本测试、前端 smoke、信令契约和本机资源快照，不代表 117、137、Android 会议平板或手机直播链路通过。

## 命令

完整本机验证：

```powershell
npm run test:local:118
```

快速脚本验证：

```powershell
npm run test:local:118:quick
```

读取最近一次完整本机验证状态：

```powershell
npm run test:local:118:status
```

读取最近一次快速脚本验证状态：

```powershell
npm run test:local:118:status:quick
```

完整命令默认执行：

1. `npm run build`
2. `npm run test:scripts`
3. `npm run test:smoke`
4. `npm run test:signaling`

如需同时做高危依赖审计：

```powershell
npm run test:local:118 -- --include-audit
```

## 输出

报告写入：

```text
validation-results/local-118-validation/
```

每次运行生成：

- `<timestamp>.json`：结构化报告、命令尾部输出、118 本机资源快照。
- `<timestamp>.md`：人工阅读摘要。
- `<timestamp>.sha256`：JSON 报告哈希。

状态门禁会额外生成：

- `status.json`：最近一次完整本机验证的机器可读状态。
- `status-quick.json`：最近一次快速脚本验证的机器可读状态。

状态门禁默认校验：

1. 最新匹配报告的 `.sha256` 与 JSON 内容一致。
2. 完整模式包含并通过 `build`、`script-tests`、`ui-smoke`、`signaling-contract`。
3. 快速模式包含并通过 `script-tests`。
4. 报告不是 `--dry-run` 结果。
5. 本机地址列表包含 `192.168.1.118`。
6. 验证前后 CPU 采样未超过 80%。

## 边界

- 不访问 137，不验证三端会议。
- 不要求 117 在线。
- 不验证真实 117 麦克风。
- 不替代 `npm run test:remote:cross:status` 严格跨机验收。
- 状态门禁只读取最近的匹配报告，不会自动启动摄像头、远端机器或邮件客户端。
- 若需要真实 USB 摄像头长稳测试，仍使用专门的真实 USB 脚本，并保持 CPU 超过 80% 时降载或停止。
