import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  ChatProject,
  ChatSession,
  ChatTask,
  CodexWorkspaceProject,
  IncomingChatMessage
} from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import { ConversationDeliveryService } from "./conversation-delivery-service.js";
import {
  GitProjectService,
  type GitProjectServiceLike
} from "./git-project-service.js";
import {
  formatReasoningEffort,
  normalizeModelName,
  parseChatSettingsCommand,
  type ChatSettingsCommand
} from "./chat-settings-command.js";
import { MessageProjector } from "./message-projector.js";
import {
  parseWorkspaceCommand,
  type WorkspaceCommand
} from "./workspace-command.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

export class ChatOrchestrator {
  private readonly seenIncomingMessages = new Map<string, number>();
  private readonly gitProjectService: GitProjectServiceLike;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly runStore: RunStore,
    private readonly conversationStore: ConversationStore,
    private readonly deliveryService: ConversationDeliveryService,
    private readonly projector: MessageProjector,
    private readonly codexWorker: CodexWorker,
    private readonly defaultWorkspace: string,
    private readonly logger: LoggerLike,
    gitProjectService?: GitProjectServiceLike
  ) {
    this.gitProjectService = gitProjectService ?? new GitProjectService(logger);
  }

  enqueue(message: IncomingChatMessage): void {
    if (message.senderType === "app" || message.senderType === "bot") {
      this.logger.info(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          chatType: message.chatType,
          senderType: message.senderType
        },
        "忽略机器人自己发出的消息"
      );
      return;
    }

    if (this.isDuplicateIncomingMessage(message)) {
      this.logger.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          chatType: message.chatType,
          senderId: message.senderId
        },
        "忽略重复投递的飞书消息事件"
      );
      return;
    }

    const existingSession = this.sessionStore.get(message.chatId);
    if (this.isInterruptCommand(message.text)) {
      void this.interruptActiveTurn(existingSession, message);
      return;
    }
    const numericSelection = message.text.trim().match(/^\d+$/);
    const pendingNavigationAt = existingSession?.pendingNavigation?.createdAt
      ? Date.parse(existingSession.pendingNavigation.createdAt)
      : Number.NaN;
    const hasValidPendingNavigation = Boolean(
      existingSession?.pendingNavigation?.ids.length &&
        Number.isFinite(pendingNavigationAt) &&
        Date.now() - pendingNavigationAt <= 10 * 60 * 1000
    );
    const pendingSelectionAt = existingSession?.pendingModelSelectionAt
      ? Date.parse(existingSession.pendingModelSelectionAt)
      : Number.NaN;
    const hasValidPendingModelSelection = Boolean(
      existingSession?.pendingModelOptions?.length &&
        Number.isFinite(pendingSelectionAt) &&
        Date.now() - pendingSelectionAt <= 10 * 60 * 1000
    );
    const settingsCommand = parseChatSettingsCommand(message.text) ??
      (!hasValidPendingNavigation && hasValidPendingModelSelection && numericSelection
        ? {
            kind: "model_pick" as const,
            index: Number(numericSelection[0]) - 1
          }
        : undefined);
    const workspaceCommand = parseWorkspaceCommand(message.text) ??
      (!settingsCommand && hasValidPendingNavigation && numericSelection
        ? {
            kind: "navigation_pick" as const,
            index: Number(numericSelection[0]) - 1
          }
        : undefined);
    if (workspaceCommand) {
      void this.handleWorkspaceCommand(message, workspaceCommand);
      return;
    }
    if (settingsCommand) {
      void this.handleSettingsCommand(message, settingsCommand);
      return;
    }

    this.logger.info(
      {
        chatId: message.chatId,
        messageId: message.messageId,
        chatType: message.chatType,
        senderId: message.senderId,
        textPreview: message.text.slice(0, 120)
      },
      "收到飞书消息，准备进入编排处理"
    );

    if (existingSession?.activeRunId && this.codexWorker.steerTurn) {
      void this.dispatchActiveOrNew(existingSession, message);
      return;
    }

    void this.handleMessage(message);
  }

  private async handleMessage(message: IncomingChatMessage): Promise<void> {
    const existingSession = this.ensureWorkspaceState(message.chatId);
    const workspaceId = existingSession.workspaceId;
    const threadId = existingSession.threadId.startsWith("pending:")
      ? existingSession.threadId
      : await this.codexWorker.ensureThread({
          session: existingSession,
          workspaceId,
          message
        });

    this.sessionStore.save(this.withActiveTaskThread({
      ...existingSession,
      chatId: message.chatId,
      threadId,
      workspaceId,
      activeRunId: existingSession?.activeRunId,
      updatedAt: new Date().toISOString()
    }, threadId));

    const run = this.runStore.create({
      chatId: message.chatId,
      threadId,
      sourceMessageId: message.messageId
    });

    this.sessionStore.attachRun(message.chatId, run.runId);

    try {
      for await (const event of this.codexWorker.runTurn({
        session: this.sessionStore.get(message.chatId),
        workspaceId,
        message,
        threadId
      })) {
        if (event.kind === "turn_bound") {
          this.sessionStore.bindTurn(message.chatId, event.turnId);
          continue;
        }

        const result = this.projector.apply(run.runId, event);
        const currentSession = this.sessionStore.get(message.chatId);
        this.sessionStore.save(this.withActiveTaskThread({
          ...currentSession,
          chatId: message.chatId,
          threadId: result.run.threadId,
          workspaceId,
          activeRunId: run.runId,
          activeTurnId: this.sessionStore.get(message.chatId)?.activeTurnId,
          updatedAt: new Date().toISOString()
        } as ChatSession, result.run.threadId));

        for (const item of result.items) {
          this.logger.info(
            {
              runId: run.runId,
              chatId: message.chatId,
              itemId: item.itemId,
              kind: item.kind,
              phase: item.phase,
              feishuMessageId: item.feishuMessageId
            },
            "消息投影已更新，准备同步飞书"
          );
          this.deliveryService.schedule(item);
        }
      }
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "处理过程中发生未知错误";
      const result = this.projector.apply(run.runId, {
        kind: "error",
        message: messageText
      });
      for (const item of result.items) {
        this.deliveryService.schedule(item);
      }
      this.logger.error(
        {
          runId: run.runId,
          chatId: message.chatId,
          error: messageText
        },
        "处理飞书消息失败"
      );
    } finally {
      await this.deliveryService.flushRun(run.runId).catch((error) => {
        this.logger.error(
          {
            runId: run.runId,
            chatId: message.chatId,
            error: error instanceof Error ? error.message : String(error)
          },
          "刷新 run 对应的飞书消息失败"
        );
      });
      this.sessionStore.releaseRun(message.chatId);
    }
  }

  private async steerMessage(messageSession: ReturnType<SessionStore["get"]>, message: IncomingChatMessage) {
    if (!messageSession?.activeRunId || !messageSession.activeTurnId) {
      await this.handleMessage(message);
      return;
    }

    const workspaceId = messageSession.workspaceId ?? this.defaultWorkspace;
    this.logger.info(
      {
        chatId: message.chatId,
        messageId: message.messageId,
        threadId: messageSession.threadId,
        turnId: messageSession.activeTurnId,
        activeRunId: messageSession.activeRunId,
        textPreview: message.text.slice(0, 160)
      },
      "检测到活跃 Codex turn，直接 steer 新消息"
    );

    this.runStore.update(messageSession.activeRunId, {
      sourceMessageId: message.messageId
    });

    try {
      await this.codexWorker.steerTurn?.({
        session: messageSession,
        workspaceId,
        message,
        threadId: messageSession.threadId,
        turnId: messageSession.activeTurnId
      });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          threadId: messageSession.threadId,
          turnId: messageSession.activeTurnId,
          activeRunId: messageSession.activeRunId,
          error: errorText
        },
        "steer 失败，退回启动新 turn"
      );

      this.sessionStore.releaseRun(message.chatId);
      await this.handleMessage(message);
    }
  }

  private async dispatchActiveOrNew(
    initialSession: ReturnType<SessionStore["get"]>,
    message: IncomingChatMessage
  ): Promise<void> {
    let session = initialSession;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!session?.activeRunId) {
        break;
      }

      if (session.activeTurnId) {
        await this.steerMessage(session, message);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
      session = this.sessionStore.get(message.chatId);
    }

    await this.handleMessage(message);
  }

  private async interruptActiveTurn(
    initialSession: ReturnType<SessionStore["get"]>,
    message: IncomingChatMessage
  ): Promise<void> {
    if (!initialSession?.activeRunId) {
      await this.deliveryService.sendText(message.chatId, "当前没有正在运行的任务。");
      return;
    }
    if (!this.codexWorker.interruptTurn) {
      await this.deliveryService.sendText(message.chatId, "当前 Codex 运行模式不支持中断任务。");
      return;
    }

    let session = initialSession;
    for (let attempt = 0; attempt < 30 && session.activeRunId && !session.activeTurnId; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      session = this.sessionStore.get(message.chatId) ?? session;
    }

    if (!session.activeRunId) {
      await this.deliveryService.sendText(message.chatId, "任务已经结束，无需暂停。");
      return;
    }
    if (!session.activeTurnId) {
      await this.deliveryService.sendText(message.chatId, "任务仍在启动，暂时无法中断，请稍后再发送“暂停”。");
      return;
    }

    try {
      await this.codexWorker.interruptTurn({
        threadId: session.threadId,
        turnId: session.activeTurnId
      });
      await this.deliveryService.sendText(message.chatId, "已中断当前任务。");
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          chatId: message.chatId,
          threadId: session.threadId,
          turnId: session.activeTurnId,
          error: errorText
        },
        "中断 Codex turn 失败"
      );
      await this.deliveryService.sendText(message.chatId, `暂停任务失败：${errorText}`);
    }
  }

  getDebugState() {
    return {
      sessions: this.sessionStore.list(),
      runs: this.runStore.list(),
      items: this.conversationStore.list()
    };
  }

  private async handleSettingsCommand(
    message: IncomingChatMessage,
    command: ChatSettingsCommand
  ): Promise<void> {
    try {
      if (command.kind === "effort_status" || command.kind === "effort_set") {
        const session = this.ensureSession(message.chatId);
        const effort = command.kind === "effort_set"
          ? command.effort
          : (session.reasoningEffort ?? "medium");

        if (command.kind === "effort_set") {
          this.sessionStore.update(message.chatId, {
            reasoningEffort: effort
          });
        }

        const suffix = session.activeRunId && command.kind === "effort_set"
          ? "，从下一个任务开始生效"
          : "";
        const content = command.kind === "effort_set"
          ? `推理强度已切换为${formatReasoningEffort(effort)}${suffix}。`
          : [
              `当前推理强度：${formatReasoningEffort(effort)}`,
              "",
              "可用档位：轻度 / 中等 / 高 / 极高 / 最高 / Ultra",
              "例如回复“思考 轻度”或“思考 高”。"
            ].join("\n");
        await this.deliveryService.sendText(message.chatId, content);
        return;
      }

      if (command.kind === "reasoning_status" || command.kind === "reasoning_set") {
        const session = this.ensureSession(message.chatId);
        const enabled =
          command.kind === "reasoning_set"
            ? command.enabled
            : (session.showReasoningSummary ?? false);

        if (command.kind === "reasoning_set") {
          this.sessionStore.update(message.chatId, {
            showReasoningSummary: enabled
          });
        }

        const suffix = session.activeRunId && command.kind === "reasoning_set"
          ? "，从下一个任务开始生效"
          : "";
        const content = enabled
          ? `思考摘要已开启${suffix}。我会显示 Codex 生成的简要推理摘要，不会展示原始私有推理。`
          : `思考摘要已关闭${suffix}。回复“过程 开”可重新开启。`;
        await this.deliveryService.sendText(message.chatId, content);
        return;
      }

      const models = (await this.codexWorker.listModels?.())?.filter((model) => !model.hidden) ?? [];
      const session = this.ensureSession(message.chatId);
      const configuredDefault = this.codexWorker.getDefaultModel?.() ?? "Default";

      if (command.kind === "model_list") {
        const currentModel = session?.modelDisplayName ?? session?.model ?? configuredDefault;
        const lines = models.map((model, index) => {
          const defaultLabel = model.isDefault ? "（推荐）" : "";
          return `${index + 1}. ${model.displayName}${defaultLabel}`;
        });
        this.rememberModelOptions(message.chatId, models);
        await this.deliveryService.sendText(
          message.chatId,
          [
            `当前模型：${currentModel}`,
            "",
            "可用模型：",
            ...lines,
            "",
            "10 分钟内直接回复序号即可切换，也可以回复完整模型名称；回复“模型 默认”恢复服务器默认模型。"
          ].join("\n")
        );
        return;
      }

      if (command.kind === "model_pick") {
        const selectedOption = session.pendingModelOptions?.[command.index];
        if (!selectedOption) {
          await this.deliveryService.sendText(
            message.chatId,
            "这个序号不在刚才的模型列表中。回复“模型”重新查看可用模型。"
          );
          return;
        }

        const selected = models.find((model) => model.model === selectedOption.model);
        if (!selected) {
          this.clearPendingModelOptions(message.chatId);
          await this.deliveryService.sendText(
            message.chatId,
            "刚才的模型列表已经变化。回复“模型”重新查看可用模型。"
          );
          return;
        }

        await this.applyModelSelection(message.chatId, selected, session);
        return;
      }

      const requested = normalizeModelName(command.value);
      if (["default", "默认", "服务器默认"].includes(requested)) {
        this.sessionStore.update(message.chatId, {
          model: undefined,
          modelDisplayName: undefined,
          pendingModelOptions: undefined,
          pendingModelSelectionAt: undefined
        });
        const suffix = session.activeRunId ? "，从下一个任务开始生效" : "";
        await this.deliveryService.sendText(
          message.chatId,
          `已恢复服务器默认模型：${configuredDefault}${suffix}。`
        );
        return;
      }

      const selected = models.find((model) =>
        [model.id, model.model, model.displayName].some(
          (candidate) => normalizeModelName(candidate) === requested
        )
      );
      if (!selected) {
        const candidates = models.filter((model) =>
          [model.id, model.model, model.displayName].some((candidate) =>
            normalizeModelName(candidate).includes(requested)
          )
        );
        if (candidates.length === 1) {
          const onlyCandidate = candidates[0];
          if (!onlyCandidate) {
            return;
          }
          await this.applyModelSelection(message.chatId, onlyCandidate, session);
          return;
        }
        if (candidates.length > 1) {
          this.rememberModelOptions(message.chatId, candidates);
          await this.deliveryService.sendText(
            message.chatId,
            [
              `“${command.value}”匹配到多个模型：`,
              ...candidates.map((model, index) => `${index + 1}. ${model.displayName}`),
              "",
              "10 分钟内直接回复序号选择。"
            ].join("\n")
          );
          return;
        }
        await this.deliveryService.sendText(
          message.chatId,
          "没有找到这个可用模型。回复“模型”查看当前账号实际可用的模型列表。"
        );
        return;
      }

      await this.applyModelSelection(message.chatId, selected, session);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          error: errorText
        },
        "处理会话设置命令失败"
      );
      await this.deliveryService.sendText(
        message.chatId,
        `读取设置失败：${errorText}`
      );
    }
  }

  private rememberModelOptions(
    chatId: string,
    models: Array<{ model: string; displayName: string }>
  ): void {
    this.sessionStore.update(chatId, {
      pendingModelOptions: models.map(({ model, displayName }) => ({ model, displayName })),
      pendingModelSelectionAt: new Date().toISOString(),
      pendingNavigation: undefined
    });
  }

  private clearPendingModelOptions(chatId: string): void {
    this.sessionStore.update(chatId, {
      pendingModelOptions: undefined,
      pendingModelSelectionAt: undefined
    });
  }

  private async applyModelSelection(
    chatId: string,
    selected: { model: string; displayName: string },
    session: ChatSession
  ): Promise<void> {
    this.sessionStore.update(chatId, {
      model: selected.model,
      modelDisplayName: selected.displayName,
      pendingModelOptions: undefined,
      pendingModelSelectionAt: undefined
    });
    const suffix = session.activeRunId ? "，从下一个任务开始生效" : "";
    await this.deliveryService.sendText(
      chatId,
      `模型已切换为 ${selected.displayName}${suffix}。`
    );
  }

  private async handleWorkspaceCommand(
    message: IncomingChatMessage,
    command: WorkspaceCommand
  ): Promise<void> {
    try {
      let session = this.ensureWorkspaceState(message.chatId);
      if (session.activeRunId) {
        await this.deliveryService.sendText(
          message.chatId,
          "当前任务仍在执行，完成后再切换项目或任务。"
        );
        return;
      }

      if (command.kind === "project_list") {
        session = await this.mergeCodexWorkspaceProjects(message.chatId, session);
        this.rememberNavigation(message.chatId, "project", session.projects?.map((item) => item.id) ?? []);
        const lines = (session.projects ?? []).map((project, index) => {
          const source = project.git
            ? `Git ${project.git.branch}@${project.git.lastCommit.slice(0, 8)}`
            : project.codexProjectId
              ? "本地 Codex"
              : project.workspaceId === this.defaultWorkspace
                ? "临时工作区"
                : "服务器文件";
          return `${index + 1}. ${project.name} [${source}]${project.id === session.activeProjectId ? "（当前）" : ""}`;
        });
        await this.deliveryService.sendText(
          message.chatId,
          [
            "项目列表：",
            ...lines,
            "",
            "10 分钟内回复序号切换；本地 Codex 新增或调整项目后，再发送“项目”即可刷新。"
          ].join("\n")
        );
        return;
      }

      if (command.kind === "project_create") {
        await this.deliveryService.sendText(
          message.chatId,
          "服务器不再创建独立空项目。请使用：绑定项目 <名称> <Git仓库地址> [分支]。"
        );
        return;
      }

      if (command.kind === "project_bind") {
        const name = this.validateName(command.name, "项目", 40);
        if ((session.projects ?? []).some((project) => project.name === name)) {
          await this.deliveryService.sendText(message.chatId, "已经存在同名项目。发送“项目”查看列表。");
          return;
        }

        const remoteUrl = this.gitProjectService.validateRemoteUrl(command.remoteUrl);
        const requestedBranch = this.gitProjectService.validateBranch(command.branch);
        const now = new Date().toISOString();
        const projectId = randomUUID();
        const workspaceId = join(this.defaultWorkspace, "repos", projectId);
        const result = await this.gitProjectService.clone(remoteUrl, workspaceId, requestedBranch);
        const task = this.createTask(message.chatId, "默认任务", now);
        const project: ChatProject = {
          id: projectId,
          name,
          workspaceId,
          git: {
            remoteUrl,
            branch: result.branch,
            lastCommit: result.commit,
            lastSyncedAt: now
          },
          tasks: [task],
          activeTaskId: task.id,
          createdAt: now,
          updatedAt: now
        };
        this.sessionStore.update(message.chatId, {
          projects: [...(session.projects ?? []), project],
          activeProjectId: project.id,
          workspaceId: project.workspaceId,
          threadId: task.threadId,
          pendingNavigation: undefined,
          pendingModelOptions: undefined,
          pendingModelSelectionAt: undefined
        });
        await this.deliveryService.sendText(
          message.chatId,
          `已绑定并切换到项目“${name}”，分支 ${result.branch}，版本 ${result.commit.slice(0, 8)}。`
        );
        return;
      }

      if (command.kind === "project_sync") {
        const project = command.value
          ? this.selectByValue(session.projects ?? [], command.value)
          : this.activeProject(session);
        if (!project) {
          await this.deliveryService.sendText(message.chatId, "没有找到这个项目。发送“项目”查看列表。");
          return;
        }
        if (!project.git) {
          await this.deliveryService.sendText(
            message.chatId,
            `项目“${project.name}”不是 Git 项目，请先用“绑定项目 名称 仓库地址 [分支]”添加仓库。`
          );
          return;
        }

        const result = await this.gitProjectService.sync(project.workspaceId, project.git.branch);
        const now = new Date().toISOString();
        const nextProject: ChatProject = {
          ...project,
          git: {
            ...project.git,
            branch: result.branch,
            lastCommit: result.commit,
            lastSyncedAt: now
          },
          updatedAt: now
        };
        this.sessionStore.update(message.chatId, {
          projects: (session.projects ?? []).map((item) => item.id === project.id ? nextProject : item),
          pendingNavigation: undefined
        });
        await this.deliveryService.sendText(
          message.chatId,
          result.changed
            ? `项目“${project.name}”已同步到 ${result.branch}@${result.commit.slice(0, 8)}。`
            : `项目“${project.name}”已是最新版本（${result.branch}@${result.commit.slice(0, 8)}）。`
        );
        return;
      }

      if (command.kind === "project_select" ||
          (command.kind === "navigation_pick" && session.pendingNavigation?.kind === "project")) {
        const project = command.kind === "navigation_pick"
          ? this.projectByPendingIndex(session, command.index)
          : this.selectByValue(session.projects ?? [], command.value);
        if (!project) {
          await this.deliveryService.sendText(message.chatId, "没有找到这个项目。发送“项目”查看列表。");
          return;
        }
        const task = project.tasks.find((item) => item.id === project.activeTaskId) ?? project.tasks[0];
        if (!task) {
          await this.deliveryService.sendText(message.chatId, "这个项目还没有可用任务，请发送“新任务 名称”。");
          return;
        }
        this.activateProjectTask(message.chatId, session, project, task);
        await this.deliveryService.sendText(
          message.chatId,
          project.git
            ? `已切换到项目“${project.name}”（${project.git.branch}@${project.git.lastCommit.slice(0, 8)}），继续任务“${task.name}”。`
            : project.codexProjectId
              ? `已切换到本地 Codex 项目“${project.name}”，继续任务“${task.name}”。`
              : project.workspaceId === this.defaultWorkspace
                ? `已切换到临时工作区“${project.name}”，继续任务“${task.name}”。`
                : `已切换到服务器项目“${project.name}”，继续任务“${task.name}”。`
        );
        return;
      }

      const project = this.activeProject(session);
      if (!project) {
        throw new Error("当前项目状态无效");
      }

      if (command.kind === "task_list") {
        this.rememberNavigation(message.chatId, "task", project.tasks.map((item) => item.id));
        const lines = project.tasks.map(
          (task, index) =>
            `${index + 1}. ${task.name}${task.id === project.activeTaskId ? "（当前）" : ""}`
        );
        await this.deliveryService.sendText(
          message.chatId,
          [`当前项目：${project.name}`, "任务列表：", ...lines, "", "10 分钟内回复序号切换；发送“新任务 名称”可创建独立任务。"].join("\n")
        );
        return;
      }

      if (command.kind === "task_create") {
        const name = this.validateName(command.value, "任务", 60);
        if (project.tasks.some((task) => task.name === name)) {
          await this.deliveryService.sendText(message.chatId, "当前项目已经存在同名任务。发送“任务”查看列表。");
          return;
        }
        const now = new Date().toISOString();
        const task = this.createTask(message.chatId, name, now);
        const nextProject: ChatProject = {
          ...project,
          tasks: [...project.tasks, task],
          activeTaskId: task.id,
          updatedAt: now
        };
        this.activateProjectTask(message.chatId, session, nextProject, task);
        await this.deliveryService.sendText(
          message.chatId,
          `已创建并切换到任务“${name}”。这是一个全新的 Codex 对话，不会带入其他任务的上下文。`
        );
        return;
      }

      if (command.kind === "task_select" ||
          (command.kind === "navigation_pick" && session.pendingNavigation?.kind === "task")) {
        const task = command.kind === "navigation_pick"
          ? this.taskByPendingIndex(session, project, command.index)
          : this.selectByValue(project.tasks, command.value);
        if (!task) {
          await this.deliveryService.sendText(message.chatId, "没有找到这个任务。发送“任务”查看列表。");
          return;
        }
        const nextProject = { ...project, activeTaskId: task.id, updatedAt: new Date().toISOString() };
        this.activateProjectTask(message.chatId, session, nextProject, task);
        await this.deliveryService.sendText(
          message.chatId,
          `已切换到任务“${task.name}”，后续消息会延续该任务的上下文。`
        );
        return;
      }

      if (command.kind === "navigation_pick") {
        await this.deliveryService.sendText(message.chatId, "选择已过期。发送“项目”或“任务”重新查看列表。");
      }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.logger.error({ chatId: message.chatId, error: errorText }, "处理项目或任务命令失败");
      await this.deliveryService.sendText(message.chatId, `项目或任务操作失败：${errorText}`);
    }
  }

  private ensureWorkspaceState(chatId: string): ChatSession {
    const session = this.ensureSession(chatId);
    const activeProject = session.projects?.find((project) => project.id === session.activeProjectId);
    const activeTask = activeProject?.tasks.find((task) => task.id === activeProject.activeTaskId);
    if (activeProject && activeTask) {
      return session;
    }

    const now = new Date().toISOString();
    const task: ChatTask = {
      id: randomUUID(),
      name: "默认任务",
      threadId: session.threadId,
      createdAt: now,
      updatedAt: now
    };
    const project: ChatProject = {
      id: randomUUID(),
      name: "临时工作区",
      workspaceId: session.workspaceId || this.defaultWorkspace,
      tasks: [task],
      activeTaskId: task.id,
      createdAt: now,
      updatedAt: now
    };
    return this.sessionStore.update(chatId, {
      projects: [project],
      activeProjectId: project.id,
      workspaceId: project.workspaceId,
      threadId: task.threadId
    }) ?? session;
  }

  private createTask(chatId: string, name: string, now: string): ChatTask {
    const id = randomUUID();
    return {
      id,
      name,
      threadId: `pending:${chatId}:${Date.now()}:${id}`,
      createdAt: now,
      updatedAt: now
    };
  }

  private async mergeCodexWorkspaceProjects(
    chatId: string,
    session: ChatSession
  ): Promise<ChatSession> {
    if (!this.codexWorker.listWorkspaceProjects) {
      return session;
    }

    let discovered: CodexWorkspaceProject[];
    try {
      discovered = await this.codexWorker.listWorkspaceProjects();
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "读取 Codex 本地项目失败，继续使用机器人已有项目"
      );
      return session;
    }
    const existing = session.projects ?? [];
    const manualProjects = existing.filter((project) => !project.codexProjectId);
    const importedProjects = discovered
      .filter((project) => project.roots[0])
      .map((project) => this.toChatProject(chatId, project, existing));
    const projects = [...importedProjects, ...manualProjects];
    const activeProjectId = projects.some((project) => project.id === session.activeProjectId)
      ? session.activeProjectId
      : projects[0]?.id;
    const activeProject = projects.find((project) => project.id === activeProjectId);
    const activeTask = activeProject?.tasks.find((task) => task.id === activeProject.activeTaskId) ??
      activeProject?.tasks[0];

    return this.sessionStore.update(chatId, {
      projects,
      activeProjectId,
      workspaceId: activeTask?.workspaceId ?? activeProject?.workspaceId ?? session.workspaceId,
      threadId: activeTask?.threadId ?? session.threadId,
      pendingNavigation: undefined
    }) ?? session;
  }

  private toChatProject(
    chatId: string,
    project: CodexWorkspaceProject,
    existing: ChatProject[]
  ): ChatProject {
    const previous = existing.find((item) => item.codexProjectId === project.id);
    const workspaceId = project.roots[0];
    if (!workspaceId) {
      throw new Error(`Codex 项目“${project.name}”没有可用工作目录`);
    }
    const fallbackTime = new Date(project.updatedAt * 1000).toISOString();
    const tasks: ChatTask[] = project.threads.map((thread) => ({
      id: `codex-thread:${thread.id}`,
      name: thread.name.replace(/\s+/g, " ").slice(0, 60),
      threadId: thread.id,
      workspaceId: thread.cwd,
      createdAt: new Date(thread.createdAt * 1000).toISOString(),
      updatedAt: new Date(thread.updatedAt * 1000).toISOString()
    }));
    if (tasks.length === 0) {
      tasks.push({
        ...this.createTask(chatId, "默认任务", fallbackTime),
        workspaceId
      });
    }
    const activeTaskId = previous && tasks.some((task) => task.id === previous.activeTaskId)
      ? previous.activeTaskId
      : tasks[0]!.id;

    return {
      id: `codex-project:${project.id}`,
      codexProjectId: project.id,
      name: project.name,
      workspaceId,
      tasks,
      activeTaskId,
      createdAt: new Date(project.createdAt * 1000).toISOString(),
      updatedAt: fallbackTime
    };
  }

  private activeProject(session: ChatSession): ChatProject | undefined {
    return session.projects?.find((project) => project.id === session.activeProjectId);
  }

  private activateProjectTask(
    chatId: string,
    session: ChatSession,
    project: ChatProject,
    task: ChatTask
  ): void {
    const projects = (session.projects ?? []).map((item) => item.id === project.id ? project : item);
    this.sessionStore.update(chatId, {
      projects,
      activeProjectId: project.id,
      workspaceId: task.workspaceId ?? project.workspaceId,
      threadId: task.threadId,
      pendingNavigation: undefined,
      pendingModelOptions: undefined,
      pendingModelSelectionAt: undefined
    });
  }

  private rememberNavigation(chatId: string, kind: "project" | "task", ids: string[]): void {
    this.sessionStore.update(chatId, {
      pendingNavigation: { kind, ids, createdAt: new Date().toISOString() },
      pendingModelOptions: undefined,
      pendingModelSelectionAt: undefined
    });
  }

  private projectByPendingIndex(session: ChatSession, index: number): ChatProject | undefined {
    const id = session.pendingNavigation?.ids[index];
    return session.projects?.find((project) => project.id === id);
  }

  private taskByPendingIndex(
    session: ChatSession,
    project: ChatProject,
    index: number
  ): ChatTask | undefined {
    const id = session.pendingNavigation?.ids[index];
    return project.tasks.find((task) => task.id === id);
  }

  private selectByValue<T extends { name: string }>(items: T[], value: string): T | undefined {
    const numeric = value.match(/^\d+$/);
    if (numeric) {
      return items[Number(numeric[0]) - 1];
    }
    return items.find((item) => item.name.toLocaleLowerCase() === value.toLocaleLowerCase());
  }

  private validateName(value: string, label: string, maxLength: number): string {
    const name = value.trim();
    if (!name || name.length > maxLength || /[\r\n\0]/.test(name)) {
      throw new Error(`${label}名称应为 1-${maxLength} 个字符，且不能包含换行。`);
    }
    return name;
  }

  private withActiveTaskThread(session: ChatSession, threadId: string): ChatSession {
    const now = new Date().toISOString();
    const projects = session.projects?.map((project) => {
      if (project.id !== session.activeProjectId) {
        return project;
      }
      return {
        ...project,
        updatedAt: now,
        tasks: project.tasks.map((task) =>
          task.id === project.activeTaskId ? { ...task, threadId, updatedAt: now } : task
        )
      };
    });
    return { ...session, threadId, projects };
  }

  private ensureSession(chatId: string): ChatSession {
    const existing = this.sessionStore.get(chatId);
    if (existing) {
      return existing;
    }

    return this.sessionStore.save({
      chatId,
      threadId: `pending:${chatId}:${Date.now()}`,
      workspaceId: this.defaultWorkspace,
      showReasoningSummary: false,
      updatedAt: new Date().toISOString()
    });
  }

  private isDuplicateIncomingMessage(message: IncomingChatMessage): boolean {
    const now = Date.now();
    const ttlMs = 6 * 60 * 60 * 1000;

    for (const [key, timestamp] of this.seenIncomingMessages) {
      if (now - timestamp > ttlMs) {
        this.seenIncomingMessages.delete(key);
      }
    }

    const key = `${message.chatId}:${message.messageId}`;
    if (this.seenIncomingMessages.has(key)) {
      return true;
    }

    this.seenIncomingMessages.set(key, now);
    return false;
  }

  private isInterruptCommand(text: string): boolean {
    return /^(?:暂停|停止|终止|取消)(?:一下|任务|当前任务)?[。！!]?$/u.test(text.trim());
  }
}
