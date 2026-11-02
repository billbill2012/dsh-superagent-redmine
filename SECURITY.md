# 安全策略

**中文** | [English](SECURITY.en.md)

## 支持范围

当前维护 `0.1.x`。

## 报告漏洞

- 优先使用 GitHub 的 **Private vulnerability reporting / Security Advisory**（仓库 → Security → Report a vulnerability）。
- 或邮件联系维护者：`billbill@foxmail.com`。请不要先公开 issue。

请附上：影响版本、复现步骤、是否涉及凭据或数据写入、你建议的修复方向。我们会在 7 天内确认。

## 这个插件的安全模型

- **API Key 只从环境变量读取**（默认 `REDMINE_API_KEY`），设置数据库里只保存变量名，不存密钥明文。
- **最小权限**：专用 Redmine 账号只需该项目的「查看问题 + 添加评论」；不要用管理员账号。
- **只能写评论**：回写请求体固定为 `{ issue: { notes } }`，永远不会改状态、指派人或自定义字段。
  `writeBack=off` 时不会发出任何写请求。
- **幂等**：回写正文带隐藏标记 `<!-- dsh-redmine:<messageId> -->`，重试不会产生重复评论。（这是线上协议字符串；改目录名时不要改它。）
- **图片下载**：只接受消息文本里出现的附件 key，不接受任意远程 URL；字节数受部署上限约束。
- **HTTP 风险**：`http://` 部署下 API Key 明文传输，只应在内网/VPN 使用；有条件时在反向代理上终止 TLS。

## 凭据泄露处理

如果 Key 曾经进入聊天记录、日志、截图或提交：

1. 立即在 Redmine「我的账号 → API 访问键」点 **重置**，旧 Key 立即失效；
2. 用新 Key 更新启动环境（launchd/plist/tmux/CI secret）；
3. 如果是仓库历史泄露，按 GitHub 的 secret scanning 提示清理历史，并评估是否需要重写提交。

## 依赖

运行时只依赖 `zod`（MIT）与 Node 内置模块；`@deepseek-ai/cordis` 仅用于类型（`import type`），不进入构建产物。
