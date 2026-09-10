import assert from "node:assert/strict";
import test from "node:test";

import type { CodexModelInfo } from "../../domain/types.js";
import {
  buildRouterPrompt,
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

test("automatic routing excludes the GPT-6/Astra family", () => {
  const withAstra: CodexModelInfo[] = [
    {
      id: "gpt-6-astra",
      model: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      description: "expensive",
      hidden: false,
      isDefault: true
    },
    models[1]!
  ];

  assert.equal(pickRouterModel(withAstra)?.model, "gpt-5.6-sol");
  assert.doesNotMatch(buildRouterPrompt("帮我写代码", "", [], withAstra), /gpt-6-astra/i);
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
