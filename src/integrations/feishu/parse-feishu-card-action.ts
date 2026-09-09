import { z } from "zod";

import type { IncomingCardAction } from "../../domain/types.js";

const cardActionSchema = z.object({
  operator: z.object({
    open_id: z.string().optional(),
    openId: z.string().optional()
  }).passthrough(),
  action: z.object({
    value: z.record(z.unknown()).optional()
  }).passthrough(),
  context: z.object({
    open_chat_id: z.string().optional(),
    openChatId: z.string().optional(),
    chat_id: z.string().optional(),
    chatId: z.string().optional(),
    open_message_id: z.string().optional(),
    openMessageId: z.string().optional(),
    message_id: z.string().optional(),
    messageId: z.string().optional()
  }).passthrough(),
  token: z.string().optional()
}).passthrough();

export type FeishuCardActionParseResult =
  | { ok: true; action: IncomingCardAction }
  | { ok: false; reason: string };

export function parseFeishuCardAction(data: unknown): FeishuCardActionParseResult {
  const candidate = data && typeof data === "object" && "event" in data
    ? (data as { event?: unknown }).event
    : data;
  const parsed = cardActionSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: "卡片事件结构不完整" };
  }

  const operatorOpenId = parsed.data.operator.open_id ?? parsed.data.operator.openId;
  const chatId = parsed.data.context.open_chat_id ??
    parsed.data.context.openChatId ??
    parsed.data.context.chat_id ??
    parsed.data.context.chatId;
  if (!operatorOpenId || !chatId) {
    return { ok: false, reason: "卡片事件缺少操作者或会话标识" };
  }

  return {
    ok: true,
    action: {
      chatId,
      messageId: parsed.data.context.open_message_id ??
        parsed.data.context.openMessageId ??
        parsed.data.context.message_id ??
        parsed.data.context.messageId,
      operatorOpenId,
      actionToken: parsed.data.token,
      value: parsed.data.action.value ?? {},
      raw: data
    }
  };
}
