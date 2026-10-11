# 便携 Docker 部署

这一模式适合把同一个飞书机器人搬到新的 Linux 服务器，或在 Mac 的 Docker/OrbStack 中运行。源码由 Git 同步；机器专属内容只在被 Git 和 Docker 构建上下文忽略的 `.env.portable`、`.portable-data/` 中。迁移时只需这两项私有内容和同一版本的源码，不依赖原机器的绝对路径。

便携版使用 `docker-compose.portable.yml`，与现有生产用 `docker-compose.yml` **互不替换**。它保持飞书 WebSocket 长连接和单容器 Codex app-server，但不挂载宿主机根目录、不启用特权/host PID、不要求外部 Docker 网络。因而宿主机操作、自部署和小红书 MCP 不会在便携版中自动可用；需要这些能力时应单独设计最小权限的接入方式，不要直接恢复全盘挂载。

## 新机器首次启动

要求：Docker Engine + Compose 插件；Linux 或可运行 Linux 容器的 Mac。无需在宿主机安装 Node、pnpm 或 Codex。

```sh
git clone <本仓库地址> codex-feishu-bot
cd codex-feishu-bot
./scripts/portable.sh init
```

编辑 `.env.portable`，至少填写 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_ALLOWED_OPEN_IDS`。复用已有飞书应用时，应用须已启用机器人、WebSocket 长连接、`im.message.receive_v1` 订阅和所需 IM 权限。不要把真实 `.env.portable` 发到聊天、提交 Git 或放进镜像。

```sh
./scripts/portable.sh check
./scripts/portable.sh login   # 未设置 OPENAI_API_KEY 时，在终端完成 Codex 设备码登录
```

设备码登录是无浏览器服务器的推荐方式，但需要账号允许该方式；见 [OpenAI Docs 身份验证说明](https://learn.chatgpt.com/docs/auth)。也可在 `.env.portable` 中提供 `OPENAI_API_KEY`，容器启动时会在持久化的 Codex home 中建立登录状态。API key 使用的是 API 计费，不等同于 ChatGPT 订阅额度。

确认旧实例已停止监听同一个飞书应用后，再启动新实例：

```sh
./scripts/portable.sh up
./scripts/portable.sh smoke
./scripts/portable.sh status
```

健康端口仅绑定宿主机 `127.0.0.1`，飞书长连接不需要公网回调端口。`down` 只停止容器，不删除 `.portable-data/`；`logs` 可查看服务日志。

## 从现有云端 Docker 部署迁移

先在目标机器执行 `init`，把旧部署的私有环境值按字段填入 `.env.portable`。再通过安全通道复制以下内容；不要用 Git 或飞书聊天传递凭据：

| 旧部署来源 | 新部署目标 |
| --- | --- |
| `CODEX_WORKSPACE_HOST_PATH` 指向的运行工作目录 | `.portable-data/workspace/` |
| `CODEX_HOME_SOURCE` 指向的 Codex home（若使用文件式登录） | `.portable-data/codex-home/` |
| `GIT_SSH_HOST_PATH` 指向的 SSH 配置与密钥（如确需访问私有仓库） | `.portable-data/ssh/` |
| `MAIL_SECRETS_HOST_PATH` 指向的邮件密钥目录（如使用邮件流程） | `.portable-data/mail/` |
| `SPEECH_SECRETS_HOST_PATH` 指向的语音密钥目录（如使用转写） | `.portable-data/speech/` |

`.portable-data/workspace/` 包括聊天线程映射、项目文件和导出产物，不能仅复制源码。若旧 Codex 凭据保存在 OS keyring 而非 `auth.json`，不要指望复制目录后自动可用；在新容器内重新运行 `./scripts/portable.sh login`。将私有目录限制为仅部署用户可读，并保留独立备份。

复制整个 Codex home 时，还要检查其中的 `config.toml`、全局 Skill 和 MCP 配置是否引用了旧机器的绝对路径；无法迁移的路径应在新机上重新配置。不要把 OAuth 凭据文件、SSH 私钥或邮件/语音密钥放进公开迁移包。

切换时先停止旧实例，再运行目标机器的 `up` 和 `smoke`，最后用飞书私聊发一条测试消息。旧实例可保留以便回滚，但**不要让两个实例同时处理同一飞书应用的消息**。现有生产脚本的 `docker:down` 会带 `-v`，迁移切换时不要用它；若只需暂停旧实例，可在旧仓库中执行：

```sh
docker compose --env-file .env.real -f docker-compose.yml stop app
```

验证失败时可先停新实例，再在旧仓库执行 `docker compose --env-file .env.real -f docker-compose.yml start app` 回滚。

## 便携性与安全边界

- `.env.portable` 和 `.portable-data/` 已被 `.gitignore`、`.dockerignore` 排除。不要把它们打进镜像或上传到公开仓库。
- 镜像在目标机器原生构建，避免直接搬运与 CPU 架构不匹配的旧镜像。
- `CODEX_APP_SERVER_SANDBOX=danger-full-access` 只作用于未启用特权且没有宿主机根目录挂载的容器；仍应只给可信飞书用户授权，并谨慎放入其他宿主机路径。
- 便携版不包含宿主机级部署权限。需要访问业务仓库时，把仓库放进 `.portable-data/workspace/`，或另行配置受限的 Git/SSH 权限。
