# 测试报告邮件发送说明

## 一、当前结论

本项目测试报告邮件发送不使用项目内 SMTP 凭据，也不要求在本项目创建 `.env.local` 保存邮箱密码。

默认发送方式采用本机记忆中已经建立的跨项目邮件发送规程：

- 通用入口：`C:\Users\wangm\.codex\tools\send-default-mail.ps1`
- 默认收件人：`2012@mvbs.com.cn`
- 发送通道：`sh-medvision.com` 服务器侧已有邮件配置
- SMTP 配置来源：服务器本地 `/www/wwwroot/sh-medvision.com/api/contact-config.php`
- 凭据规则：不得读取、打印、提交或复制 SMTP 密码/授权码

本项目的 `scripts/send-test-report-email.cjs` 只是 UST 测试报告包装器，负责选择报告文件、拼接正文和附件，然后调用上述通用入口。

## 二、发送命令

发送默认交叉验证报告：

```powershell
npm run test:remote:cross:email
```

发送指定报告文件或目录：

```powershell
npm run test:report:email -- --report "D:\CodeX\UST\phase1-poc\validation-results\cross-machine-validation\index.md"
```

使用本地经典 Outlook 客户端发送指定报告：

```powershell
npm run test:report:email -- --transport outlook --from "wangmaohua0303@outlook.com" --report "D:\CodeX\UST\phase1-poc\validation-results\local-118-validation"
```

该方式依赖本机已安装经典 Outlook 桌面版并注册 `Outlook.Application` COM 接口，且 Outlook 配置中存在对应发件账户。新版 Outlook 应用包或网页版容器通常不提供该 COM 自动发送接口。当前开发验证不把 Outlook 账户配置作为门禁；只有显式传入 `--transport outlook` 时才会调用本地 Outlook。

使用本地 Foxmail 客户端发送指定报告：

```powershell
npm run test:report:email -- --transport foxmail --from "2012@mvbs.com.cn" --report "D:\CodeX\UST\phase1-poc\validation-results\local-118-validation"
```

该方式通过 Windows Simple MAPI 调用本机默认邮件客户端。Foxmail 必须已配置 `2012@mvbs.com.cn` 账户；MAPI 会提交 originator，但实际发件账户仍由 Foxmail 当前默认账户和客户端策略决定。若命令超时，表示 Foxmail 未完成后台发送，不能按已发出处理；此时应改用人工确认的 Foxmail 写信窗口或恢复服务器侧 SMTP/API 通道。当前开发验证不自动配置或启动 Foxmail；只有显式传入 `--transport foxmail` 时才会调用本地 Foxmail/MAPI。

附加截图或日志：

```powershell
npm run test:report:email -- --report "D:\CodeX\UST\phase1-poc\validation-results\cross-machine-validation" --attach "D:\OneDrive\UST-test\screenshot.png"
```

只检查发送计划、不实际发信：

```powershell
npm run test:report:email -- --report validation-results/cross-machine-validation --dry-run
```

## 三、执行边界

邮件正文默认读取报告文本，并将报告文件作为附件。截图、压缩包、日志等额外证据需通过 `--attach` 明确指定。

如果未指定收件人，使用 `2012@mvbs.com.cn`。如果要临时发给其他人，可使用：

```powershell
npm run test:report:email -- --to "name@example.com" --report validation-results/cross-machine-validation
```

默认通用入口当前只按单收件人发送；多收件人应分次执行，避免 SMTP RCPT/MIME 兼容性问题。

## 四、失败处理

如果通用入口返回成功，按返回结果汇报。

如果返回已知错误 `SMTP unexpected response: 501 Bad address syntax`，不要更换收件人、不要重做附件、不要改写测试报告；应保留同一服务器侧配置，切换到已验证过的简化 SMTP/MIME fallback。

如果 SSH、服务器配置文件或 SMTP 服务不可用，应报告具体阻塞点，并停止保存任何凭据类信息。
