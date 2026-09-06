import type { ReasoningEffort } from "../domain/types.js";

export type ChatSettingsCommand =
  | { kind: "model_list" }
  | { kind: "model_set"; value: string }
  | { kind: "model_pick"; index: number }
  | { kind: "reasoning_status" }
  | { kind: "reasoning_set"; enabled: boolean }
  | { kind: "effort_status" }
  | { kind: "effort_set"; effort: ReasoningEffort };

function normalizeToggle(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["开", "开启", "打开", "显示", "on", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["关", "关闭", "隐藏", "off", "false", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function normalizeReasoningEffort(value: string): ReasoningEffort | undefined {
  const normalized = value.trim().toLowerCase();
  if (["轻", "轻度", "低", "low"].includes(normalized)) {
    return "low";
  }
  if (["中", "中等", "medium"].includes(normalized)) {
    return "medium";
  }
  if (["高", "high"].includes(normalized)) {
    return "high";
  }
  if (["极高", "xhigh"].includes(normalized)) {
    return "xhigh";
  }
  if (["最高", "最大", "max"].includes(normalized)) {
    return "max";
  }
  if (["ultra", "超级"].includes(normalized)) {
    return "ultra";
  }
  return undefined;
}

export function formatReasoningEffort(effort: ReasoningEffort): string {
  return {
    low: "轻度",
    medium: "中等",
    high: "高",
    xhigh: "极高",
    max: "最高",
    ultra: "Ultra"
  }[effort];
}

export function parseChatSettingsCommand(text: string): ChatSettingsCommand | undefined {
  const trimmed = text.trim();
  if (/^(模型|\/model)$/i.test(trimmed)) {
    return { kind: "model_list" };
  }

  const modelMatch = trimmed.match(/^(?:切换模型|模型|\/model)\s*[:：]?\s+(.+)$/i);
  if (modelMatch?.[1]?.trim()) {
    return {
      kind: "model_set",
      value: modelMatch[1].trim()
    };
  }

  const naturalModelMatch = trimmed.match(
    /^(?:请|帮我)?\s*(?:换成|切换到|切换为|改成|使用)\s*(.+)$/i
  );
  if (naturalModelMatch?.[1]?.trim()) {
    const value = naturalModelMatch[1].replace(/(?:的)?模型$/i, "").trim();
    if (value) {
      return { kind: "model_set", value };
    }
  }

  if (/^gpt[\s._-]*\d/i.test(trimmed)) {
    return { kind: "model_set", value: trimmed };
  }

  if (/^(思考)$/i.test(trimmed)) {
    return { kind: "effort_status" };
  }

  const effortMatch = trimmed.match(/^(?:思考|推理强度|\/effort)\s*[:：]?\s+(.+)$/i);
  if (effortMatch?.[1]) {
    const effort = normalizeReasoningEffort(effortMatch[1]);
    if (effort) {
      return {
        kind: "effort_set",
        effort
      };
    }
  }

  if (/^(过程|思考过程|\/reasoning)$/i.test(trimmed)) {
    return { kind: "reasoning_status" };
  }

  const reasoningMatch = trimmed.match(
    /^(?:过程|思考过程|思考|\/reasoning)\s*[:：]?\s+(.+)$/i
  );
  if (reasoningMatch?.[1]) {
    const enabled = normalizeToggle(reasoningMatch[1]);
    if (enabled !== undefined) {
      return {
        kind: "reasoning_set",
        enabled
      };
    }
  }

  return undefined;
}

export function normalizeModelName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}
