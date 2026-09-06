import assert from "node:assert/strict";
import test from "node:test";

import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { MessageProjector } from "./message-projector.js";

test("MessageProjector keeps final answer separate from the shared progress card", () => {
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const run = runStore.create({
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_source_1"
  });

  projector.apply(run.runId, {
    kind: "tool_call_started",
    itemId: "tool_1",
    title: "读取文件"
  });
  projector.apply(run.runId, {
    kind: "tool_call_completed",
    itemId: "tool_1",
    status: "completed"
  });
  projector.apply(run.runId, {
    kind: "assistant_message_started",
    itemId: "msg_final",
    source: "final_answer"
  });
  projector.apply(run.runId, {
    kind: "assistant_message_delta",
    itemId: "msg_final",
    text: "最终结果"
  });
  projector.apply(run.runId, {
    kind: "assistant_message_completed",
    itemId: "msg_final",
    text: "最终结果"
  });

  assert.deepEqual(
    projector.list(run.runId).map((item) => [item.itemId, item.kind, item.phase]),
    [
      ["shared-progress", "progress_card", "streaming"],
      ["msg_final", "assistant_text", "completed"]
    ]
  );
});

test("MessageProjector aggregates plans and tools into one shared progress card", () => {
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const run = runStore.create({
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_source_1"
  });

  projector.apply(run.runId, {
    kind: "plan_updated",
    plan: [
      { step: "读取代码", status: "completed" },
      { step: "运行测试", status: "inProgress" }
    ]
  });
  projector.apply(run.runId, {
    kind: "tool_call_started",
    itemId: "tool_1",
    title: "执行命令",
    command: "pnpm test"
  });
  projector.apply(run.runId, {
    kind: "tool_call_completed",
    itemId: "tool_1",
    status: "completed"
  });
  projector.apply(run.runId, {
    kind: "tool_call_started",
    itemId: "tool_2",
    title: "修改文件"
  });
  projector.apply(run.runId, {
    kind: "tool_call_delta",
    itemId: "tool_2",
    path: "src/app.ts"
  });

  const items = projector.list(run.runId);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.itemId, "shared-progress");
  assert.deepEqual(items[0]?.progressPlan, [
    { step: "读取代码", status: "completed" },
    { step: "运行测试", status: "inProgress" }
  ]);
  assert.deepEqual(
    items[0]?.progressEntries?.map((entry) => [entry.itemId, entry.status, entry.filePaths]),
    [
      ["tool_1", "completed", []],
      ["tool_2", "running", ["src/app.ts"]]
    ]
  );

  projector.apply(run.runId, { kind: "run_status", status: "completed" });
  assert.equal(conversationStore.get(run.runId, "shared-progress")?.phase, "completed");
});

test("MessageProjector keeps commentary and final answer as separate assistant items", () => {
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const run = runStore.create({
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_source_1"
  });

  projector.apply(run.runId, {
    kind: "assistant_message_started",
    itemId: "msg_commentary",
    source: "commentary"
  });
  projector.apply(run.runId, {
    kind: "assistant_message_completed",
    itemId: "msg_commentary",
    text: "这是一条中间过程"
  });
  projector.apply(run.runId, {
    kind: "assistant_message_started",
    itemId: "msg_final",
    source: "final_answer"
  });
  projector.apply(run.runId, {
    kind: "assistant_message_completed",
    itemId: "msg_final",
    text: "这是一条最终结论"
  });

  assert.deepEqual(
    projector.list(run.runId).map((item) => [item.itemId, item.source, item.content]),
    [
      ["msg_commentary", "commentary", "这是一条中间过程"],
      ["msg_final", "final_answer", "这是一条最终结论"]
    ]
  );
});

test("MessageProjector appends turn token usage and account quota to the final item", () => {
  const runStore = new RunStore();
  const conversationStore = new ConversationStore();
  const projector = new MessageProjector(runStore, conversationStore);
  const run = runStore.create({
    chatId: "oc_chat_1",
    threadId: "thread_1",
    sourceMessageId: "om_source_1"
  });

  projector.apply(run.runId, {
    kind: "assistant_message_completed",
    itemId: "msg_final",
    text: "完成",
  });
  projector.apply(run.runId, {
    kind: "turn_metrics",
    itemId: "msg_final",
    model: "GPT-5.4 Mini",
    reasoningEffort: "medium",
    tokenUsage: {
      last: {
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1500
      },
      total: {
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1500
      },
      modelContextWindow: 272000
    },
    rateLimitWindows: [
      {
        usedPercent: 35,
        windowDurationMins: 300
      }
    ]
  });

  const item = conversationStore.get(run.runId, "msg_final");
  assert.match(item?.footer ?? "", /GPT-5\.4 Mini/);
  assert.match(item?.footer ?? "", /推理：中等/);
  assert.match(item?.footer ?? "", /1,500 tokens/);
  assert.match(item?.footer ?? "", /5 小时额度：剩余 65%/);
});
