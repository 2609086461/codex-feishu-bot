import type {
  CodexModelInfo,
  CodexRouteDecision,
  ReasoningEffort
} from "../../domain/types.js";
import type { ModelCreditRates } from "./model-pricing.js";

export const ALL_REASONING_EFFORTS: ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
];

const AUTO_ROUTE_CONFIDENCE_THRESHOLD = 0.65;

/**
 * `model/list` is emitted by the signed-in Codex app server, so it is the
 * account-specific source of truth.  Do not infer availability from a model
 * name: ChatGPT entitlements and the catalog both change over time.
 */
export function isLiveSelectableModel(model: CodexModelInfo): boolean {
  return Boolean(model.model.trim()) && !model.hidden;
}

// Explicit user exclusions apply to these exact legacy IDs, never a version prefix.
const EXCLUDED_AUTO_MODELS = new Set(["gpt-6", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);

export function isAutoRoutableModel(model: CodexModelInfo): boolean {
  return isLiveSelectableModel(model) &&
    !EXCLUDED_AUTO_MODELS.has(model.model.toLowerCase());
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

function byUnitCost(models: CodexModelInfo[], rates: ModelCreditRates): CodexModelInfo[] {
  return [...models].sort((a, b) => {
    const left = rates[a.model];
    const right = rates[b.model];
    if (!left || !right) return left ? -1 : right ? 1 : 0;
    return left.output - right.output || left.input - right.input || left.cachedInput - right.cachedInput;
  });
}

export function pickRouterModel(models: CodexModelInfo[], rates: ModelCreditRates = {}): CodexModelInfo | undefined {
  const visible = models.filter(isAutoRoutableModel);
  const light = visible.filter((model) => /luna|spark|fast|lightweight|efficient|mini/i.test(
    `${model.model} ${model.description}`
  ));
  return byUnitCost(light, rates)[0] ??
    visible.find((model) => model.isDefault) ??
    byUnitCost(visible, rates)[0];
}

export function pickBalancedFallback(models: CodexModelInfo[], rates: ModelCreditRates = {}): CodexModelInfo | undefined {
  const visible = models.filter(isAutoRoutableModel);
  // Among comparable everyday/strong candidates use live costs, not catalog order.
  const balanced = visible.filter((model) => /sol/i.test(model.model) ||
    (model.isDefault && !/luna|mini|spark/i.test(model.model)));
  return byUnitCost(balanced, rates)[0] ??
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
  models: CodexModelInfo[],
  rates: ModelCreditRates = {}
): CodexRouteDecision {
  const fallback = pickBalancedFallback(models, rates);
  if (!fallback) {
    throw new Error("没有可用于自动路由的 Codex 模型");
  }

  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const selected = typeof value.model === "string"
    ? models.find((model) =>
      isAutoRoutableModel(model) && model.model === value.model
    )
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
  models: CodexModelInfo[],
  rates: ModelCreditRates = {}
): string {
  const candidates = models
    .filter(isAutoRoutableModel)
    .map((model) => {
      const rate = rates[model.model];
      const price = rate ? `信用点/百万token:输入=${rate.input},缓存输入=${rate.cachedInput},输出=${rate.output}` : "费率未知，不能按免费计算";
      return `${model.model}[${reasoningEffortsFor(model).join("/")}] ${price};能力说明=${model.description.slice(0, 240)}`;
    })
    .join("\n");

  return [
    "为下一条 Codex 任务选择模型和推理强度：先根据任务要求判断能力需求，再在能胜任的候选中比较成本。",
    "简单问答、提取、格式整理优先轻量候选/low；一般分析和小修改用平衡候选/low或medium；多步骤编码、排障、部署、科研和重要文档优先能力更强的候选/medium或high。仅明显困难的任务使用xhigh/max/ultra。",
    "费率来自官方Codex Standard信用点表，仅用于相对成本比较，不能换算套餐内剩余次数。结合输入、缓存输入、输出费率及预计上下文/输出长度；单位token便宜不保证整项任务便宜，反复失败的任务应提高能力和思考强度。",
    "候选能力依据账号下发说明和本次任务，不能仅凭模型版本号判断；相近能力优先低成本。新模型按同一规则评估，费率未知时优先已知成本且能胜任的候选；全部未知时按能力说明选择，不编造价格或能力分数。",
    `明确排除的旧模型ID=${[...EXCLUDED_AUTO_MODELS].join(",")}；只从下面候选选，不按版本前缀排除未来模型。`,
    "不要调用任何工具。只返回符合 schema 的 JSON。reason 不超过 20 个汉字。",
    `候选（支持的思考强度、费率、能力说明）：\n${candidates}`,
    recentContext ? `短上下文=${recentContext}` : "短上下文=(无)",
    attachmentKinds.length > 0 ? `附件=${attachmentKinds.join(",")}` : "附件=(无)",
    `新消息=${messageText.slice(0, 1600)}`
  ].join("\n");
}
