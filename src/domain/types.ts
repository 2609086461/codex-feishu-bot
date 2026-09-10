export interface IncomingChatMessage {
  chatId: string;
  chatType: string;
  messageId: string;
  senderId: string;
  senderName: string;
  senderType: string;
  tenantKey?: string;
  messageType?: string;
  text: string;
  attachments?: IncomingChatAttachment[];
  mentionsBot: boolean;
  raw: unknown;
}

export interface IncomingCardAction {
  chatId: string;
  messageId?: string;
  operatorOpenId: string;
  actionToken?: string;
  value: Record<string, unknown>;
  raw: unknown;
}

export interface IncomingChatAttachment {
  kind: "image";
  key: string;
  path?: string;
}

export interface ChatTask {
  id: string;
  name: string;
  threadId: string;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatProject {
  id: string;
  name: string;
  workspaceId: string;
  codexProjectId?: string;
  git?: {
    remoteUrl: string;
    branch: string;
    lastCommit: string;
    lastSyncedAt: string;
  };
  tasks: ChatTask[];
  activeTaskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexWorkspaceThread {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface CodexWorkspaceProject {
  id: string;
  name: string;
  roots: string[];
  threads: CodexWorkspaceThread[];
  createdAt: number;
  updatedAt: number;
}

export interface ChatSession {
  chatId: string;
  threadId: string;
  workspaceId: string;
  projects?: ChatProject[];
  activeProjectId?: string;
  pendingNavigation?: {
    kind: "project" | "task";
    ids: string[];
    createdAt: string;
  };
  pendingTaskCreation?: {
    projectId: string;
    operatorOpenId: string;
    createdAt: string;
  };
  pendingProjectCreation?: {
    operatorOpenId: string;
    createdAt: string;
  };
  model?: string;
  modelDisplayName?: string;
  pendingModelOptions?: Array<{
    model: string;
    displayName: string;
  }>;
  pendingModelSelectionAt?: string;
  pendingModelForEffort?: {
    model: string;
    displayName: string;
  };
  pendingEffortOptions?: ReasoningEffort[];
  pendingEffortSelectionAt?: string;
  routingMode?: "auto" | "manual";
  lastAutoRoute?: {
    model: string;
    displayName: string;
    reasoningEffort: ReasoningEffort;
    confidence: number;
    reason: string;
    routedAt: string;
  };
  showReasoningSummary?: boolean;
  reasoningEffort?: ReasoningEffort;
  activeRunId?: string;
  activeTurnId?: string;
  updatedAt: string;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: Array<
    | ReasoningEffort
    | {
        reasoningEffort: ReasoningEffort;
      }
  >;
}

export interface CodexRouteDecision {
  model: string;
  displayName: string;
  reasoningEffort: ReasoningEffort;
  confidence: number;
  reason: string;
}

export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface RunRecord {
  runId: string;
  chatId: string;
  threadId: string;
  sourceMessageId: string;
  status: RunStatus;
  errorMessage?: string;
  startedAt: string;
  updatedAt: string;
}

export type ConversationItemKind = "assistant_text" | "tool_card" | "progress_card" | "artifact_file";
export type ConversationItemPhase = "queued" | "streaming" | "completed" | "failed";
export type ConversationItemSource = "commentary" | "final_answer" | "tool" | "progress" | "artifact";

export interface ProgressPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface ProgressEntry {
  itemId: string;
  title: string;
  status: "running" | "completed" | "failed";
  command?: string;
  detail?: string;
  filePaths: string[];
}

export interface ConversationItem {
  runId: string;
  chatId: string;
  sourceMessageId: string;
  itemId: string;
  order: number;
  kind: ConversationItemKind;
  source: ConversationItemSource;
  phase: ConversationItemPhase;
  title?: string;
  content?: string;
  command?: string;
  output?: string;
  details: string[];
  filePaths: string[];
  artifactPath?: string;
  footer?: string;
  progressPlan?: ProgressPlanStep[];
  progressEntries?: ProgressEntry[];
  feishuMessageId?: string;
  deliveredContentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export type CodexEvent =
  | {
      kind: "thread_bound";
      threadId: string;
    }
  | {
      kind: "turn_bound";
      turnId: string;
    }
  | {
      kind: "run_status";
      status: RunStatus;
      detail?: string;
    }
  | {
      kind: "plan_updated";
      explanation?: string;
      plan: ProgressPlanStep[];
    }
  | {
      kind: "assistant_message_started";
      itemId: string;
      source: Extract<ConversationItemSource, "commentary" | "final_answer">;
    }
  | {
      kind: "assistant_message_delta";
      itemId: string;
      text: string;
    }
  | {
      kind: "assistant_message_completed";
      itemId: string;
      text: string;
    }
  | {
      kind: "tool_call_started";
      itemId: string;
      title: string;
      command?: string;
    }
  | {
      kind: "tool_call_delta";
      itemId: string;
      detail?: string;
      output?: string;
      path?: string;
    }
  | {
      kind: "tool_call_completed";
      itemId: string;
      title?: string;
      status: "completed" | "failed";
      output?: string;
      paths?: string[];
    }
  | {
      kind: "artifact_ready";
      itemId: string;
      title?: string;
      path: string;
    }
  | {
      kind: "turn_metrics";
      itemId: string;
      model: string;
      reasoningEffort: ReasoningEffort;
      tokenUsage?: ThreadTokenUsage;
      rateLimitWindows: RateLimitWindow[];
    }
  | {
      kind: "error";
      message: string;
    };
