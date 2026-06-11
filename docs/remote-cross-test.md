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

报告默认写入 `validation-results/cross-machine-validation/`，同时生成 JSON 原始报告、Markdown 摘要、SHA256 校验文件和 artifacts 归档目录。归档目录会复制本轮远程媒体/音频诊断 JSON 与 CSV，避免只保留易被清理的 `test-results` 路径。`validation-results` 不提交到仓库，只作为本地验证证据。

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

常用参数：

- `--once`：只执行 1 轮，用于快速验证脚本链路。
- `--iterations <次数>`：限制轮次；`0` 表示在设置 duration 时不限制轮次。
- `--duration-hours <小时>`：按时间限制运行，例如 7 小时或 16 小时。
- `--interval-seconds <秒>`：两轮之间的等待时间。
- `--stop-on-failure`：发现失败后立即停止，适合定位问题；稳定性观察阶段建议不启用，以便收集连续失败证据。

持续验证会在 `validation-results/cross-machine-validation/` 下生成 `continuous-*.json`、`continuous-*.md` 和 `continuous-*.sha256` 总账文件。总账记录每一轮对应的单次交叉验证报告、索引刷新结果和命令输出尾部；单次报告仍由 `npm run test:remote:cross` 生成，并继续由 `npm run test:remote:cross:index` 校验哈希和 artifact 完整性。

持续验证完成后刷新总账索引：

```powershell
npm run test:remote:cross:loop:index
```

该索引会校验 `continuous-*.sha256`，并反查每个周期引用的单次交叉验证报告及其 SHA256 文件，防止长期测试后只保留了不可审计的文本结论。
