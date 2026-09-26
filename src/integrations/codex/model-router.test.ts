import assert from "node:assert/strict";
import test from "node:test";

import type { CodexModelInfo } from "../../domain/types.js";
import {
  buildRouterPrompt,
  isAutoRoutableModel,
  isLiveSelectableModel,
  normalizeRouteDecision,
  pickRouterModel,
  reasoningEffortsFor
} from "./model-router.js";

const models: CodexModelInfo[] = [
  {
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "fast",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"]
  },
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "balanced",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" }
    ]
  }
];

test("pickRouterModel prefers the fast Luna model", () => {
  assert.equal(pickRouterModel(models)?.model, "gpt-5.6-luna");
});

test("the live app-server model list is authoritative over static model-name rules", () => {
  const newlyAvailableMini: CodexModelInfo = {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    description: "now enabled for this ChatGPT account",
    hidden: false,
    isDefault: false
  };
  const newlyAvailableLegacyName: CodexModelInfo = {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "now enabled for this ChatGPT account",
    hidden: false,
    isDefault: true
  };
  assert.equal(isLiveSelectableModel(newlyAvailableMini), true);
  assert.equal(isLiveSelectableModel(newlyAvailableLegacyName), true);
  assert.equal(
    pickRouterModel([newlyAvailableMini, newlyAvailableLegacyName])?.model,
    "gpt-5.4"
  );
  assert.equal(
    normalizeRouteDecision(
      { model: "gpt-5.4-mini", effort: "low", confidence: 0.99, reason: "简单任务" },
      [newlyAvailableMini, newlyAvailableLegacyName]
    ).model,
    "gpt-5.4-mini"
  );
});

test("GPT-6 Astra remains manually available but is never selected automatically", () => {
  const astra: CodexModelInfo = {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    description: "highest quality",
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: ["medium", "high"]
  };
  const candidates = [astra, ...models];

  assert.equal(isLiveSelectableModel(astra), true);
  assert.equal(isAutoRoutableModel(astra), false);
  assert.equal(pickRouterModel(candidates)?.model, "gpt-5.6-luna");
  assert.equal(
    normalizeRouteDecision(
      { model: "gpt-6-astra", effort: "high", confidence: 0.99, reason: "复杂任务" },
      candidates
    ).model,
    "gpt-5.6-sol"
  );
  assert.doesNotMatch(buildRouterPrompt("部署", "", [], candidates), /gpt-6-astra\[/);
});

test("reasoningEffortsFor supports app-server object entries", () => {
  assert.deepEqual(reasoningEffortsFor(models[1]!), ["low", "medium", "high"]);
});

test("normalizeRouteDecision accepts a confident supported choice", () => {
  assert.deepEqual(
    normalizeRouteDecision(
      { model: "gpt-5.6-luna", effort: "low", confidence: 0.91, reason: "简单格式整理" },
      models
    ),
    {
      model: "gpt-5.6-luna",
      displayName: "GPT-5.6-Luna",
      reasoningEffort: "low",
      confidence: 0.91,
      reason: "简单格式整理"
    }
  );
});

test("normalizeRouteDecision falls back to Sol when confidence is low", () => {
  const decision = normalizeRouteDecision(
    { model: "gpt-5.6-luna", effort: "low", confidence: 0.4, reason: "不确定" },
    models
  );
  assert.equal(decision.model, "gpt-5.6-sol");
  assert.equal(decision.reasoningEffort, "medium");
});
