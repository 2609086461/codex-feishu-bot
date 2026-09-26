# Codex CLI 更新提醒

生产机器人通过宿主机 systemd 定时器检查 `@openai/codex` 的 npm `latest`
稳定版。默认每周日 04:00（`Asia/Shanghai`）执行，并加入最多 10 分钟的随机
延迟。

检查器读取生产容器实际运行的 `codex --version`。发现更高稳定版后，它只向
指定飞书会话发送提醒；同一版本只提醒一次，不会修改环境变量、构建镜像、重启
容器或自动升级。用户明确回复“确认升级”后，再按正常测试和自部署流程升级。

在宿主机安装：

```bash
sudo /opt/codex-feishu-bot/deploy/codex-cli-update/install-host.sh \
  --chat-id oc_your_chat_id
```

手动只读检查：

```bash
sudo /opt/codex-feishu-bot/scripts/check-codex-cli-update-host.sh --dry-run
```

查看定时器和日志：

```bash
systemctl list-timers codex-cli-update.timer
journalctl -u codex-cli-update.service
```

私有通知配置保存于 `/etc/codex-feishu/codex-cli-update.env`（权限 `0600`），
去重状态保存于 `/var/lib/codex-feishu-bot/cli-update/`。二者都不进入 Git。
