import assert from "node:assert/strict";
import test from "node:test";

import { normalizeModelName, parseChatSettingsCommand } from "./chat-settings-command.js";

test("parseChatSettingsCommand parses model commands", () => {
  assert.deepEqual(parseChatSettingsCommand("模型"), { kind: "model_list" });
  assert.deepEqual(parseChatSettingsCommand("切换模型 GPT-5.4 Mini"), {
    kind: "model_set",
    value: "GPT-5.4 Mini"
  });
  assert.deepEqual(parseChatSettingsCommand("/model gpt-5.6-sol"), {
    kind: "model_set",
    value: "gpt-5.6-sol"
  });
  assert.deepEqual(parseChatSettingsCommand("换成5.6的模型"), {
    kind: "model_set",
    value: "5.6"
  });
  assert.deepEqual(parseChatSettingsCommand("GPT-5.6-Sol"), {
    kind: "model_set",
    value: "GPT-5.6-Sol"
  });
});

test("parseChatSettingsCommand parses reasoning summary toggles", () => {
  assert.deepEqual(parseChatSettingsCommand("过程"), { kind: "reasoning_status" });
  assert.deepEqual(parseChatSettingsCommand("思考 开"), {
    kind: "reasoning_set",
    enabled: true
  });
  assert.deepEqual(parseChatSettingsCommand("/reasoning off"), {
    kind: "reasoning_set",
    enabled: false
  });
});

test("parseChatSettingsCommand parses reasoning effort commands", () => {
  assert.deepEqual(parseChatSettingsCommand("思考"), { kind: "effort_status" });
  assert.deepEqual(parseChatSettingsCommand("思考 轻度"), {
    kind: "effort_set",
    effort: "low"
  });
  assert.deepEqual(parseChatSettingsCommand("思考 极高"), {
    kind: "effort_set",
    effort: "xhigh"
  });
  assert.deepEqual(parseChatSettingsCommand("思考 最高"), {
    kind: "effort_set",
    effort: "max"
  });
  assert.deepEqual(parseChatSettingsCommand("思考 Ultra"), {
    kind: "effort_set",
    effort: "ultra"
  });
});

test("normalizeModelName ignores spaces, hyphens and underscores", () => {
  assert.equal(normalizeModelName("GPT-5.4 Mini"), normalizeModelName("gpt_5.4-mini"));
});
