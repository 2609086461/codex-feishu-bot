import assert from "node:assert/strict";
import test from "node:test";

import type { CodexEvent, ConversationItem, IncomingChatMessage } from "../domain/types.js";
import type { CodexWorker } from "../integrations/codex/codex-worker.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { SessionStore } from "../stores/session-store.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import type { GitProjectServiceLike } from "./git-project-service.js";
import { MessageProjector } from "./message-projector.js";

function createMessage(overrides: Partial<IncomingChatMessage> = {}): IncomingChatMessage {
  return {
    chatId: "oc_group_1",
    chatType: "group",
    messageId: "om_group_1",
    senderId: "ou_user_1",
    senderName: "user-1",
    senderType: "user",
    text: "直接说一句，不带 @",
    mentionsBot: false,
    raw: {},
    ...overrides
  };
}

function createLogger() {
  return {
    info() {
      return undefined;
    },
    warn() {
      return undefined;
    },
    error() {
      return undefined;
    }
  };
}

test("ChatOrchestrator accepts group messages without mentions", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const scheduledItemIds: string[] = [];
  let runTurnCalls = 0;
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      yield {
        kind: "thread_bound",
        threadId: "thread_accepted_1"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_accepted_1"
      };
      yield {
        kind: "assistant_message_started",
        itemId: "msg_final_1",
        source: "final_answer"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "msg_final_1",
        text: "收到"
      };
      resolveTurn?.();
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      schedule(item: ConversationItem) {
        scheduledItemIds.push(item.itemId);
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage());

  await turnCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runTurnCalls, 1);
  assert.equal(runStore.list().length, 1);
  assert.deepEqual(scheduledItemIds, ["msg_final_1", "msg_final_1"]);
  assert.equal(conversationStore.list().length, 1);
  assert.equal(conversationStore.list()[0]?.content, "收到");
});

test("ChatOrchestrator steers into the active turn instead of creating a new queued run", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const existingRun = runStore.create({
    chatId: "oc_group_1",
    threadId: "thread_active_1",
    sourceMessageId: "om_original_1"
  });
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_active_1",
    workspaceId: "/workspace",
    activeRunId: existingRun.runId,
    activeTurnId: "turn_active_1",
    updatedAt: new Date().toISOString()
  });
  let steerCalls = 0;
  let runTurnCalls = 0;
  let resolveSteer: (() => void) | undefined;
  const steerCompleted = new Promise<void>((resolve) => {
    resolveSteer = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_active_1";
    },
    async steerTurn(context) {
      steerCalls += 1;
      assert.equal(context.threadId, "thread_active_1");
      assert.equal(context.turnId, "turn_active_1");
      assert.equal(context.message.messageId, "om_group_steer_1");
      resolveSteer?.();
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_group_steer_1",
      text: "这条应该直接补充给正在运行的 turn"
    })
  );

  await steerCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(steerCalls, 1);
  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 1);
  assert.equal(runStore.list()[0]?.sourceMessageId, "om_group_steer_1");
});

test("ChatOrchestrator interrupts an active turn for an explicit pause command", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const existingRun = runStore.create({
    chatId: "oc_group_1",
    threadId: "thread_active_1",
    sourceMessageId: "om_original_1"
  });
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_active_1",
    workspaceId: "/workspace",
    activeRunId: existingRun.runId,
    activeTurnId: "turn_active_1",
    updatedAt: new Date().toISOString()
  });
  let interruptCalls = 0;
  let steerCalls = 0;
  let runTurnCalls = 0;
  let reply = "";
  let resolveInterrupt: (() => void) | undefined;
  const interrupted = new Promise<void>((resolve) => {
    resolveInterrupt = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_active_1";
    },
    async steerTurn() {
      steerCalls += 1;
    },
    async interruptTurn(context) {
      interruptCalls += 1;
      assert.equal(context.threadId, "thread_active_1");
      assert.equal(context.turnId, "turn_active_1");
      resolveInterrupt?.();
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      schedule() {
        return undefined;
      },
      async sendText(_chatId: string, content: string) {
        reply = content;
        return "om_pause_reply";
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ messageId: "om_pause_1", text: "暂停" }));
  await interrupted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(interruptCalls, 1);
  assert.equal(steerCalls, 0);
  assert.equal(runTurnCalls, 0);
  assert.equal(reply, "已中断当前任务。");
});

test("ChatOrchestrator ignores app-sent group messages to avoid loops", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      yield {
        kind: "run_status",
        status: "completed"
      };
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(
    createMessage({
      messageId: "om_bot_1",
      senderId: "cli_bot_1",
      senderName: "codex",
      senderType: "app",
      text: "机器人自己发的话"
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(runTurnCalls, 0);
  assert.equal(runStore.list().length, 0);
  assert.equal(conversationStore.list().length, 0);
});

test("ChatOrchestrator ignores duplicated incoming message ids", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  const codexWorker: CodexWorker = {
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
      yield {
        kind: "thread_bound",
        threadId: "thread_existing"
      };
      yield {
        kind: "turn_bound",
        turnId: "turn_existing"
      };
      yield {
        kind: "assistant_message_started",
        itemId: "msg_final_duplicate",
        source: "final_answer"
      };
      yield {
        kind: "assistant_message_completed",
        itemId: "msg_final_duplicate",
        text: "只发一次"
      };
      resolveTurn?.();
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  const message = createMessage({
    messageId: "om_duplicate_1",
    text: "同一条飞书消息被重复投递"
  });

  orchestrator.enqueue(message);
  orchestrator.enqueue(message);

  await turnCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runTurnCalls, 1);
  assert.equal(runStore.list().length, 1);
  assert.equal(conversationStore.list().length, 1);
});

test("ChatOrchestrator switches models without starting a Codex turn", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let runTurnCalls = 0;
  let resolveReply: (() => void) | undefined;
  const replied = new Promise<void>((resolve) => {
    resolveReply = resolve;
  });

  const codexWorker: CodexWorker = {
    getDefaultModel() {
      return "gpt-default";
    },
    async listModels() {
      return [
        {
          id: "gpt-fast",
          model: "gpt-fast",
          displayName: "GPT Fast",
          description: "fast",
          hidden: false,
          isDefault: false
        }
      ];
    },
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      runTurnCalls += 1;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText(_chatId: string, content: string) {
        assert.match(content, /GPT Fast/);
        resolveReply?.();
        return "om_settings_1";
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ text: "切换模型 GPT Fast" }));
  await replied;

  assert.equal(runTurnCalls, 0);
  assert.equal(sessionStore.get("oc_group_1")?.model, "gpt-fast");
  assert.equal(sessionStore.get("oc_group_1")?.modelDisplayName, "GPT Fast");
});

test("ChatOrchestrator switches to a model by replying with its menu number", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const replies: string[] = [];
  let resolveSecondReply: (() => void) | undefined;
  const secondReply = new Promise<void>((resolve) => {
    resolveSecondReply = resolve;
  });

  const codexWorker: CodexWorker = {
    async listModels() {
      return [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "sol",
          hidden: false,
          isDefault: false
        },
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "terra",
          hidden: false,
          isDefault: false
        }
      ];
    },
    async ensureThread() {
      return "thread_existing";
    },
    async *runTurn(): AsyncGenerator<CodexEvent> {
      return;
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText(_chatId: string, content: string) {
        replies.push(content);
        if (replies.length === 2) {
          resolveSecondReply?.();
        }
        return `om_settings_${replies.length}`;
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    codexWorker,
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ messageId: "om_model_list", text: "模型" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  orchestrator.enqueue(createMessage({ messageId: "om_model_pick", text: "2" }));
  await secondReply;

  assert.match(replies[0] ?? "", /1\. GPT-5\.6-Sol/);
  assert.match(replies[1] ?? "", /模型已切换为 GPT-5\.6-Terra/);
  assert.equal(sessionStore.get("oc_group_1")?.model, "gpt-5.6-terra");
  assert.equal(sessionStore.get("oc_group_1")?.pendingModelOptions, undefined);
});

test("ChatOrchestrator asks the user to disambiguate a model family", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let resolveReply: (() => void) | undefined;
  const replied = new Promise<void>((resolve) => {
    resolveReply = resolve;
  });

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText(_chatId: string, content: string) {
        assert.match(content, /匹配到多个模型/);
        assert.match(content, /GPT-5\.6-Sol/);
        assert.match(content, /GPT-5\.6-Terra/);
        resolveReply?.();
        return "om_settings_ambiguous";
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    {
      async listModels() {
        return [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: "sol",
            hidden: false,
            isDefault: false
          },
          {
            id: "gpt-5.6-terra",
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            description: "terra",
            hidden: false,
            isDefault: false
          }
        ];
      },
      async ensureThread() {
        return "thread_existing";
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {
        return;
      }
    },
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ text: "换成5.6的模型" }));
  await replied;

  assert.equal(sessionStore.get("oc_group_1")?.model, undefined);
  assert.equal(sessionStore.get("oc_group_1")?.pendingModelOptions?.length, 2);
});

test("ChatOrchestrator persists the reasoning summary preference", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  let resolveReply: (() => void) | undefined;
  const replied = new Promise<void>((resolve) => {
    resolveReply = resolve;
  });

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText(_chatId: string, content: string) {
        assert.match(content, /思考摘要已开启/);
        resolveReply?.();
        return "om_settings_2";
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    {
      async ensureThread() {
        return "thread_existing";
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {
        return;
      }
    },
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ text: "思考 开" }));
  await replied;

  assert.equal(sessionStore.get("oc_group_1")?.showReasoningSummary, true);
});

test("ChatOrchestrator creates an isolated task and can return to the previous thread", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_original",
    workspaceId: "/workspace",
    updatedAt: new Date().toISOString()
  });
  const replies: string[] = [];

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText(_chatId: string, content: string) {
        replies.push(content);
        return `om_workspace_${replies.length}`;
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    {
      async ensureThread() {
        return "thread_unused";
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {
        return;
      }
    },
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ messageId: "om_task_new", text: "新任务 简历优化" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const createdSession = sessionStore.get("oc_group_1");
  const project = createdSession?.projects?.[0];
  assert.equal(project?.tasks.length, 2);
  assert.match(createdSession?.threadId ?? "", /^pending:/);
  assert.match(replies[0] ?? "", /全新的 Codex 对话/);

  orchestrator.enqueue(createMessage({ messageId: "om_task_list", text: "任务" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  orchestrator.enqueue(createMessage({ messageId: "om_task_pick", text: "1" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_original");
  assert.match(replies.at(-1) ?? "", /默认任务/);
});

test("ChatOrchestrator starts a pending task in runTurn without precreating a thread", async () => {
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_original",
    workspaceId: "/workspace",
    updatedAt: new Date().toISOString()
  });
  let ensureThreadCalls = 0;
  let resolveTurn: (() => void) | undefined;
  const turnCompleted = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText() {
        return "om_pending_reply";
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    {
      async ensureThread() {
        ensureThreadCalls += 1;
        return "thread_precreated_in_error";
      },
      async *runTurn(context): AsyncGenerator<CodexEvent> {
        assert.match(context.threadId, /^pending:/);
        yield { kind: "thread_bound", threadId: "thread_first_turn" };
        yield { kind: "run_status", status: "completed" };
        resolveTurn?.();
      }
    },
    "/workspace",
    createLogger()
  );

  orchestrator.enqueue(createMessage({ messageId: "om_pending_new", text: "新任务 首轮验证" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  orchestrator.enqueue(createMessage({ messageId: "om_pending_turn", text: "开始工作" }));
  await turnCompleted;
  await new Promise((resolve) => setTimeout(resolve, 0));

  const session = sessionStore.get("oc_group_1");
  const project = session?.projects?.find((item) => item.id === session.activeProjectId);
  const task = project?.tasks.find((item) => item.id === project.activeTaskId);
  assert.equal(ensureThreadCalls, 0);
  assert.equal(session?.threadId, "thread_first_turn");
  assert.equal(task?.threadId, "thread_first_turn");
});

test("ChatOrchestrator binds and syncs a Git project, then switches back by number", async () => {
  const root = "/workspace";
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_original",
    workspaceId: root,
    updatedAt: new Date().toISOString()
  });
  let resolveReply: (() => void) | undefined;
  const waitForReply = () => new Promise<void>((resolve) => {
    resolveReply = resolve;
  });

  let synced = false;
  const gitProjectService: GitProjectServiceLike = {
    validateRemoteUrl(remoteUrl) {
      return remoteUrl;
    },
    validateBranch(branch) {
      return branch;
    },
    async clone(remoteUrl, workspaceId, branch) {
      assert.equal(remoteUrl, "git@github.com:cai/resume.git");
      assert.match(workspaceId.replace(/\\/g, "/"), /^\/workspace\/repos\//);
      assert.equal(branch, "main");
      return { branch: "main", commit: "1234567890abcdef", changed: true };
    },
    async sync(workspaceId, branch) {
      synced = true;
      assert.match(workspaceId.replace(/\\/g, "/"), /^\/workspace\/repos\//);
      assert.equal(branch, "main");
      return { branch, commit: "abcdef1234567890", changed: true };
    }
  };

  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText() {
        resolveReply?.();
        resolveReply = undefined;
        return "om_project_reply";
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    {
      async ensureThread() {
        return "thread_unused";
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {
        return;
      }
    },
    root,
    createLogger(),
    gitProjectService
  );

  const bound = waitForReply();
  orchestrator.enqueue(createMessage({
    messageId: "om_project_bind",
    text: "绑定项目 简历 git@github.com:cai/resume.git main"
  }));
  await bound;

  const createdSession = sessionStore.get("oc_group_1");
  assert.equal(createdSession?.projects?.length, 2);
  assert.notEqual(createdSession?.workspaceId, root);
  assert.equal(createdSession?.projects?.[1]?.git?.branch, "main");

  const synchronized = waitForReply();
  orchestrator.enqueue(createMessage({ messageId: "om_project_sync", text: "同步项目" }));
  await synchronized;
  assert.equal(synced, true);
  assert.equal(sessionStore.get("oc_group_1")?.projects?.[1]?.git?.lastCommit, "abcdef1234567890");

  const listed = waitForReply();
  orchestrator.enqueue(createMessage({ messageId: "om_project_list", text: "项目" }));
  await listed;
  const selected = waitForReply();
  orchestrator.enqueue(createMessage({ messageId: "om_project_pick", text: "1" }));
  await selected;

  assert.equal(sessionStore.get("oc_group_1")?.workspaceId, root);
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "thread_original");
});

test("ChatOrchestrator imports Codex desktop projects and resumes their threads", async () => {
  const root = "C:\\workspace";
  const desktopRoot = "C:\\Users\\cai\\Desktop\\camera-project";
  const sessionStore = new SessionStore();
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  sessionStore.save({
    chatId: "oc_group_1",
    threadId: "thread_original",
    workspaceId: root,
    updatedAt: new Date().toISOString()
  });
  const replies: string[] = [];
  const orchestrator = new ChatOrchestrator(
    sessionStore,
    runStore,
    conversationStore,
    {
      async sendText(_chatId: string, text: string) {
        replies.push(text);
        return "om_project_reply";
      },
      schedule() {
        return undefined;
      },
      async flushRun() {
        return undefined;
      }
    } as never,
    projector,
    {
      async listWorkspaceProjects() {
        return [{
          id: "desktop-project-1",
          name: "Camera Driver",
          roots: [desktopRoot],
          threads: [{
            id: "desktop-thread-1",
            name: "修复 V4L2 驱动",
            cwd: desktopRoot,
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_100
          }],
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_100
        }];
      },
      async ensureThread() {
        return "thread_unused";
      },
      async *runTurn(): AsyncGenerator<CodexEvent> {
        return;
      }
    },
    root,
    createLogger()
  );

  orchestrator.enqueue(createMessage({ messageId: "om_desktop_projects", text: "项目" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const imported = sessionStore.get("oc_group_1")?.projects?.[0];
  assert.equal(imported?.name, "Camera Driver");
  assert.equal(imported?.codexProjectId, "desktop-project-1");
  assert.equal(imported?.tasks[0]?.threadId, "desktop-thread-1");
  assert.match(replies[0] ?? "", /本地 Codex/);

  orchestrator.enqueue(createMessage({ messageId: "om_desktop_pick", text: "1" }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sessionStore.get("oc_group_1")?.workspaceId, desktopRoot);
  assert.equal(sessionStore.get("oc_group_1")?.threadId, "desktop-thread-1");
});
