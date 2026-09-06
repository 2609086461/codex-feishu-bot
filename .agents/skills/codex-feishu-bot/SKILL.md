---
name: codex-feishu-bot
description: Maintain, test, synchronize, deploy, and troubleshoot the shared Codex Feishu bridge across its Windows local and Linux Docker environments. Use for bot messaging, progress cards, project/task synchronization, model settings, permissions, runtime configuration, or deployment work in this repository.
---

# Codex Feishu Bot

Read the repository `AGENTS.md` and determine the target operating mode before acting.

## Choose The Target

- Use Windows scripts and Task Scheduler conventions for the local bot. Its default HTTP and Codex app-server ports are `3100` and `4600`.
- Use the single-container Docker workflow for the cloud bot.
- Change shared TypeScript code once. Keep platform differences in launch scripts, deployment files, and environment variables rather than duplicating the application.
- Treat Feishu app creation and console configuration as a separate bootstrap task; do not rerun it during ordinary maintenance.

## Protect Runtime State

- Never commit or print real `.env` values, access tokens, SSH keys, Codex authentication, chat sessions, caches, logs, or runtime databases.
- Keep local and cloud runtime state independent. Git synchronizes implementation and rules, not live conversations or credentials.
- Do not mutate Feishu, GitHub, cloud services, scheduled tasks, or live processes without authorization for that external action.

## Synchronize And Verify

- Check repository status before edits or synchronization. Pull only by fast-forward from a clean working tree; never discard divergence or force-push.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for shared application changes.
- For deployment-only changes, also verify the affected Windows launcher or Docker workflow without unnecessarily restarting the other environment.
- Report the deployed commit and environment after a release so local and cloud version drift is visible.
