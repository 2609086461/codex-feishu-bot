import assert from "node:assert/strict";
import test from "node:test";

import type { CodexModelInfo } from "../../domain/types.js";
import {
  buildRouterPrompt,
  isAutoRoutableModel,
  isLiveSelectableModel,
  normalizeRouteDecision,
  pickBalancedFallback,
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
    "gpt-5.4-mini"
  );
  assert.equal(
    normalizeRouteDecision(
      { model: "gpt-5.4-mini", effort: "low", confidence: 0.99, reason: "简单任务" },
      [newlyAvailableMini, newlyAvailableLegacyName]
    ).model,
    "gpt-5.4-mini"
  );
});

test("GPT-6 Astra is available to automatic routing when the account exposes it", () => {
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
  assert.equal(isAutoRoutableModel(astra), true);
  assert.equal(pickRouterModel(candidates)?.model, "gpt-5.6-luna");
  assert.equal(
    normalizeRouteDecision(
      { model: "gpt-6-astra", effort: "high", confidence: 0.99, reason: "复杂任务" },
      candidates
    ).model,
    "gpt-6-astra"
  );
  assert.match(buildRouterPrompt("部署", "", [], candidates), /gpt-6-astra\[/);
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

test("all live model versions remain available to automatic routing", () => {
  for (const name of ["gpt-6", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
    assert.equal(isAutoRoutableModel({ ...models[1]!, model: name }), true);
  }
  for (const name of ["gpt-6.1-sol", "gpt-7.2-sol"]) {
    assert.equal(isAutoRoutableModel({ ...models[1]!, model: name, displayName: "Near-Astra quality" }), true);
  }
});

test("fallback uses comparable model costs instead of version or catalog ordering", () => {
  const next: CodexModelInfo = { ...models[1]!, id: "gpt-7.2-sol", model: "gpt-7.2-sol", isDefault: false };
  const rates = {
    "gpt-5.6-sol": { input: 100, cachedInput: 10, output: 500 },
    "gpt-7.2-sol": { input: 40, cachedInput: 2, output: 200 }
  };
  for (const candidates of [[...models, next], [next, ...models]]) {
    assert.equal(pickBalancedFallback(candidates, rates)?.model, "gpt-7.2-sol");
    assert.equal(normalizeRouteDecision({}, candidates, rates).model, "gpt-7.2-sol");
    assert.equal(normalizeRouteDecision({}, candidates, rates).reasoningEffort, "medium");
  }
});

test("the router picks the lowest priced lightweight candidate and marks unknown prices", () => {
  const unknown = { ...models[0]!, id: "gpt-8-luna", model: "gpt-8-luna" };
  const cheaper = { ...models[0]!, id: "gpt-7.2-luna", model: "gpt-7.2-luna" };
  const rates = {
    "gpt-5.6-luna": { input: 5, cachedInput: 0.5, output: 30 },
    "gpt-7.2-luna": { input: 2, cachedInput: 0.2, output: 10 }
  };
  const candidates = [unknown, ...models, cheaper];
  assert.equal(pickRouterModel(candidates, rates)?.model, cheaper.model);
  const prompt = buildRouterPrompt("分析科研论文的实验结果", "", [], candidates, rates);
  assert.match(prompt, /输入=2,缓存输入=0.2,输出=10/);
  assert.match(prompt, /费率未知，不能按免费计算/);
  assert.match(prompt, /不能仅凭模型版本号判断/);
  assert.doesNotMatch(prompt, /自动路由禁止选择 GPT-6 或 Astra/);
});
