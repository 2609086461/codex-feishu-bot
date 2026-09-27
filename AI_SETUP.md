# Codex 飞书机器人：AI 配置与维护指南

这份文档供 Codex、WorkBuddy 或具备终端与浏览器自动化能力的编码代理读取。
目标是在不暴露凭据的前提下，完成一个独立的飞书 Codex 机器人部署。

本项目只负责“飞书消息与 Codex 的对话桥接”，不包含秋招看板、邮箱同步或求职数据。

## 先判断运行位置

用户在 Windows 电脑上使用 Codex/WorkBuddy、希望机器人也在这台电脑运行时，走下方的 **Windows 本地模式**。用户要把机器人放在 Linux 服务器，或明确选择 Docker 时，才走后面的 **云端 Docker 模式**。本地 Codex 帮用户操作服务器，不代表运行位置是本地；先确认最终运行位置。

### Windows 本地模式

先检查现有 Codex 登录、Node.js、pnpm、PowerShell 和飞书应用状态，按照 `AGENTS.md`、`docs/codex-bootstrap-playbook.md`、`docs/feishu-console-automation.md` 建立或复用用户指定的飞书应用。登录、扫码、审批留给用户；普通页面配置由代理处理。默认只允许用户私聊。

本地服务使用 `scripts/configure-local-bot.ps1`、`scripts/start-local-bot.ps1`，可选 `scripts/install-local-bot-task.ps1` 实现 Windows 用户登录后自动启动。**不要直接照搬脚本现有配置**：`configure-local-bot.ps1` 里的 `DEFAULT_WORKSPACE` 目前带有维护者电脑的固定路径，必须先根据用户电脑上的真实目录修正，并确认 `CODEX_HOME_SOURCE`、Codex 可执行文件和允许用户 open ID 均正确。脚本加密保存飞书 App Secret；不得把明文写进仓库或对话。

Windows 本地模式不需要 Docker，也不要执行下方的 `pnpm docker:*`。构建后用 Windows 启动脚本运行，检查本地服务健康；最终让用户从飞书私聊发普通消息和 `项目` 验收。若用户希望已有电脑端项目出现在列表里，要检查机器人能否访问原项目真实路径和 Codex 会话目录，不要只凭同一账号推断文件已共享。

### 云端 Docker 模式

以下完成标准、命令和 `.env.real` 说明适用于云端 Docker 模式，不应原样套到 Windows 本地模式。

## 实际运行机制

```text
飞书私聊/群聊
  -> 飞书 WebSocket 长连接推送 im.message.receive_v1
  -> Node 服务校验用户、解析消息和附件
  -> 容器内托管的 codex app-server 启动或续接线程
  -> Codex 在独立 /workspace 中使用终端和工具完成任务
  -> Node 服务把进度卡片、最终答复和文件发回飞书
```

- 不要求公网回调地址；消息事件和卡片点击都走飞书长连接。
- 每个聊天保存自己的线程、模型和工作区选择；运行状态持久化后可跨重启恢复。
- 源码目录和 Codex 的 `/workspace` 分开，避免机器人修改自己的部署仓库。
- “模型”菜单实时读取当前 Codex 账号可用模型，不维护固定模型白名单。

## 完成标准

配置结束时应满足：

- 飞书企业自建应用已启用机器人能力。
- 事件接收方式为长连接，并订阅 `im.message.receive_v1`。
- 应用已经获得必要的即时消息权限并发布可用版本。
- 真实凭据只写入未跟踪的 `.env.real`。
- `app` Docker 容器健康，`pnpm docker:smoke` 通过。
- 获准的飞书用户可以在私聊中向机器人发送消息并收到回复。

## 安全边界

- 开始前阅读 `AGENTS.md`、`README.md`、`SECURITY.md` 和
  `docs/codex-bootstrap-playbook.md`。
- 不打印、提交或上传 `.env.real`、OpenAI/Codex 登录态、飞书密钥、SSH 密钥、
  浏览器配置目录、聊天快照和用户工作区。
- 不把整个源码仓库挂载为运行时 `/workspace`。
- 不在没有用户确认时开放群聊、扩大允许用户列表或覆盖已有飞书应用。
- 遇到登录、SSO、2FA、管理员审批或多个候选应用无法判断时暂停，让用户完成或选择；
  其他普通控制台配置继续由代理完成。

## 需要先确认的一个问题（云端 Docker）

只询问用户：是否创建新的飞书机器人？

- 回答“创建”：按 `docs/codex-bootstrap-playbook.md` 创建新的企业自建应用。
- 回答“不创建”：复用用户指定的已有应用；候选不唯一时让用户选择。

不要在这个问题之外重复询问可以从仓库、环境或飞书控制台自行确认的信息。

## 执行顺序（云端 Docker）

在仓库根目录运行：

```bash
pnpm install
pnpm bootstrap:env
pnpm chrome:debug
```

然后：

1. 检查本机是否已有可用的 Codex 登录态。优先把该目录作为
   `CODEX_HOME_SOURCE`；只有没有登录态时才选择 `OPENAI_API_KEY`。
2. 使用可用的浏览器或 Chrome CDP 自动化飞书开放平台，达到
   `docs/feishu-console-automation.md` 描述的目标状态。
3. 把取得的 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 以及允许使用机器人的
   open ID 写入 `.env.real`，不要在对话或日志中回显值。
4. 保持 `FEISHU_ALLOW_GROUP_MESSAGES=false`，除非用户明确要求群聊。
5. 启动并验证：

```bash
pnpm docker:up
pnpm docker:smoke
```

6. 让用户在飞书私聊机器人发送一条普通消息，确认收发正常。

## 推荐交给代理的提示词

```text
请把当前仓库配置成我自己的飞书 Codex 机器人。先完整阅读 AI_SETUP.md、
AGENTS.md、README.md、SECURITY.md、docs/codex-bootstrap-playbook.md 和
docs/feishu-console-automation.md。只先问我是否创建新的飞书机器人；随后尽量
自行完成依赖安装、环境文件、浏览器自动化、飞书应用配置、Docker 启动和验收。
只有登录、SSO、2FA、管理员审批或候选应用无法判断时再让我介入。不要显示或提交
任何密钥，不要把源码仓库当作运行时工作区，最后给出飞书私聊验收结果。
```

## 后续维护

- 聊天内模型列表以当前账号和 Codex app-server 返回的实时列表为准，不要写死。
- CLI 更新提醒可以按 `docs/codex-cli-updates.md` 安装；它只提醒，不自动升级。
- 云端机器人从容器内更新自己时，必须使用 `/usr/local/bin/self-deploy`，不要直接
  运行 `docker compose up` 替换当前容器。
- 修改共享 TypeScript 后运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。
- 机器人源码通过本仓库的 GitHub Release 发布；发现新版只提醒，用户确认后才更新。
- 机器人代码更新和 Codex CLI 更新是两条独立通道，均不得静默升级。
