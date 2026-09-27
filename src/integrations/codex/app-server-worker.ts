import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Env } from "../../config/env.js";
import type {
  CodexEvent,
  CodexModelInfo,
  CodexRouteDecision,
  CodexWorkspaceProject,
  RateLimitWindow,
  ThreadTokenUsage
} from "../../domain/types.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { AppServerWsConnection } from "./app-server-ws-connection.js";
import type { CodexTurnContext, CodexWorker } from "./codex-worker.js";
import {
  buildRouterPrompt,
  isLiveSelectableModel,
  normalizeRouteDecision,
  pickRouterModel
} from "./model-router.js";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
}

interface ThreadResponse {
  thread: {
    id: string;
  };
}

interface TurnStartResponse {
  turn: {
    id: string;
  };
}

const LOCAL_FEISHU_BRIDGE_LAUNCHER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/invoke-local-feishu-bridge.ps1"
);

function feishuBridgeCommand(): string {
  return process.platform === "win32"
    ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${LOCAL_FEISHU_BRIDGE_LAUNCHER_PATH}"`
    : "node /opt/codex-tools/feishu-bridge.mjs";
}

function isThreadClosingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread .* is closing|retry thread\/resume after the thread is closed/i.test(message);
}

async function resumeThreadWithRetry(
  connection: AppServerWsConnection,
  params: Record<string, unknown>
): Promise<ThreadResponse> {
  const delays = [100, 250, 500, 750, 1_000, 1_500, 2_000, 3_000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await connection.request<ThreadResponse>("thread/resume", params);
    } catch (error) {
      lastError = error;
      if (!isThreadClosingError(error) || attempt === delays.length) {
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[attempt]));
    }
  }

  throw lastError;
}

interface ModelListResponse {
  data: CodexModelInfo[];
  nextCursor?: string | null;
}

interface ProjectListResponse {
  data: Array<{
    id: string;
    name: string;
    roots: Array<{ path: string }>;
    createdAt: number;
    updatedAt: number;
  }>;
  nextCursor?: string | null;
}

interface WorkspaceThreadListResponse {
  data: Array<{
    id: string;
    projectId: string | null;
    name: string | null;
    preview: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
  }>;
  nextCursor?: string | null;
}

interface RateLimitSnapshot {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

interface AccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
}

interface TurnCompletedNotification {
  turn: {
    status: "completed" | "interrupted" | "failed" | "inProgress";
    error: {
      message: string;
      additionalDetails?: string | null;
    } | null;
  };
}

interface TurnPlanUpdatedNotification {
  explanation?: string | null;
  plan?: Array<{
    step?: string;
    status?: "pending" | "inProgress" | "completed";
  }>;
}

interface ThreadItem {
  type: string;
  id: string;
  text?: string;
  phase?: string | null;
  command?: string;
  query?: string;
  aggregatedOutput?: string | null;
  status?: string;
  changes?: Array<{
    path: string;
  }>;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface ThreadReadTurn {
  id: string;
  status?: string;
  error?: {
    message?: string;
    additionalDetails?: string | null;
  } | null;
  items?: ThreadItem[];
}

interface ThreadReadResponse {
  thread: {
    turns: ThreadReadTurn[];
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface TurnStreamState {
  currentThreadId: string;
  selectedModel: string;
  selectedModelDisplay: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  showReasoningSummary: boolean;
  currentTurnId?: string;
  commandByItemId: Map<string, string>;
  commandOutputByItemId: Map<string, string>;
  filePathsByItemId: Map<string, Set<string>>;
  agentTextByItemId: Map<string, string>;
  agentSourceByItemId: Map<string, "commentary" | "final_answer">;
  toolKindByItemId: Map<string, string>;
  reasoningTextByItemId: Map<string, string>;
  reasoningSummaryIndexByItemId: Map<string, number>;
  latestTokenUsage?: ThreadTokenUsage;
  finalAnswerItemId?: string;
}

function describeToolType(type: string): string {
  switch (type) {
    case "commandExecution":
      return "执行命令";
    case "fileChange":
      return "修改文件";
    case "webSearch":
      return "网页搜索";
    default:
      return type;
  }
}

function buildTurnInput(
  context: CodexTurnContext,
  artifactsDir: string,
  sandboxMode: Env["CODEX_APP_SERVER_SANDBOX"]
) {
  const bridgeCommand = feishuBridgeCommand();
  const workspaceInstruction = sandboxMode === "danger-full-access"
    ? `- Your current working directory is ${context.workspaceId}. You may read, create, edit, move, and run files elsewhere on this computer when the user's request requires it.`
    : `- Your working directory is ${context.workspaceId}. Treat it as the only writable project/workspace root you should use.`;
  const controllerInstructions = [
    "Controller instructions for the Feishu bridge environment:",
    `- You are responding inside Feishu chat ${context.message.chatId}.`,
    `- The current user message id is ${context.message.messageId}.`,
    workspaceInstruction,
    "- Do not assume the application repository root is available inside your workspace.",
    "- Publish user-visible output directly into the Feishu chat. Do not use reply-to-message semantics unless explicitly required.",
    "- Every user-visible file, image, sheet, or exported artifact must be published through Feishu APIs.",
    "- Workspace files are private to you and are not visible to the user unless you publish them.",
    `- Unless the user explicitly asks you to change repository files, create generated exports under ${artifactsDir}.`,
    `- Before generating a presentation, spreadsheet, image export, PDF, or other deliverable file, ensure ${artifactsDir} exists and write the file there instead of the repository root.`,
    "- Use commentary messages only for progress updates. Do not put the final conclusion in commentary.",
    "- Keep commentary sparse and information-dense. Only send commentary when there is meaningful progress, a concrete finding, or a material change in plan.",
    "- Emit exactly one final_answer for the final user-facing answer.",
    "- Do not repeat commentary or process summaries in final_answer.",
    "- Do not prefix final_answer with labels like '中间过程', '过程同步', '最终结论', or 'Final Answer'; the Feishu UI already labels the message type.",
    `- If the user should receive a file, run \`${bridgeCommand} send-file --chat-id ${context.message.chatId} --path <absolute_path>\` after writing it under ${artifactsDir}.`,
    `- For direct Feishu OpenAPI calls such as Bitable or Sheets, run \`${bridgeCommand} openapi --method <METHOD> --path <OPENAPI_PATH> [--body <JSON>] [--query key=value]...\`.`,
    "- Never tell the user to inspect files inside the workspace. Publish them when they matter to the user.",
    "",
    "User message:",
    context.message.text
  ].join("\n");

  return [
    {
      type: "text",
      text: controllerInstructions,
      text_elements: []
    },
    ...(context.message.attachments ?? []).flatMap((attachment) =>
      attachment.path
        ? [{ type: "localImage", path: attachment.path, detail: "auto" }]
        : []
    )
  ];
}

function buildSteerInput(context: CodexTurnContext) {
  return [
    {
      type: "text",
      text: [
        "Additional user message received while the current turn is still active.",
        `- Feishu chat: ${context.message.chatId}`,
        `- New user message id: ${context.message.messageId}`,
        "- Treat this as the latest instruction and adjust the ongoing turn accordingly.",
        "",
        "Latest user message:",
        context.message.text
      ].join("\n"),
      text_elements: []
    },
    ...(context.message.attachments ?? []).flatMap((attachment) =>
      attachment.path
        ? [{ type: "localImage", path: attachment.path, detail: "auto" }]
        : []
    )
  ];
}

export class CodexAppServerWorker implements CodexWorker {
  private child?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly env: Env,
    private readonly logger?: LoggerLike
  ) {}

  getDefaultModel(): string {
    return this.env.CODEX_APP_SERVER_MODEL;
  }

  async listModels(): Promise<CodexModelInfo[]> {
    await this.start();
    const connection = new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
      logger: this.logger,
      label: "model-list"
    });
    await connection.connect();

    try {
      const models: CodexModelInfo[] = [];
      let cursor: string | null | undefined;
      do {
        const response = await connection.request<ModelListResponse>("model/list", {
          cursor
        });
        models.push(...response.data);
        cursor = response.nextCursor;
      } while (cursor);

      // Do not add configured or historic fallbacks here.  The app server's
      // live model list already reflects the signed-in ChatGPT account, and a
      // synthetic entry could be shown to a user even though it cannot run.
      return models.filter((model) => Boolean(model.model?.trim()));
    } finally {
      await connection.close();
    }
  }

  async routeTurn(context: CodexTurnContext): Promise<CodexRouteDecision> {
    const models = await this.listModels();
    const routerModel = pickRouterModel(models);
    const fallback = normalizeRouteDecision({}, models);
    if (!routerModel) {
      return fallback;
    }

    let routerThreadId: string | undefined;
    let routerTurnId: string | undefined;
    let responseText = "";
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    let connection!: AppServerWsConnection;
    connection = new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
      logger: this.logger,
      label: "auto-model-router",
      onNotification: (notification) => {
        const params = (notification.params ?? {}) as Record<string, unknown>;
        const targetThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (routerThreadId && targetThreadId && targetThreadId !== routerThreadId) {
          return;
        }

        if (notification.method === "item/completed") {
          const item = params.item as ThreadItem | undefined;
          if (item?.type === "agentMessage" && typeof item.text === "string") {
            responseText = item.text;
          }
          return;
        }

        if (notification.method === "turn/completed") {
          const turn = params.turn as TurnCompletedNotification["turn"] & { id?: string };
          if (routerTurnId && turn.id && turn.id !== routerTurnId) {
            return;
          }
          if (turn.status === "completed") {
            resolveCompletion?.();
          } else {
            rejectCompletion?.(new Error(turn.error?.message ?? `自动路由 turn 状态：${turn.status}`));
          }
          return;
        }

        if (notification.method === "error" && params.willRetry !== true) {
          const error = params.error as { message?: string } | undefined;
          rejectCompletion?.(new Error(error?.message ?? "自动路由失败"));
        }
      },
      onRequest: (request) => {
        connection.respondError(request.id, -32000, "自动路由不允许调用工具");
      }
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      await connection.connect();
      const recentContext = await this.readRoutingContext(connection, context.session?.threadId);
      routerThreadId = (
        await connection.request<ThreadResponse>("thread/start", {
          model: routerModel.model,
          cwd: context.workspaceId,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          developerInstructions: "你是任务路由器，只能输出指定 JSON，禁止调用任何工具。"
        })
      ).thread.id;

      const prompt = buildRouterPrompt(
        context.message.text,
        recentContext,
        (context.message.attachments ?? []).map((attachment) => attachment.kind),
        models
      );
      const started = await connection.request<TurnStartResponse>("turn/start", {
        threadId: routerThreadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: routerModel.model,
        effort: "low",
        summary: "none",
        cwd: context.workspaceId,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" }
        },
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["model", "effort", "confidence", "reason"],
          properties: {
            model: { type: "string", enum: models.map((model) => model.model) },
            effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string", maxLength: 80 }
          }
        }
      });
      routerTurnId = started.turn.id;

      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("自动路由超时")), 20_000);
        })
      ]);

      const jsonText = responseText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      const decision = normalizeRouteDecision(JSON.parse(jsonText), models);
      this.logger?.info(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          routerModel: routerModel.model,
          model: decision.model,
          effort: decision.reasoningEffort,
          confidence: decision.confidence,
          reason: decision.reason
        },
        "快模型已完成自动路由"
      );
      return decision;
    } catch (error) {
      this.logger?.warn(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          routerModel: routerModel.model,
          error: error instanceof Error ? error.message : String(error),
          fallbackModel: fallback.model,
          fallbackEffort: fallback.reasoningEffort
        },
        "自动路由失败，使用平衡回退"
      );
      return fallback;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      await connection.close().catch(() => undefined);
    }
  }

  async listWorkspaceProjects(): Promise<CodexWorkspaceProject[]> {
    await this.start();
    const connection = new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
      logger: this.logger,
      label: "workspace-project-list"
    });
    await connection.connect();

    try {
      const projects: ProjectListResponse["data"] = [];
      let projectCursor: string | null | undefined;
      do {
        const response = await connection.request<ProjectListResponse>("project/list", {
          cursor: projectCursor,
          limit: 100,
          sortKey: "recencyAt",
          sortDirection: "desc"
        });
        projects.push(...response.data);
        projectCursor = response.nextCursor;
      } while (projectCursor);

      const threads: WorkspaceThreadListResponse["data"] = [];
      let threadCursor: string | null | undefined;
      do {
        const response = await connection.request<WorkspaceThreadListResponse>("thread/list", {
          cursor: threadCursor,
          limit: 100,
          sortKey: "recency_at",
          sortDirection: "desc",
          useStateDbOnly: true
        });
        threads.push(...response.data);
        threadCursor = response.nextCursor;
      } while (threadCursor);

      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        roots: project.roots.map((root) => root.path),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        threads: threads
          .filter((thread) =>
            thread.projectId === project.id ||
            (!thread.projectId && project.roots.some((root) => this.isWithinRoot(thread.cwd, root.path)))
          )
          .map((thread) => ({
            id: thread.id,
            name: thread.name?.trim() || thread.preview.trim() || "未命名任务",
            cwd: thread.cwd,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt
          }))
      }));
    } finally {
      await connection.close();
    }
  }

  private isWithinRoot(path: string, root: string): boolean {
    const child = relative(root, path);
    return child === "" ||
      (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
  }

  async start(): Promise<void> {
    if (!this.env.CODEX_APP_SERVER_MANAGED || this.child) {
      return;
    }

    const args = [
      ...this.env.CODEX_APP_SERVER_ARGS.split(" ").filter(Boolean),
      "--listen",
      this.env.CODEX_APP_SERVER_LISTEN_URL
    ];

    this.logger?.info(
      {
        command: this.env.CODEX_APP_SERVER_COMMAND,
        args
      },
      "准备托管启动 codex app-server"
    );

    const childEnv = { ...process.env };
    // Codex invokes the Feishu bridge, so its child process needs these credentials.
    delete childEnv.OPENAI_API_KEY;

    this.child = spawn(this.env.CODEX_APP_SERVER_COMMAND, args, {
      stdio: "pipe",
      env: childEnv
    });

    this.child.stdout.on("data", (chunk) => {
      process.stdout.write(`[codex-app-server] ${chunk}`);
    });

    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[codex-app-server] ${chunk}`);
    });

    this.child.on("exit", () => {
      this.logger?.warn("托管的 codex app-server 进程已退出");
      this.child = undefined;
    });

    await this.waitForServer();
  }

  async close(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = undefined;

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGINT");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000);
    });
  }

  async ensureThread(context: CodexTurnContext): Promise<string> {
    const requestedThreadId = context.session?.threadId;
    return requestedThreadId ?? `pending:${context.message.chatId}:${Date.now()}`;
  }

  async steerTurn(
    context: CodexTurnContext & { threadId: string; turnId: string }
  ): Promise<void> {
    await this.start();

    const connection = new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
      logger: this.logger,
      label: "steer-turn"
    });
    await connection.connect();

    try {
      this.logger?.info(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          threadId: context.threadId,
          turnId: context.turnId,
          textPreview: context.message.text.slice(0, 160)
        },
        "尝试将用户新消息立即 steer 到当前 Codex turn"
      );

      const maxAttempts = 8;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await connection.request("turn/steer", {
            threadId: context.threadId,
            expectedTurnId: context.turnId,
            input: buildSteerInput(context)
          });

          this.logger?.info(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              threadId: context.threadId,
              turnId: context.turnId,
              attempt
            },
            "Codex turn/steer 成功"
          );
          return;
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          const shouldRetry =
            /no active turn to steer/i.test(messageText) ||
            /expectedTurnId/i.test(messageText);

          if (!shouldRetry || attempt === maxAttempts) {
            this.logger?.error(
              {
                chatId: context.message.chatId,
                messageId: context.message.messageId,
                threadId: context.threadId,
                turnId: context.turnId,
                attempt,
                error: messageText
              },
              "Codex turn/steer 失败"
            );
            throw error;
          }

          this.logger?.warn(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              threadId: context.threadId,
              turnId: context.turnId,
              attempt,
              error: messageText
            },
            "Codex turn 尚未进入可 steer 状态，准备重试"
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    } finally {
      await connection.close();
    }
  }

  async interruptTurn(context: { threadId: string; turnId: string }): Promise<void> {
    await this.start();

    const connection = new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
      logger: this.logger,
      label: "interrupt-turn"
    });
    await connection.connect();

    try {
      await connection.request("turn/interrupt", {
        threadId: context.threadId,
        turnId: context.turnId
      });
      this.logger?.info(
        {
          threadId: context.threadId,
          turnId: context.turnId
        },
        "Codex turn/interrupt 成功"
      );
    } finally {
      await connection.close();
    }
  }

  async *runTurn(
    context: CodexTurnContext & { threadId: string }
  ): AsyncGenerator<CodexEvent> {
    await this.start();

    const state: TurnStreamState = {
      currentThreadId: context.threadId,
      selectedModel: "",
      selectedModelDisplay: "",
      reasoningEffort: context.session?.reasoningEffort ?? "medium",
      showReasoningSummary: context.session?.showReasoningSummary ?? false,
      commandByItemId: new Map(),
      commandOutputByItemId: new Map(),
      filePathsByItemId: new Map(),
      agentTextByItemId: new Map(),
      agentSourceByItemId: new Map(),
      toolKindByItemId: new Map(),
      reasoningTextByItemId: new Map(),
      reasoningSummaryIndexByItemId: new Map()
    };

    const selectedModel = await this.modelFor(context);
    state.selectedModel = selectedModel.model;
    state.selectedModelDisplay = selectedModel.displayName;

    const queue = new AsyncEventQueue<CodexEvent>();
    let connection: AppServerWsConnection;
    let recovering = false;
    let finished = false;

    const attemptRecovery = async (error: Error) => {
      if (recovering || finished) {
        return;
      }

      recovering = true;
      this.logger?.error(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          threadId: state.currentThreadId,
          turnId: state.currentTurnId,
          error: error.message
        },
        "Codex turn 运行期间连接意外关闭，准备尝试重连"
      );

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        let resumedConnection: AppServerWsConnection | undefined;
        try {
          await new Promise((resolve) => setTimeout(resolve, attempt * 500));
          resumedConnection = createRunTurnConnection();
          await resumedConnection.connect();
          await resumeThreadWithRetry(resumedConnection, {
            threadId: state.currentThreadId,
            model: state.selectedModel,
            cwd: context.workspaceId,
            approvalPolicy: this.env.CODEX_APP_SERVER_APPROVAL_POLICY,
            sandbox: this.env.CODEX_APP_SERVER_SANDBOX,
            persistExtendedHistory: true
          });

          const thread = await resumedConnection.request<ThreadReadResponse>("thread/read", {
            threadId: state.currentThreadId,
            includeTurns: true
          });
          const targetTurn = this.pickTurnSnapshot(thread, state.currentTurnId);

          if (targetTurn) {
            this.replayTurnSnapshot(targetTurn, state, queue);
            const status = this.normalizeTurnStatus(targetTurn.status);

            if (status === "completed") {
              queue.push({
                kind: "run_status",
                status: "completed"
              });
              finished = true;
              queue.close();
              await resumedConnection.close();
              this.logger?.info(
                {
                  chatId: context.message.chatId,
                  messageId: context.message.messageId,
                  threadId: state.currentThreadId,
                  turnId: targetTurn.id,
                  attempt
                },
                "Codex turn 断线后已通过 thread/read 补齐完成状态"
              );
              recovering = false;
              return;
            }

            if (status === "failed") {
              queue.push({
                kind: "error",
                message:
                  targetTurn.error?.additionalDetails ??
                  targetTurn.error?.message ??
                  "Codex turn 失败"
              });
              finished = true;
              queue.close();
              await resumedConnection.close();
              this.logger?.warn(
                {
                  chatId: context.message.chatId,
                  messageId: context.message.messageId,
                  threadId: state.currentThreadId,
                  turnId: targetTurn.id,
                  attempt
                },
                "Codex turn 断线后补齐为失败状态"
              );
              recovering = false;
              return;
            }

            if (status === "interrupted") {
              queue.push({
                kind: "error",
                message: "Codex turn 被中断"
              });
              finished = true;
              queue.close();
              await resumedConnection.close();
              this.logger?.warn(
                {
                  chatId: context.message.chatId,
                  messageId: context.message.messageId,
                  threadId: state.currentThreadId,
                  turnId: targetTurn.id,
                  attempt
                },
                "Codex turn 断线后补齐为中断状态"
              );
              recovering = false;
              return;
            }
          }

          connection = resumedConnection;
          this.logger?.info(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              threadId: state.currentThreadId,
              turnId: state.currentTurnId,
              attempt
            },
            "Codex turn WebSocket 重连成功，继续监听"
          );
          recovering = false;
          return;
        } catch (recoverError) {
          this.logger?.warn(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              threadId: state.currentThreadId,
              turnId: state.currentTurnId,
              attempt,
              error: recoverError instanceof Error ? recoverError.message : String(recoverError)
            },
            "Codex turn WebSocket 重连失败，继续重试"
          );
          await resumedConnection?.close().catch(() => undefined);
        }
      }

      queue.push({
        kind: "error",
        message: "Codex 运行连接意外断开，多次重连失败。请重新发送一次。"
      });
      finished = true;
      queue.close();
      recovering = false;
    };

    const createRunTurnConnection = () =>
      new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
        logger: this.logger,
        label: "run-turn",
        onUnexpectedClose: (error) => {
          void attemptRecovery(error);
        },
        onNotification: (message) => {
          void this.handleNotification(message, state.currentThreadId, state, connection, queue);
        },
        onRequest: (message) => {
          this.handleRequest(connection, message, state.currentThreadId);
        }
      });

    connection = createRunTurnConnection();

    try {
      await connection.connect();

      this.logger?.info(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          workspaceId: context.workspaceId,
          requestedThreadId: context.threadId,
          textPreview: context.message.text.slice(0, 160)
        },
        "开始执行 Codex turn"
      );

      let actualThreadId: string;
      if (context.threadId.startsWith("pending:")) {
        actualThreadId = (
          await connection.request<ThreadResponse>("thread/start", {
              model: state.selectedModel,
              cwd: context.workspaceId,
              approvalPolicy: this.env.CODEX_APP_SERVER_APPROVAL_POLICY,
              sandbox: this.env.CODEX_APP_SERVER_SANDBOX,
              experimentalRawEvents: false,
              persistExtendedHistory: true
          })
        ).thread.id;
      } else {
        try {
          actualThreadId = (
            await resumeThreadWithRetry(connection, {
              threadId: context.threadId,
              model: state.selectedModel,
              cwd: context.workspaceId,
              approvalPolicy: this.env.CODEX_APP_SERVER_APPROVAL_POLICY,
              sandbox: this.env.CODEX_APP_SERVER_SANDBOX,
              persistExtendedHistory: true
            })
          ).thread.id;
        } catch (error) {
          this.logger?.warn(
            {
              chatId: context.message.chatId,
              messageId: context.message.messageId,
              threadId: context.threadId,
              error: error instanceof Error ? error.message : String(error)
            },
            "Codex thread 无法恢复，自动创建替代 thread"
          );
          actualThreadId = (
            await connection.request<ThreadResponse>("thread/start", {
              model: state.selectedModel,
              cwd: context.workspaceId,
              approvalPolicy: this.env.CODEX_APP_SERVER_APPROVAL_POLICY,
              sandbox: this.env.CODEX_APP_SERVER_SANDBOX,
              experimentalRawEvents: false,
              persistExtendedHistory: true
            })
          ).thread.id;
        }
      }

      this.logger?.info(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          actualThreadId
        },
        "Codex turn 已绑定 thread"
      );
      queue.push({
        kind: "thread_bound",
        threadId: actualThreadId
      });
      queue.push({
        kind: "run_status",
        status: "running"
      });
      state.currentThreadId = actualThreadId;

      const turnStart = await connection.request<TurnStartResponse>("turn/start", {
        threadId: actualThreadId,
        input: buildTurnInput(
          context,
          this.env.CODEX_ARTIFACTS_DIR,
          this.env.CODEX_APP_SERVER_SANDBOX
        ),
        model: state.selectedModel,
        effort: state.reasoningEffort,
        summary: state.showReasoningSummary ? "auto" : "none",
        cwd: context.workspaceId,
        approvalPolicy: this.env.CODEX_APP_SERVER_APPROVAL_POLICY,
        sandboxPolicy: {
          type:
            this.env.CODEX_APP_SERVER_SANDBOX === "danger-full-access"
              ? "dangerFullAccess"
              : this.env.CODEX_APP_SERVER_SANDBOX === "read-only"
                ? "readOnly"
                : "workspaceWrite",
          ...(this.env.CODEX_APP_SERVER_SANDBOX === "workspace-write"
            ? {
                writableRoots: [context.workspaceId],
                readOnlyAccess: {
                  type: "fullAccess"
                },
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false
              }
            : this.env.CODEX_APP_SERVER_SANDBOX === "read-only"
              ? {
                  access: {
                    type: "fullAccess"
                  }
                }
              : {})
        }
      });
      state.currentTurnId = turnStart.turn.id;
      queue.push({
        kind: "turn_bound",
        turnId: turnStart.turn.id
      });
      this.logger?.info(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          threadId: actualThreadId,
          turnId: turnStart.turn.id
        },
        "Codex turn/start 成功"
      );
    } catch (error) {
      this.logger?.error(
        {
          chatId: context.message.chatId,
          messageId: context.message.messageId,
          threadId: context.threadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "启动 Codex turn 失败"
      );
      queue.push({
        kind: "error",
        message: error instanceof Error ? error.message : "无法启动 Codex turn"
      });
      finished = true;
      queue.close();
    }

    try {
      yield* queue.iterate();
    } finally {
      finished = true;
      queue.close();
      await connection.close();
    }
  }

  private handleNotification(
    message: JsonRpcNotification,
    threadId: string,
    state: TurnStreamState,
    connection: AppServerWsConnection,
    queue: AsyncEventQueue<CodexEvent>
  ): Promise<void> {
    return this.doHandleNotification(message, threadId, state, connection, queue);
  }

  private async doHandleNotification(
    message: JsonRpcNotification,
    threadId: string,
    state: TurnStreamState,
    connection: AppServerWsConnection,
    queue: AsyncEventQueue<CodexEvent>
  ): Promise<void> {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const targetThreadId = typeof params.threadId === "string" ? params.threadId : undefined;

    if (targetThreadId && targetThreadId !== threadId) {
      this.logger?.info(
        {
          targetThreadId,
          currentThreadId: threadId,
          method: message.method
        },
        "忽略属于其他 thread 的 Codex 通知"
      );
      return;
    }

    if (message.method === "turn/started") {
      queue.push({
        kind: "run_status",
        status: "running"
      });
      return;
    }

    if (message.method === "turn/plan/updated") {
      const update = params as unknown as TurnPlanUpdatedNotification;
      const plan = (update.plan ?? []).flatMap((entry) =>
        entry.step && entry.status
          ? [{ step: entry.step, status: entry.status }]
          : []
      );
      if (plan.length > 0) {
        queue.push({
          kind: "plan_updated",
          explanation: update.explanation ?? undefined,
          plan
        });
      }
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const tokenUsage = params.tokenUsage as ThreadTokenUsage | undefined;
      if (tokenUsage?.last && tokenUsage.total) {
        state.latestTokenUsage = tokenUsage;
      }
      return;
    }

    if (message.method === "item/reasoning/summaryPartAdded") {
      if (!state.showReasoningSummary) {
        return;
      }

      const itemId = params.itemId;
      const summaryIndex = params.summaryIndex;
      if (typeof itemId !== "string" || typeof summaryIndex !== "number") {
        return;
      }

      const previous = state.reasoningTextByItemId.get(itemId) ?? "";
      const previousIndex = state.reasoningSummaryIndexByItemId.get(itemId);
      state.reasoningSummaryIndexByItemId.set(itemId, summaryIndex);
      if (previous && previousIndex !== undefined && previousIndex !== summaryIndex) {
        state.reasoningTextByItemId.set(itemId, `${previous}\n\n`);
        queue.push({
          kind: "assistant_message_delta",
          itemId: `reasoning:${itemId}`,
          text: "\n\n"
        });
      }
      return;
    }

    if (message.method === "item/reasoning/summaryTextDelta") {
      if (!state.showReasoningSummary) {
        return;
      }

      const itemId = params.itemId;
      const delta = params.delta;
      const summaryIndex = params.summaryIndex;
      if (typeof itemId !== "string" || typeof delta !== "string") {
        return;
      }

      const publicItemId = `reasoning:${itemId}`;
      const previous = state.reasoningTextByItemId.get(itemId) ?? "";
      if (!previous) {
        queue.push({
          kind: "assistant_message_started",
          itemId: publicItemId,
          source: "commentary"
        });
      }
      if (typeof summaryIndex === "number") {
        state.reasoningSummaryIndexByItemId.set(itemId, summaryIndex);
      }
      state.reasoningTextByItemId.set(itemId, `${previous}${delta}`);
      queue.push({
        kind: "assistant_message_delta",
        itemId: publicItemId,
        text: delta
      });
      return;
    }

    if (message.method === "item/started" || message.method === "item/completed") {
      const item = params.item as ThreadItem | undefined;
      if (!item) {
        return;
      }

      this.logger?.info(
        {
          threadId,
          turnId: state.currentTurnId,
          itemId: item.id,
          itemType: item.type,
          method: message.method,
          phase: item.phase ?? undefined,
          command: item.command
        },
        "收到 Codex item 生命周期事件"
      );

      if (item.type === "agentMessage") {
        const source = item.phase === "final_answer" ? "final_answer" : "commentary";
        state.agentSourceByItemId.set(item.id, source);

        if (message.method === "item/started") {
          queue.push({
            kind: "assistant_message_started",
            itemId: item.id,
            source
          });
          if (source === "final_answer") {
            state.finalAnswerItemId = item.id;
          }
        }

        if (typeof item.text === "string") {
          state.agentTextByItemId.set(item.id, item.text);
        }

        if (message.method === "item/completed" && typeof item.text === "string") {
          queue.push({
            kind: "assistant_message_completed",
            itemId: item.id,
            text: item.text
          });
        }
        return;
      }

      if (item.type === "reasoning") {
        if (message.method === "item/completed" && state.showReasoningSummary) {
          const text = state.reasoningTextByItemId.get(item.id);
          if (text?.trim()) {
            queue.push({
              kind: "assistant_message_completed",
              itemId: `reasoning:${item.id}`,
              text
            });
          }
        }
        return;
      }

      if (item.type === "commandExecution") {
        state.toolKindByItemId.set(item.id, "commandExecution");
        if (item.command) {
          state.commandByItemId.set(item.id, item.command);
        }
        if (item.aggregatedOutput) {
          state.commandOutputByItemId.set(item.id, item.aggregatedOutput);
        }

        if (message.method === "item/started") {
          queue.push({
            kind: "tool_call_started",
            itemId: item.id,
            title: "执行命令",
            command: item.command
          });
        } else {
          queue.push({
            kind: "tool_call_completed",
            itemId: item.id,
            title: "执行命令",
            status: "completed",
            output: item.aggregatedOutput ?? state.commandOutputByItemId.get(item.id),
            paths: []
          });
        }
        return;
      }

      if (item.type === "fileChange") {
        state.toolKindByItemId.set(item.id, "fileChange");
        const paths = state.filePathsByItemId.get(item.id) ?? new Set<string>();
        for (const change of item.changes ?? []) {
          paths.add(change.path);
        }
        state.filePathsByItemId.set(item.id, paths);

        if (message.method === "item/started") {
          queue.push({
            kind: "tool_call_started",
            itemId: item.id,
            title: "修改文件"
          });
        } else {
          queue.push({
            kind: "tool_call_completed",
            itemId: item.id,
            title: "修改文件",
            status: "completed",
            paths: Array.from(paths)
          });
        }
        return;
      }

      if (item.type !== "reasoning" && item.type !== "userMessage") {
        state.toolKindByItemId.set(item.id, item.type);

        const title = item.query?.trim() || describeToolType(item.type);

        if (message.method === "item/started") {
          queue.push({
            kind: "tool_call_started",
            itemId: item.id,
            title
          });
        } else {
          queue.push({
            kind: "tool_call_completed",
            itemId: item.id,
            title,
            status: "completed"
          });
        }
      }

      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const itemId = params.itemId;
      const delta = params.delta;

      if (typeof itemId === "string" && typeof delta === "string") {
        const nextText = `${state.agentTextByItemId.get(itemId) ?? ""}${delta}`;
        state.agentTextByItemId.set(itemId, nextText);
        queue.push({
          kind: "assistant_message_delta",
          itemId,
          text: delta
        });
      }
      return;
    }

    if (message.method === "item/commandExecution/outputDelta") {
      const itemId = params.itemId;
      const delta = params.delta;
      if (typeof itemId === "string" && typeof delta === "string") {
        const nextOutput = `${state.commandOutputByItemId.get(itemId) ?? ""}${delta}`.slice(-4000);
        state.commandOutputByItemId.set(itemId, nextOutput);
        queue.push({
          kind: "tool_call_delta",
          itemId,
          detail: delta.trim() || undefined,
          output: nextOutput
        });
      }
      return;
    }

    if (message.method === "item/fileChange/outputDelta") {
      const itemId = params.itemId;
      const delta = params.delta;
      if (typeof itemId === "string" && typeof delta === "string") {
        const paths = this.extractPathsFromDiff(delta);
        for (const path of paths) {
          const known = state.filePathsByItemId.get(itemId) ?? new Set<string>();
          known.add(path);
          state.filePathsByItemId.set(itemId, known);
          queue.push({
            kind: "tool_call_delta",
            itemId,
            path,
            detail: `修改 ${path}`
          });
        }
      }
      return;
    }

    if (message.method === "codex/event/web_search_begin") {
      const msg = params.msg as
        | {
            call_id?: string;
            query?: string;
          }
        | undefined;

      if (typeof msg?.call_id === "string") {
        queue.push({
          kind: "tool_call_started",
          itemId: msg.call_id,
          title: "网页搜索"
        });

        if (msg.query) {
          queue.push({
            kind: "tool_call_delta",
            itemId: msg.call_id,
            detail: `查询: ${msg.query}`
          });
        }
      }
      return;
    }

    if (message.method === "codex/event/web_search_end") {
      const msg = params.msg as
        | {
            call_id?: string;
            query?: string;
          }
        | undefined;

      if (typeof msg?.call_id === "string" && msg.query) {
        queue.push({
          kind: "tool_call_delta",
          itemId: msg.call_id,
          detail: `完成搜索: ${msg.query}`
        });
      }
      return;
    }

    if (message.method === "turn/completed") {
      const completed = params as unknown as TurnCompletedNotification;
      this.logger?.info(
        {
          threadId,
          turnId: state.currentTurnId,
          status: completed.turn.status,
          error: completed.turn.error ?? undefined,
          finalAnswerItemId: state.finalAnswerItemId
        },
        "收到 Codex turn/completed"
      );

      if (completed.turn.status === "failed") {
        queue.push({
          kind: "error",
          message:
            completed.turn.error?.additionalDetails ?? completed.turn.error?.message ?? "Codex turn 失败"
        });
      } else if (completed.turn.status === "interrupted") {
        queue.push({
          kind: "error",
          message: "Codex turn 被中断"
        });
      } else if (completed.turn.status === "completed") {
        queue.push({
          kind: "run_status",
          status: "completed"
        });

        if (!state.finalAnswerItemId) {
          this.logger?.info(
            {
              threadId,
              turnId: state.currentTurnId
            },
            "Codex turn 未主动返回 final_answer，尝试 thread/read 回补"
          );
          const thread = await connection.request<{
            thread: {
              turns: Array<{
                id: string;
                items: Array<ThreadItem>;
              }>;
            };
          }>("thread/read", {
            threadId,
            includeTurns: true
          });

          const lastTurn = thread.thread.turns.at(-1);
          const lastAgentMessage = lastTurn?.items
            .filter((item) => item.type === "agentMessage" && typeof item.text === "string")
            .at(-1);

          if (lastAgentMessage?.text) {
            const source = lastAgentMessage.phase === "final_answer" ? "final_answer" : "commentary";
            const itemId = lastAgentMessage.id;
            state.finalAnswerItemId = itemId;
            queue.push({
              kind: "assistant_message_started",
              itemId,
              source
            });
            queue.push({
              kind: "assistant_message_completed",
              itemId,
              text: lastAgentMessage.text
            });
          }
        }

        if (state.finalAnswerItemId) {
          let rateLimitWindows: RateLimitWindow[] = [];
          try {
            rateLimitWindows = await this.readRateLimitWindows(connection);
          } catch (error) {
            this.logger?.warn(
              {
                threadId,
                turnId: state.currentTurnId,
                error: error instanceof Error ? error.message : String(error)
              },
              "读取 Codex 账号额度失败，本轮仅显示 token 用量"
            );
          }

          queue.push({
            kind: "turn_metrics",
            itemId: state.finalAnswerItemId,
            model: state.selectedModelDisplay,
            reasoningEffort: state.reasoningEffort,
            tokenUsage: state.latestTokenUsage,
            rateLimitWindows
          });
        }
      }

      queue.close();
      return;
    }

    if (message.method === "error") {
      const maybeError = params.error as
        | {
            message?: string;
          }
        | undefined;

      if (params.willRetry === true) {
        this.logger?.warn(
          {
            threadId,
            turnId: state.currentTurnId,
            error: maybeError?.message ?? "Codex App Server 正在重试"
          },
          "Codex 请求暂时失败，等待自动重试"
        );
        return;
      }

      queue.push({
        kind: "error",
        message: maybeError?.message ?? "Codex App Server 返回错误"
      });
      this.logger?.error(
        {
          threadId,
          turnId: state.currentTurnId,
          error: maybeError?.message ?? "Codex App Server 返回错误"
        },
        "收到 Codex error 通知"
      );
      queue.close();
    }
  }

  private async modelFor(context: CodexTurnContext): Promise<CodexModelInfo> {
    const models = (await this.listModels()).filter(isLiveSelectableModel);
    const requested = context.session?.model ?? this.getDefaultModel();
    const selected = models.find((model) => model.model === requested);
    if (selected) {
      return selected;
    }

    const fallback = models.find((model) => model.isDefault) ?? models[0];
    if (!fallback) {
      throw new Error("当前 ChatGPT 账号没有可用的 Codex 模型。");
    }
    if (requested.trim().toLowerCase() === "auto") {
      return fallback;
    }
    this.logger?.warn(
      {
        requestedModel: requested,
        fallbackModel: fallback.model,
        chatId: context.message.chatId
      },
      "已选择的 Codex 模型不再可用，改用当前账号默认模型"
    );
    return fallback;
  }

  private async readRoutingContext(
    connection: AppServerWsConnection,
    threadId?: string
  ): Promise<string> {
    if (!threadId || threadId.startsWith("pending:")) {
      return "";
    }

    try {
      const response = await connection.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true
      });
      const excerpts = response.thread.turns
        .slice(-3)
        .flatMap((turn) => turn.items ?? [])
        .flatMap((item) => {
          if (typeof item.text === "string" && item.text.trim()) {
            return [item.text.trim()];
          }
          const content = (item.content ?? [])
            .flatMap((part) => typeof part.text === "string" ? [part.text.trim()] : [])
            .filter(Boolean)
            .join(" ");
          return content ? [content] : [];
        })
        .slice(-4);
      return excerpts.join(" | ").slice(-1_200);
    } catch (error) {
      this.logger?.info(
        {
          threadId,
          error: error instanceof Error ? error.message : String(error)
        },
        "自动路由未读取到短上下文，仅使用当前消息"
      );
      return "";
    }
  }

  private async readRateLimitWindows(
    connection: AppServerWsConnection
  ): Promise<RateLimitWindow[]> {
    const response = await connection.request<AccountRateLimitsResponse>(
      "account/rateLimits/read",
      {}
    );
    const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
    return [snapshot.primary, snapshot.secondary].filter(
      (window): window is RateLimitWindow => Boolean(window && Number.isFinite(window.usedPercent))
    );
  }

  private handleRequest(
    connection: AppServerWsConnection,
    message: JsonRpcRequest,
    threadId: string
  ): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const targetThreadId = typeof params.threadId === "string" ? params.threadId : undefined;

    if (targetThreadId && targetThreadId !== threadId) {
      this.logger?.info(
        {
          targetThreadId,
          currentThreadId: threadId,
          method: message.method
        },
        "忽略属于其他 thread 的 Codex 服务端请求"
      );
      return;
    }

    this.logger?.warn(
      {
        threadId,
        method: message.method,
        requestId: message.id,
        params
      },
      "收到 Codex 服务端请求"
    );

    if (message.method === "item/commandExecution/requestApproval") {
      connection.respond(message.id, {
        decision: "decline"
      });
      this.logger?.warn(
        {
          threadId,
          method: message.method,
          requestId: message.id,
          decision: "decline"
        },
        "自动拒绝命令审批请求"
      );
      return;
    }

    if (message.method === "item/fileChange/requestApproval") {
      connection.respond(message.id, {
        decision: "decline"
      });
      this.logger?.warn(
        {
          threadId,
          method: message.method,
          requestId: message.id,
          decision: "decline"
        },
        "自动拒绝文件变更审批请求"
      );
      return;
    }

    if (message.method === "item/tool/requestUserInput") {
      connection.respond(message.id, {
        answers: {}
      });
      this.logger?.warn(
        {
          threadId,
          method: message.method,
          requestId: message.id
        },
        "自动返回空的工具用户输入"
      );
      return;
    }

    connection.respondError(message.id, -32601, `Unsupported server request: ${message.method}`);
    this.logger?.warn(
      {
        threadId,
        method: message.method,
        requestId: message.id
      },
      "Codex 服务端请求未支持，已返回错误"
    );
  }

  private async waitForServer(): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = 10_000;
    let lastError: unknown;

    while (Date.now() - startedAt < timeoutMs) {
      const connection = new AppServerWsConnection(this.env.CODEX_APP_SERVER_LISTEN_URL, {
        logger: this.logger,
        label: "wait-for-server"
      });
      try {
        await connection.connect();
        await connection.close();
        this.logger?.info("Codex App Server 健康探测通过");
        return;
      } catch (error) {
        lastError = error;
        this.logger?.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            elapsedMs: Date.now() - startedAt
          },
          "等待 Codex App Server 启动中"
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("等待 Codex App Server WebSocket 启动超时");
  }

  private extractPathsFromDiff(diff: string): string[] {
    const matches = diff.matchAll(/(?:\+\+\+|---)\s+[ab]\/([^\n]+)/g);
    const paths = new Set<string>();
    for (const match of matches) {
      const path = match[1];
      if (path) {
        paths.add(path);
      }
    }
    return Array.from(paths);
  }

  private pickTurnSnapshot(
    response: ThreadReadResponse,
    turnId?: string
  ): ThreadReadTurn | undefined {
    if (turnId) {
      const matchedTurn = response.thread.turns.find((turn) => turn.id === turnId);
      if (matchedTurn) {
        return matchedTurn;
      }
    }

    return response.thread.turns.at(-1);
  }

  private normalizeTurnStatus(status: unknown): "completed" | "failed" | "interrupted" | "inProgress" | undefined {
    if (status === "completed" || status === "failed" || status === "interrupted" || status === "inProgress") {
      return status;
    }

    if (status === "in_progress") {
      return "inProgress";
    }

    return undefined;
  }

  private replayTurnSnapshot(
    turn: ThreadReadTurn,
    state: TurnStreamState,
    queue: AsyncEventQueue<CodexEvent>
  ): void {
    for (const item of turn.items ?? []) {
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const source = item.phase === "final_answer" ? "final_answer" : "commentary";
        const previousText = state.agentTextByItemId.get(item.id);
        state.agentSourceByItemId.set(item.id, source);
        state.agentTextByItemId.set(item.id, item.text);
        if (source === "final_answer") {
          state.finalAnswerItemId = item.id;
        }

        if (!previousText) {
          queue.push({
            kind: "assistant_message_started",
            itemId: item.id,
            source
          });
        }

        if (previousText !== item.text) {
          queue.push({
            kind: "assistant_message_completed",
            itemId: item.id,
            text: item.text
          });
        }
        continue;
      }

      if (item.type === "commandExecution") {
        if (item.command) {
          state.commandByItemId.set(item.id, item.command);
        }
        if (item.aggregatedOutput) {
          state.commandOutputByItemId.set(item.id, item.aggregatedOutput);
        }
        queue.push({
          kind: "tool_call_started",
          itemId: item.id,
          title: "执行命令",
          command: item.command
        });
        queue.push({
          kind: "tool_call_completed",
          itemId: item.id,
          title: "执行命令",
          status: item.status === "failed" ? "failed" : "completed",
          output: item.aggregatedOutput ?? state.commandOutputByItemId.get(item.id)
        });
        continue;
      }

      if (item.type === "fileChange") {
        const paths = state.filePathsByItemId.get(item.id) ?? new Set<string>();
        for (const change of item.changes ?? []) {
          paths.add(change.path);
        }
        state.filePathsByItemId.set(item.id, paths);
        queue.push({
          kind: "tool_call_started",
          itemId: item.id,
          title: "修改文件"
        });
        queue.push({
          kind: "tool_call_completed",
          itemId: item.id,
          title: "修改文件",
          status: item.status === "failed" ? "failed" : "completed",
          paths: Array.from(paths)
        });
        continue;
      }

      if (item.type !== "reasoning" && item.type !== "userMessage") {
        const title = item.query?.trim() || describeToolType(item.type);
        queue.push({
          kind: "tool_call_started",
          itemId: item.id,
          title
        });
        queue.push({
          kind: "tool_call_completed",
          itemId: item.id,
          title,
          status: item.status === "failed" ? "failed" : "completed"
        });
      }
    }
  }
}
