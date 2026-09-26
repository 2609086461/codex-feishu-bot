# AI 快速配置指南

这份文档供 Codex、WorkBuddy 或具备终端与浏览器自动化能力的编码代理读取。
目标是在不暴露凭据的前提下，完成一个独立的飞书 Codex 机器人部署。

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

## 需要先确认的一个问题

只询问用户：是否创建新的飞书机器人？

- 回答“创建”：按 `docs/codex-bootstrap-playbook.md` 创建新的企业自建应用。
- 回答“不创建”：复用用户指定的已有应用；候选不唯一时让用户选择。

不要在这个问题之外重复询问可以从仓库、环境或飞书控制台自行确认的信息。

## 执行顺序

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
