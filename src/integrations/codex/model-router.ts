import type {
  CodexModelInfo,
  CodexRouteDecision,
  ReasoningEffort
} from "../../domain/types.js";

export const ALL_REASONING_EFFORTS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
];

const AUTO_ROUTE_CONFIDENCE_THRESHOLD = 0.65;

// The owner can still choose every visible model manually. Automatic routing
// deliberately avoids the highest-cost GPT-6/Astra family.
export function isAutoRouteEligible(model: CodexModelInfo): boolean {
  return !model.hidden && !/gpt[ -]?6|astra/i.test(`${model.model} ${model.displayName}`);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && ALL_REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function reasoningEffortsFor(model: CodexModelInfo): ReasoningEffort[] {
  const supported = (model.supportedReasoningEfforts ?? []).flatMap((entry) => {
    const effort = typeof entry === "string" ? entry : entry.reasoningEffort;
    return isReasoningEffort(effort) ? [effort] : [];
  });

  return supported.length > 0 ? supported : ALL_REASONING_EFFORTS;
}

export function pickRouterModel(models: CodexModelInfo[]): CodexModelInfo | undefined {
  const visible = models.filter(isAutoRouteEligible);
  return visible.find((model) => /luna/i.test(model.model)) ??
    visible.find((model) => /mini|fast|nano/i.test(`${model.model} ${model.displayName}`)) ??
    visible.find((model) => model.isDefault) ??
    visible[0];
}

export function pickBalancedFallback(models: CodexModelInfo[]): CodexModelInfo | undefined {
  const visible = models.filter(isAutoRouteEligible);
  return visible.find((model) => /sol/i.test(model.model)) ??
    visible.find((model) => /terra/i.test(model.model)) ??
    visible.find((model) => model.isDefault) ??
    visible[0];
}

function preferredEffort(model: CodexModelInfo, requested?: unknown): ReasoningEffort {
  const supported = reasoningEffortsFor(model);
  if (isReasoningEffort(requested) && supported.includes(requested)) {
    return requested;
  }
  if (model.defaultReasoningEffort && supported.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return supported.includes("medium") ? "medium" : (supported[0] ?? "low");
}

export function normalizeRouteDecision(
  raw: unknown,
  models: CodexModelInfo[]
): CodexRouteDecision {
  const fallback = pickBalancedFallback(models);
  if (!fallback) {
    throw new Error("没有可用于自动路由的 Codex 模型");
  }

  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const selected = typeof value.model === "string"
    ? models.find((model) => !model.hidden && model.model === value.model)
    : undefined;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0;
  const accepted = selected && confidence >= AUTO_ROUTE_CONFIDENCE_THRESHOLD;
  const model = accepted ? selected : fallback;
  const reason = accepted && typeof value.reason === "string" && value.reason.trim()
    ? value.reason.trim().slice(0, 80)
    : "置信度不足，使用平衡模型";

  return {
    model: model.model,
    displayName: model.displayName,
    reasoningEffort: accepted
      ? preferredEffort(model, value.effort)
      : (reasoningEffortsFor(model).includes("medium") ? "medium" : preferredEffort(model)),
    confidence,
    reason
  };
}

export function buildRouterPrompt(
  messageText: string,
  recentContext: string,
  attachmentKinds: string[],
  models: CodexModelInfo[]
): string {
  const candidates = models
    .filter(isAutoRouteEligible)
    .map((model) => `${model.model}[${reasoningEffortsFor(model).join("/")}]`)
    .join(",");

  return [
    "为下一条 Codex 任务选择模型和推理强度。目标：简单任务省时省 token，复杂任务优先质量。",
    "规则：luna/mini 处理简短问答、改写、格式化和重复工作；terra 处理普通分析或单点代码任务；sol 处理多步骤编码、排障、部署和重要文档；astra 只用于最复杂、高风险或强推理任务。",
    "不要调用任何工具。只返回符合 schema 的 JSON。reason 不超过 20 个汉字。",
    `候选=${candidates}`,
    recentContext ? `短上下文=${recentContext}` : "短上下文=(无)",
    attachmentKinds.length > 0 ? `附件=${attachmentKinds.join(",")}` : "附件=(无)",
    `新消息=${messageText.slice(0, 1600)}`
  ].join("\n");
}
