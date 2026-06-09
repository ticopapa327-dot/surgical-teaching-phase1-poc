# 贡献说明

## 一、开发环境

建议使用 Node.js 22 或更高版本。

```powershell
npm install
npm run dev
```

单独启动信令服务：

```powershell
npm run server:signaling
```

## 二、提交前验证

提交前必须运行：

```powershell
npm run verify
```

该命令会执行构建、高危依赖审计、前端烟测和信令契约测试。

## 三、范围要求

1. 不要把 PoC 中的模拟能力描述为生产能力。
2. 真实媒体服务、真实 HIS、FTP、云台控制、Android 客户端和手机直播尚未实现。
3. 涉及患者信息、录像文件和 AI 处理结果的改动必须明确隐私、权限和审计边界。
4. 新增信令消息必须同步更新 `docs/signaling-protocol.md` 和自动化测试。
5. 新增 UI 工作流必须补充 Playwright 测试。

## 四、代码提交

提交应保持小步、可验证。推荐提交信息使用简洁英文动词短语，例如：

```text
Add recording export workflow
Test incoming signaling calls
```

不要提交 `node_modules`、`dist`、测试报告或本地录像文件。
