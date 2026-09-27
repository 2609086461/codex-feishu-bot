# Codex Bootstrap Prompt

Copy this prompt into Codex after opening or cloning the repository:

```text
严格按 README.md、AGENTS.md、AI_SETUP.md、docs/codex-bootstrap-playbook.md 和 docs/feishu-console-automation.md 执行，不要把普通控制台配置步骤推回给我。先问我机器人最终运行在当前 Windows 电脑，还是 Linux 云服务器；不要把两套命令混用。然后问我要创建新的机器人还是使用我指定的已有机器人。登录、扫码和管理员审批由我完成，其余配置由你继续。

Windows 模式：取得 App ID 和本人 Open ID 后，使用 scripts/setup-local-bot.ps1，按当前电脑真实路径设置 Workspace 和 CodexHomeSource，最后运行 doctor-local-bot.ps1 -RequireRunning 并做飞书私聊验收。

云端模式：运行 pnpm install、pnpm bootstrap:env 和 pnpm chrome:debug；完成飞书控制台配置后把凭据写入私有 .env.real，再用 Docker 启动并运行 pnpm docker:smoke。不要显示或提交密钥。最后告诉我实际运行位置、自动启动方式、暂停/恢复方式和飞书私聊验收结果。
```
