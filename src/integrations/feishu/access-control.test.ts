import assert from "node:assert/strict";
import test from "node:test";

import type { IncomingChatMessage } from "../../domain/types.js";
import { authorizeFeishuMessage, createFeishuAccessPolicy } from "./access-control.js";

const baseMessage: IncomingChatMessage = {
  chatId: "oc_chat",
  chatType: "p2p",
  messageId: "om_message",
  senderId: "ou_owner",
  senderName: "ou_owner",
  senderType: "user",
  text: "hello",
  mentionsBot: false,
  raw: {}
};

test("denies every message when the allowlist is empty", () => {
  const decision = authorizeFeishuMessage(baseMessage, createFeishuAccessPolicy("", false));
  assert.deepEqual(decision, { allowed: false, reason: "empty_allowlist" });
});

test("denies a sender outside the allowlist", () => {
  const decision = authorizeFeishuMessage(
    baseMessage,
    createFeishuAccessPolicy("ou_someone_else", false)
  );
  assert.deepEqual(decision, { allowed: false, reason: "sender_not_allowed" });
});

test("allows the owner in a private chat", () => {
  const decision = authorizeFeishuMessage(
    baseMessage,
    createFeishuAccessPolicy("ou_owner, ou_second", false)
  );
  assert.deepEqual(decision, { allowed: true });
});

test("requires an explicit opt-in for group messages", () => {
  const groupMessage = { ...baseMessage, chatType: "group" };
  assert.equal(
    authorizeFeishuMessage(groupMessage, createFeishuAccessPolicy("ou_owner", false)).allowed,
    false
  );
  assert.equal(
    authorizeFeishuMessage(groupMessage, createFeishuAccessPolicy("ou_owner", true)).allowed,
    true
  );
});
