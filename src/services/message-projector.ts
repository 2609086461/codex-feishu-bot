import { basename } from "node:path";

import type { CodexEvent, ConversationItem, ProgressEntry, RunRecord } from "../domain/types.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { RunStore } from "../stores/run-store.js";
import { formatReasoningEffort } from "./chat-settings-command.js";

interface ProjectionResult {
  run: RunRecord;
  items: ConversationItem[];
}

function appendUnique(items: string[], value: string, limit: number): string[] {
  const next = items.filter((item) => item !== value);
  next.push(value);
  return next.slice(-limit);
}

const MAX_FILES = 12;
const MAX_PROGRESS_ENTRIES = 12;
const PROGRESS_ITEM_ID = "shared-progress";

function upsertProgressEntry(entries: ProgressEntry[], next: ProgressEntry): ProgressEntry[] {
  const index = entries.findIndex((entry) => entry.itemId === next.itemId);
  if (index < 0) {
    return [...entries, next].slice(-MAX_PROGRESS_ENTRIES);
  }
  const updated = [...entries];
  updated[index] = next;
  return updated;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatResetTime(timestamp?: number | null): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp * 1000));
}

function formatWindowName(minutes?: number | null): string {
  if (minutes === 300) {
    return "5 小时额度";
  }
  if (minutes === 10_080) {
    return "每周额度";
  }
  if (minutes && minutes % 1_440 === 0) {
    return `${minutes / 1_440} 天额度`;
  }
  if (minutes && minutes % 60 === 0) {
    return `${minutes / 60} 小时额度`;
  }
  return minutes ? `${minutes} 分钟额度` : "账号额度";
}

export function formatTurnMetrics(event: Extract<CodexEvent, { kind: "turn_metrics" }>): string {
  const lines = [
    `模型：${event.model}｜推理：${formatReasoningEffort(event.reasoningEffort)}`
  ];
  const usage = event.tokenUsage?.last;
  if (usage) {
    const parts = [
      `输入 ${formatNumber(usage.inputTokens)}`,
      `输出 ${formatNumber(usage.outputTokens)}`
    ];
    if (usage.cachedInputTokens > 0) {
      parts.push(`缓存 ${formatNumber(usage.cachedInputTokens)}`);
    }
    if (usage.reasoningOutputTokens > 0) {
      parts.push(`推理 ${formatNumber(usage.reasoningOutputTokens)}`);
    }
    lines.push(`本轮：${formatNumber(usage.totalTokens)} tokens（${parts.join("，")}）`);
  }

  for (const window of event.rateLimitWindows) {
    const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
    const reset = formatResetTime(window.resetsAt);
    lines.push(
      `${formatWindowName(window.windowDurationMins)}：剩余 ${remaining}%${reset ? `，${reset} 重置` : ""}`
    );
  }
  return lines.join("\n");
}

export class MessageProjector {
  constructor(
    private readonly runStore: RunStore,
    private readonly conversationStore: ConversationStore
  ) {}

  apply(runId: string, event: CodexEvent): ProjectionResult {
    const run = this.runStore.get(runId);
    if (!run) {
      throw new Error(`run not found: ${runId}`);
    }

    switch (event.kind) {
      case "thread_bound":
        return {
          run: this.runStore.update(runId, {
            threadId: event.threadId
          }) ?? run,
          items: []
        };
      case "turn_bound":
        return {
          run,
          items: []
        };
      case "run_status":
        {
          const updatedRun = this.runStore.setStatus(
            runId,
            event.status,
            event.status === "failed" ? event.detail : undefined
          ) ?? run;
          const progress = this.conversationStore.get(runId, PROGRESS_ITEM_ID);
          if (!progress || (event.status !== "completed" && event.status !== "failed")) {
            return { run: updatedRun, items: [] };
          }
          const item = this.conversationStore.update(runId, PROGRESS_ITEM_ID, {
            phase: event.status === "failed" ? "failed" : "completed"
          }) ?? progress;
          return { run: updatedRun, items: [item] };
        }
      case "plan_updated": {
        const current = this.ensureProgressItem(run);
        const item = this.conversationStore.update(runId, PROGRESS_ITEM_ID, {
          phase: "streaming",
          content: event.explanation ?? current.content,
          progressPlan: event.plan
        }) ?? current;
        return {
          run: this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "assistant_message_started": {
        const item = this.ensureItem(run, event.itemId, "assistant_text", event.source, {
          phase: "queued"
        });
        return {
          run: event.source === "final_answer"
            ? this.runStore.setStatus(runId, "running") ?? run
            : run,
          items: [item]
        };
      }
      case "assistant_message_delta": {
        const current =
          this.conversationStore.get(runId, event.itemId) ??
          this.ensureItem(run, event.itemId, "assistant_text", "commentary");
        const item = this.conversationStore.update(runId, event.itemId, {
          phase: "streaming",
          content: `${current.content ?? ""}${event.text}`
        }) ?? current;
        return {
          run: this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "assistant_message_completed": {
        const current =
          this.conversationStore.get(runId, event.itemId) ??
          this.ensureItem(run, event.itemId, "assistant_text", "final_answer");
        const item = this.conversationStore.update(runId, event.itemId, {
          phase: "completed",
          content: event.text
        }) ?? current;
        return {
          run: item.source === "final_answer"
            ? this.runStore.setStatus(runId, "completed") ?? run
            : this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "tool_call_started": {
        const current = this.ensureProgressItem(run);
        const entry: ProgressEntry = {
          itemId: event.itemId,
          title: event.title,
          status: "running",
          command: event.command,
          filePaths: []
        };
        const item = this.conversationStore.update(runId, PROGRESS_ITEM_ID, {
          phase: "streaming",
          progressEntries: upsertProgressEntry(current.progressEntries ?? [], entry)
        }) ?? current;
        return {
          run: this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "tool_call_delta": {
        const current = this.ensureProgressItem(run);
        const entries = current.progressEntries ?? [];
        const existing = entries.find((entry) => entry.itemId === event.itemId);
        const entry: ProgressEntry = {
          itemId: event.itemId,
          title: existing?.title ?? "工具调用",
          status: "running",
          command: existing?.command,
          detail: event.detail ?? existing?.detail,
          filePaths: event.path
            ? appendUnique(existing?.filePaths ?? [], event.path, MAX_FILES)
            : existing?.filePaths ?? []
        };
        const item = this.conversationStore.update(runId, PROGRESS_ITEM_ID, {
          phase: "streaming",
          progressEntries: upsertProgressEntry(entries, entry)
        }) ?? current;
        return {
          run: this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "tool_call_completed": {
        const current = this.ensureProgressItem(run);
        const entries = current.progressEntries ?? [];
        const existing = entries.find((entry) => entry.itemId === event.itemId);
        let filePaths = existing?.filePaths ?? [];
        for (const path of event.paths ?? []) {
          filePaths = appendUnique(filePaths, path, MAX_FILES);
        }
        const entry: ProgressEntry = {
          itemId: event.itemId,
          title: event.title ?? existing?.title ?? "工具调用",
          status: event.status,
          command: existing?.command,
          detail: existing?.detail,
          filePaths
        };
        const item = this.conversationStore.update(runId, PROGRESS_ITEM_ID, {
          phase: "streaming",
          progressEntries: upsertProgressEntry(entries, entry)
        }) ?? current;
        return {
          run: this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "artifact_ready": {
        const item = this.ensureItem(run, event.itemId, "artifact_file", "artifact", {
          phase: "completed",
          title: event.title ?? basename(event.path),
          artifactPath: event.path
        });
        return {
          run: this.runStore.setStatus(runId, "running") ?? run,
          items: [item]
        };
      }
      case "turn_metrics": {
        const current = this.conversationStore.get(runId, event.itemId);
        if (!current) {
          return {
            run,
            items: []
          };
        }
        const item = this.conversationStore.update(runId, event.itemId, {
          footer: formatTurnMetrics(event)
        }) ?? current;
        return {
          run,
          items: [item]
        };
      }
      case "error": {
        const errorItemId = `error:${runId}`;
        const item =
          this.conversationStore.get(runId, errorItemId) ??
          this.ensureItem(run, errorItemId, "assistant_text", "final_answer", {
            phase: "failed",
            content: event.message
          });
        const failedItem = this.conversationStore.update(runId, errorItemId, {
          phase: "failed",
          content: event.message
        }) ?? item;
        const progress = this.conversationStore.get(runId, PROGRESS_ITEM_ID);
        const failedProgress = progress
          ? this.conversationStore.update(runId, PROGRESS_ITEM_ID, { phase: "failed" }) ?? progress
          : undefined;
        return {
          run: this.runStore.setStatus(runId, "failed", event.message) ?? run,
          items: failedProgress ? [failedProgress, failedItem] : [failedItem]
        };
      }
    }
  }

  list(runId: string): ConversationItem[] {
    return this.conversationStore.listByRun(runId);
  }

  private ensureProgressItem(run: RunRecord): ConversationItem {
    return this.ensureItem(run, PROGRESS_ITEM_ID, "progress_card", "progress", {
      phase: "streaming",
      progressPlan: [],
      progressEntries: []
    });
  }

  private ensureItem(
    run: RunRecord,
    itemId: string,
    kind: ConversationItem["kind"],
    source: ConversationItem["source"],
    patch: Partial<ConversationItem> = {}
  ): ConversationItem {
    const existing = this.conversationStore.get(run.runId, itemId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const item: ConversationItem = {
      runId: run.runId,
      chatId: run.chatId,
      sourceMessageId: run.sourceMessageId,
      itemId,
      order: this.conversationStore.listByRun(run.runId).length + 1,
      kind,
      source,
      phase: "queued",
      details: [],
      filePaths: [],
      createdAt: now,
      updatedAt: now,
      ...patch
    };

    this.conversationStore.save(item);
    return item;
  }
}
