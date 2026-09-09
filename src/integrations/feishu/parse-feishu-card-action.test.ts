import assert from "node:assert/strict";
import test from "node:test";

import { parseFeishuCardAction } from "./parse-feishu-card-action.js";

test("parseFeishuCardAction supports WebSocket card.action.trigger payload", () => {
  const result = parseFeishuCardAction({
    operator: { open_id: "ou_owner" },
    token: "event-token",
    action: {
      tag: "button",
      value: { kind: "model_select", model: "gpt-5.6-sol" }
    },
    context: {
      open_chat_id: "oc_chat",
      open_message_id: "om_card"
    }
  });

  assert.deepEqual(result, {
    ok: true,
    action: {
      chatId: "oc_chat",
      messageId: "om_card",
      operatorOpenId: "ou_owner",
      actionToken: "event-token",
      value: { kind: "model_select", model: "gpt-5.6-sol" },
      raw: {
        operator: { open_id: "ou_owner" },
        token: "event-token",
        action: {
          tag: "button",
          value: { kind: "model_select", model: "gpt-5.6-sol" }
        },
        context: {
          open_chat_id: "oc_chat",
          open_message_id: "om_card"
        }
      }
    }
  });
});

test("parseFeishuCardAction supports camelCase callback fields", () => {
  const result = parseFeishuCardAction({
    event: {
      operator: { openId: "ou_owner" },
      action: { value: { kind: "auto_select" } },
      context: { openChatId: "oc_chat", openMessageId: "om_card" }
    }
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.chatId, "oc_chat");
    assert.equal(result.action.operatorOpenId, "ou_owner");
  }
});
