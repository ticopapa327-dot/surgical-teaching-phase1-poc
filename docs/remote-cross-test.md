# 多机交叉验证说明

## 一、当前验证拓扑

本地手术室端为 118 Windows 11，默认地址为 `192.168.1.118`。117 Windows 终端作为 Windows 示教室端，137 麒麟终端作为国产系统示教室端。

118 负责运行 `npm run dev:lan`，提供：

- 前端页面：`http://192.168.1.118:5173/`
- 信令服务：`ws://192.168.1.118:7077/signal`
- 健康检查：`http://192.168.1.118:7077/health`

## 二、117 Windows 自动化验证

117 使用 SSH 隧道模式控制远程 Edge DevTools。117 不需要项目文件，也不要求对外开放 DevTools 端口。

在 118 执行：

```powershell
npm run test:remote:windows:probe
npm run test:remote:signal:tunnel
npm run test:remote:media:tunnel
npm run test:remote:audio:tunnel
npm run test:remote:diagnostics
npm run test:remote:audio:diagnostics
```

通过标准：

1. 信令 smoke 输出 `ok: true`。
2. 媒体 smoke 能完成 4 路订阅、发布、远端 live 检查和诊断分析。
3. 音频 smoke 至少验证 118 音频轨道可到达 117。
4. 测试结束后 `health` 中 `endpoints=0`、`sessions=0`、`pendingCalls=0`。

## 三、137 麒麟自动化验证

137 当前 SSHD 配置禁止端口转发，因此不能采用 117 的 SSH 隧道模式。现阶段使用临时 LAN DevTools 模式：118 通过 SSH 在 137 启动 headless 麒麟浏览器，并临时放行 137 的 `9334` 端口，仅允许 118 访问。

先做环境探测：

```powershell
npm run test:remote:kylin:probe
```

再设置 137 的 sudo 密码到当前 PowerShell 进程环境变量。不要写入仓库、脚本或文档：

```powershell
$env:UST_KYLIN_SUDO_PASSWORD = "<137 sudo 密码>"
npm run test:remote:kylin:signal:lan
npm run test:remote:kylin:media:lan
npm run test:remote:kylin:audio:lan
npm run test:remote:kylin:diagnostics
npm run test:remote:kylin:audio:diagnostics
Remove-Item Env:UST_KYLIN_SUDO_PASSWORD -ErrorAction SilentlyContinue
```

安全边界：

1. 默认不允许在没有临时防火墙规则的情况下暴露 137 DevTools。
2. 只有隔离测试网才允许设置 `UST_KYLIN_ALLOW_UNRESTRICTED_DEVTOOLS=true`。
3. 137 当前没有 Node/npm，自动化脚本运行在 118，只远程控制 137 浏览器。
4. 137 使用 Chromium 90 内核，后续若出现媒体能力差异，应按浏览器版本差异单独记录。

## 四、验收记录

每轮多机交叉验证至少记录：

- 执行日期和执行人。
- 118、117、137 的 IP 地址。
- 运行的命令。
- 生成的 `test-results` 目录。
- `health` 结束状态。
- 失败时保留诊断快照、控制台输出和远端浏览器版本。

当前阶段的结论必须以自动化输出和诊断快照为准，不以单纯“页面看起来正常”作为通过依据。

## 五、一键交叉验证

118 上可以用统一入口按顺序执行 117 与 137 的交叉验证，并生成 JSON 报告：

```powershell
$env:UST_KYLIN_SUDO_PASSWORD = "<137 sudo 密码>"
npm run test:remote:cross
Remove-Item Env:UST_KYLIN_SUDO_PASSWORD -ErrorAction SilentlyContinue
```

用于无人值守稳定性观察或阶段验收时，不应使用会跳过远端的普通口径，应使用严格入口。严格入口要求 117、137 和三端并发会议验证全部覆盖；如果 137 缺少临时授权、任一远端被跳过或三端会议未执行，报告必须失败：

```powershell
$env:UST_KYLIN_SUDO_PASSWORD = "<137 sudo 密码>"
npm run test:remote:cross:strict
Remove-Item Env:UST_KYLIN_SUDO_PASSWORD -ErrorAction SilentlyContinue
```

报告默认写入 `validation-results/cross-machine-validation/`，同时生成 JSON 原始报告、Markdown 摘要、SHA256 校验文件和 artifacts 归档目录。归档目录会复制本轮 117/137 环境探测快照、远程媒体/音频诊断 JSON 与 CSV，避免只保留易被清理的 `test-results` 路径。`validation-results` 不提交到仓库，只作为本地验证证据。

多轮验证后可生成本地索引，快速查看最近报告、失败步骤、重试次数和证据完整性：

```powershell
npm run test:remote:cross:index
```

如需临时跳过某台远端：

```powershell
$env:UST_CROSS_SKIP_WINDOWS_117 = "1"
$env:UST_CROSS_SKIP_KYLIN_137 = "1"
```

如要求 137 必须执行而不是因为缺少 sudo 密码跳过：

```powershell
$env:UST_CROSS_REQUIRE_KYLIN_137 = "1"
```

## 六、持续交叉验证

长时间无人值守测试不要直接手工反复执行单次命令，应使用持续验证入口保存总账：

```powershell
$env:UST_KYLIN_SUDO_PASSWORD = "<137 sudo 密码>"
npm run test:remote:cross:loop -- --iterations 12 --interval-seconds 300
Remove-Item Env:UST_KYLIN_SUDO_PASSWORD -ErrorAction SilentlyContinue
```

严格长期观察入口：

```powershell
$env:UST_KYLIN_SUDO_PASSWORD = "<137 sudo 密码>"
npm run test:remote:cross:loop:strict -- --iterations 12 --interval-seconds 300
Remove-Item Env:UST_KYLIN_SUDO_PASSWORD -ErrorAction SilentlyContinue
```

常用参数：

- `--once`：只执行 1 轮，用于快速验证脚本链路。
- `--iterations <次数>`：限制轮次；`0` 表示在设置 duration 时不限制轮次。
- `--duration-hours <小时>`：按时间限制运行，例如 7 小时或 16 小时。
- `--interval-seconds <秒>`：两轮之间的等待时间。
- `--cross-script <npm-script>`：指定每轮运行的交叉验证 npm script，例如 `test:remote:cross:strict`。
- `--stop-on-failure`：发现失败后立即停止，适合定位问题；稳定性观察阶段建议不启用，以便收集连续失败证据。
- `--skip-resource-index`：每轮结束后不刷新资源趋势索引，仅用于临时排障。
- `--skip-status-gate`：严格循环中不运行当前状态门禁，仅用于定位门禁脚本自身问题。

持续验证会在 `validation-results/cross-machine-validation/` 下生成 `continuous-*.json`、`continuous-*.md` 和 `continuous-*.sha256` 总账文件。总账记录每一轮对应的单次交叉验证报告、报告索引刷新结果、资源趋势索引刷新结果、严格状态门禁结果和命令输出尾部；单次报告由配置的交叉验证 npm script 生成，并继续由 `npm run test:remote:cross:index` 校验哈希和 artifact 完整性。严格循环默认还会在每轮写入总账后运行 `npm run test:remote:cross:status`，防止长稳测试只留下不满足严格门禁的报告。

持续验证完成后刷新总账索引：

```powershell
npm run test:remote:cross:loop:index
```

该索引会校验 `continuous-*.sha256`，并反查每个周期引用的单次交叉验证报告及其 SHA256 文件，防止长期测试后只保留了不可审计的文本结论。

长期验证期间还应生成资源趋势索引：

```powershell
npm run test:remote:cross:resources -- --strict-only
```

该索引会读取严格交叉验证报告中的 118 本机资源快照，并从 artifact 中反查 117 Windows、137 麒麟探针资源快照，汇总每台机器的内存最低值、最新值、CPU 峰值、磁盘剩余空间和资源告警。该索引用于定位长稳测试期间的资源趋势，不等同于正式性能验收；如需把资源告警作为自动化失败条件，可增加 `--fail-on-warn`。

长期测试期间还应定期执行当前状态门禁：

```powershell
npm run test:remote:cross:status
```

该命令只认可最新的严格持续验证台账，默认要求最近一次严格台账不超过 720 分钟，并反查其引用的严格单次报告。检查内容包括：台账 SHA256、单次报告 SHA256、artifact manifest 和文件哈希、`strictRemoteCoverage` 配置、117/137/三端会议必需步骤、118 本机资源前后快照、117/137 探针资源快照、报告健康清理状态。若只存在普通交叉验证报告、严格台账过期、三端会议被跳过、任一机器资源漏采或任何证据损坏，该命令返回非零退出码。

如只需要离线审计旧报告，可临时关闭新鲜度检查：

```powershell
npm run test:remote:cross:status -- --max-age-minutes 0
```

## 七、三端并发会议验证

顺序验证 117 和 137 只能证明两台远端分别可用，不能证明会议模式下多个远端同时接入同一手术室会话时订阅、媒体发布和清理逻辑可靠。因此在 117 与 137 均可用、且 137 已提供临时防火墙授权时，可执行三端并发 smoke：

```powershell
$env:UST_KYLIN_SUDO_PASSWORD = "<137 sudo 密码>"
npm run test:remote:conference:lan
Remove-Item Env:UST_KYLIN_SUDO_PASSWORD -ErrorAction SilentlyContinue
```

该用例会在 118 本机创建手术室端，在 117 创建示教室端，在 137 创建观摩端。117 加入同一会话后订阅通道 1 和通道 2，137 加入同一会话后订阅通道 1；118 发布订阅通道媒体后，脚本要求 117 至少收到 2 路 live 远端视频，137 至少收到 1 路 live 远端视频，并保存三端诊断快照。

通过标准：

1. 118 会话参与数量达到 `3 / 3`。
2. 117 和 137 均加入同一个会话 ID。
3. 117 的远端视频 live 数量不低于 2，137 的远端视频 live 数量不低于 1。
4. 三端诊断快照通过 `diagnostics:analyze` 的 fail-on-warn 检查。
5. 用例退出后 `/health` 返回 `endpoints=0`、`sessions=0`、`pendingCalls=0`。

`npm run test:remote:cross` 会在 117、137 单机 smoke 均通过时自动追加该三端并发用例；如果任一前置验证失败，三端用例会以 skipped 记录到报告中，避免把基础连接问题误判为会议模式问题。

严格交叉验证报告会同时记录 118 本机验证前后的 CPU、内存、磁盘和关键进程摘要；117 Windows、137 麒麟的资源摘要分别随各自环境探针写入 artifact。该数据只作为工程诊断依据，不等同于最终性能验收指标；正式指标仍需要在真实 USB 采集源、真实音频设备和约定时长下单独压测。
