# 小红书 MCP（Linux 云服务器）

本方案把第三方 `xpzouying/xiaohongshu-mcp` 服务和飞书机器人分开运行：小红书服务没有公开端口，只加入一个私有 Docker 网络；机器人通过该网络访问它。登录 Cookie 存在服务器的受限目录，既不进入 Git，也不会发到飞书。

## 默认安全边界

- 机器人侧只注册读取、搜索、详情、账号状态和登录二维码工具。
- 发布笔记、评论、回复、点赞、收藏、删除 Cookie 等写操作没有注册给 Codex。
- MCP 的 Bearer 令牌仅在 `/etc/codex-feishu/.env.real` 中，配置文件只保存环境变量名。
- 小红书 MCP 不映射宿主机端口；外网不能直接访问 `18060`。

这不能消除第三方自动化服务及小红书账号本身的风险。请使用你愿意用于自动化登录的账号，并只在需要时扫码登录。

## 首次安装

先让服务器上的机器人仓库更新到包含本目录的版本，且工作区干净：

```bash
cd /opt/codex-feishu-bot
git status --short
git pull --ff-only origin main
sudo bash deploy/xiaohongshu-mcp/install-host.sh
```

安装脚本会：创建 Docker 私有网络、创建 Cookie 与图片持久化目录、生成 MCP 令牌、写入私有环境文件，并启动小红书 MCP。它不会输出令牌或 Cookie。

随后再重建一次机器人，让它加入这个 Docker 网络并生成 Codex MCP 配置：

```bash
sudo /usr/local/bin/self-deploy
```

验证：

```bash
sudo docker compose --env-file /etc/codex-feishu/.env.real \
  -f /opt/codex-feishu-bot/deploy/xiaohongshu-mcp/docker-compose.yml \
  -p codex-feishu-xhs ps
sudo docker logs --tail 80 codex-feishu-xhs-xiaohongshu-mcp-1
```

容器名称会因 Docker Compose 版本变化；若最后一条名称不匹配，用上面的 `ps` 查看实际名称再读取日志。

## 登录和日常使用

在飞书中让机器人检查小红书登录状态；未登录时请求登录二维码并自行扫码。Cookie 会持久化在服务器，服务重启后通常不必重新登录。

升级第三方镜像不是日常机器人部署的一部分。确定要升级时，先备份数据目录，再明确执行：

```bash
sudo docker compose --env-file /etc/codex-feishu/.env.real \
  -f /opt/codex-feishu-bot/deploy/xiaohongshu-mcp/docker-compose.yml \
  -p codex-feishu-xhs pull
sudo docker compose --env-file /etc/codex-feishu/.env.real \
  -f /opt/codex-feishu-bot/deploy/xiaohongshu-mcp/docker-compose.yml \
  -p codex-feishu-xhs up -d
```

## 停用

若要暂时停止服务，先将私有环境文件中 `XHS_MCP_ENABLED` 改为 `false`，重建机器人后再停止独立服务：

```bash
sudo docker compose --env-file /etc/codex-feishu/.env.real \
  -f /opt/codex-feishu-bot/deploy/xiaohongshu-mcp/docker-compose.yml \
  -p codex-feishu-xhs down
```

不要删除 `/var/lib/codex-feishu/xiaohongshu-mcp/`，除非确认要清除登录 Cookie 和本地图片。
