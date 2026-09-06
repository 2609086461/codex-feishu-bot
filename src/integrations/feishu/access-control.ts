import type { IncomingChatMessage } from "../../domain/types.js";

export interface FeishuAccessPolicy {
  allowedOpenIds: ReadonlySet<string>;
  allowGroupMessages: boolean;
}

export interface FeishuAccessDecision {
  allowed: boolean;
  reason?: "empty_allowlist" | "sender_not_allowed" | "group_messages_disabled";
}

export function createFeishuAccessPolicy(
  rawAllowedOpenIds: string,
  allowGroupMessages: boolean
): FeishuAccessPolicy {
  return {
    allowedOpenIds: new Set(
      rawAllowedOpenIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
    allowGroupMessages
  };
}

export function authorizeFeishuMessage(
  message: IncomingChatMessage,
  policy: FeishuAccessPolicy
): FeishuAccessDecision {
  if (policy.allowedOpenIds.size === 0) {
    return { allowed: false, reason: "empty_allowlist" };
  }

  if (!policy.allowedOpenIds.has(message.senderId)) {
    return { allowed: false, reason: "sender_not_allowed" };
  }

  if (!policy.allowGroupMessages && message.chatType !== "p2p") {
    return { allowed: false, reason: "group_messages_disabled" };
  }

  return { allowed: true };
}
