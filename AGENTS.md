# AGENTS.md

This repository contains the shared implementation for both the local Windows bot and the cloud Docker bot.

## Primary Goal

Maintain one portable Feishu bridge implementation backed by `codex app-server`, while keeping environment-specific startup, credentials, and runtime state separate.

## Operating Modes

- Windows local mode uses the PowerShell scripts under `scripts/`, Windows Task Scheduler, HTTP port `3100`, and Codex app-server port `4600`.
- Cloud mode uses the single-container Docker deployment and persistent mounted runtime directories.
- Bootstrap mode is only for creating or reconfiguring a Feishu application. Follow `docs/codex-bootstrap-playbook.md` and `docs/feishu-console-automation.md` only for that task.
- Do not rerun dependency installation, browser setup, Git status, or deployment checks for ordinary chat handling unless the current task requires them.

## Shared Git Workflow

- This private repository is the source of truth for shared source code, tests, documentation, `AGENTS.md`, and repository skills.
- Check `git status` before editing, synchronizing, committing, or deploying, not before ordinary conversation or read-only questions.
- Pull only with fast-forward when the working tree is clean. Never reset, overwrite, or discard local or cloud changes to resolve divergence, and never force-push.
- Keep reusable Codex guidance in `AGENTS.md` and `.agents/skills/` so both environments load the same rules after a Git sync.
- Keep real `.env` files, Feishu/OpenAI/GitHub credentials, SSH keys, Codex authentication, sessions, logs, caches, and runtime state outside Git.

## Browser Automation Rules

- Prefer Chrome DevTools Protocol automation over telling the user to click around manually.
- If `agent-browser` is available, prefer it. Otherwise use any browser/CDP capability available in Codex.
- Reuse an existing Feishu app when it is clearly the intended app; otherwise create a new enterprise self-built app.
- Drive the UI by visible labels and user goals, not brittle CSS selectors.

## What Still Requires the User

- Logging into Feishu Open Platform in the browser.
- Logging into OpenAI/Codex if the local `~/.codex` state is missing.
- Approving tenant-admin prompts if the organization requires them.

Only stop for those checkpoints. Do not push routine console clicking back onto the user.

## Deployment Rules

- Use the Docker path for cloud setup and integration validation. Use the PowerShell launchers for the established Windows local service.
- Use the single-container Docker path. Do not reintroduce a `codex-app-server` sidecar deployment mode.
- Keep runtime secrets in `.env.real`.
- Keep Codex runtime work under the mounted `/workspace` only. Do not treat the repository checkout as the runtime workspace.
- Prefer `CODEX_HOME_SOURCE=/absolute/path/to/~/.codex` when local Codex auth already exists; only fall back to `OPENAI_API_KEY` when it does not.
- Keep generated user-facing files under `CODEX_ARTIFACTS_DIR` unless the user explicitly asks to write into the repository itself.
- Never commit `.env.real` or local browser profile data.
- Prefer `pnpm docker:*` commands for validation and debugging.

## Verification

- Run `pnpm typecheck` and `pnpm test` after shared TypeScript changes.
- Run `pnpm build` before deployment.
- Test the environment-specific launcher only when it was changed or when deployment is requested.
- Offline verification does not authorize sending Feishu messages, modifying Feishu resources, changing cloud services, or replacing live credentials.

## Success Criteria

- Feishu app is configured for long connection mode.
- `im.message.receive_v1` is subscribed.
- Required IM permissions are granted.
- App credentials are present in `.env.real`.
- `pnpm docker:up` succeeds.
- `pnpm docker:smoke` succeeds.
- The user can message the bot in Feishu without additional manual setup.
