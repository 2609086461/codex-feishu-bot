import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationItem } from "../../domain/types.js";
import {
  renderAssistantCardContent,
  renderEffortSelectionCard,
  renderModelSelectionCard,
  renderProjectSelectionCard,
  renderProgressCardContent,
  renderTaskCreationPromptCard,
  renderTaskSelectionCard,
  renderToolCardContent
} from "./feishu-card-renderer.js";

function createItem(overrides: Partial<ConversationItem> = {}): ConversationItem {
  const now = "2026-03-09T00:00:00.000Z";
  return {
    runId: "run_1",
    chatId: "oc_chat_1",
    sourceMessageId: "om_source_1",
    itemId: "item_1",
    order: 1,
    kind: "assistant_text",
    source: "commentary",
    phase: "completed",
    content: "先读取配置，再执行命令。",
    details: [],
    filePaths: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("renderAssistantCardContent marks commentary as non-final", () => {
  const payload = JSON.parse(renderAssistantCardContent(createItem()));

  assert.equal(payload.schema, "2.0");
  assert.equal(payload.body.elements[0].tag, "collapsible_panel");
  assert.equal(payload.body.elements[0].expanded, false);
  assert.equal(payload.body.elements[0].elements[0].tag, "markdown");
  assert.equal(payload.body.elements[0].elements[0].content, "先读取配置，再执行命令。");
  assert.equal(payload.header, undefined);
});

test("renderAssistantCardContent marks final answer separately", () => {
  const payload = JSON.parse(
    renderAssistantCardContent(
      createItem({
        itemId: "item_final",
        source: "final_answer",
        content: "最终只需要同步这一条结论。"
      })
    )
  );

  assert.equal(payload.schema, "2.0");
  assert.equal(payload.header, undefined);
  assert.equal(payload.body.elements[0].tag, "markdown");
  assert.equal(payload.body.elements[0].content, "最终只需要同步这一条结论。");
});

test("renderAssistantCardContent strips duplicated process paragraph from final answer", () => {
  const payload = JSON.parse(
    renderAssistantCardContent(
      createItem({
        itemId: "item_final_process",
        source: "final_answer",
        content: "- 中间过程：我先读了 package.json。\n\n- `build`: `tsc -p tsconfig.json`\n- `test`: `tsx --test`"
      })
    )
  );

  assert.equal(
    payload.body.elements[0].content,
    "- `build`: `tsc -p tsconfig.json`\n- `test`: `tsx --test`"
  );
});

test("renderToolCardContent emits markdown blocks for tool progress", () => {
  const payload = JSON.parse(
    renderToolCardContent(
      createItem({
        itemId: "tool_1",
        kind: "tool_card",
        source: "tool",
        title: "执行命令",
        command: "pnpm test",
        output: "all tests passed",
        details: ["启动测试", "收集输出"],
        filePaths: ["src/app.ts"]
      })
    )
  );

  assert.equal(payload.schema, "2.0");
  assert.equal(payload.header, undefined);
  assert.equal(payload.body.elements[0].tag, "collapsible_panel");
  assert.equal(payload.body.elements[0].expanded, false);
  assert.equal(payload.body.elements[0].header.title.tag, "markdown");
  assert.match(payload.body.elements[0].header.title.content, /\*\*已完成 · pnpm test\*\*/);
  assert.match(payload.body.elements[0].elements[0].content, /\*\*已完成\*\*/);
  assert.match(payload.body.elements[0].elements[0].content, /- 启动测试/);
  assert.match(payload.body.elements[0].elements[0].content, /```bash/);
  assert.match(payload.body.elements[0].elements[0].content, /\*\*输出\*\*/);
});

test("renderToolCardContent uses specific search query as folded title", () => {
  const payload = JSON.parse(
    renderToolCardContent(
      createItem({
        itemId: "tool_search_1",
        kind: "tool_card",
        source: "tool",
        title: "Escape from Tarkov latest patch notes 2026 official",
        details: ["完成搜索: Escape from Tarkov latest patch notes 2026 official"]
      })
    )
  );

  assert.match(
    payload.body.elements[0].header.title.content,
    /\*\*已完成 · Escape from Tarkov latest patch notes 2026 official\*\*/
  );
});

test("renderProgressCardContent renders a compact shared status card", () => {
  const payload = JSON.parse(
    renderProgressCardContent(
      createItem({
        itemId: "shared-progress",
        kind: "progress_card",
        source: "progress",
        phase: "streaming",
        progressPlan: [
          { step: "检查代码", status: "completed" },
          { step: "运行测试", status: "inProgress" },
          { step: "部署服务", status: "pending" }
        ],
        progressEntries: [
          {
            itemId: "tool_1",
            title: "执行命令",
            status: "completed",
            command: "pnpm test",
            filePaths: []
          },
          {
            itemId: "tool_2",
            title: "修改文件",
            status: "running",
            filePaths: ["src/app.ts"]
          }
        ]
      })
    )
  );

  assert.equal(payload.schema, "2.0");
  assert.equal(payload.header.template, "blue");
  assert.equal(payload.header.title.content, "正在处理");
  assert.match(payload.body.elements[0].content, /计划 1\/3/);
  assert.match(payload.body.elements[0].content, /\[x\] 检查代码/);
  assert.match(payload.body.elements[0].content, /执行命令.*pnpm test/);
  assert.match(payload.body.elements[0].content, /修改文件.*app\.ts/);
});

test("renderModelSelectionCard renders clickable automatic and model buttons", () => {
  const payload = JSON.parse(renderModelSelectionCard({
    currentModel: "自动",
    models: [
      { model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", isDefault: false },
      { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true }
    ]
  }));

  assert.equal(payload.header.title.content, "选择 Codex 模型");
  assert.equal(payload.elements[1].tag, "action");
  assert.deepEqual(payload.elements[1].actions[0].value, { kind: "auto_select" });
  assert.deepEqual(payload.elements[1].actions[2].value, {
    kind: "model_select",
    model: "gpt-5.6-sol"
  });
});

test("renderEffortSelectionCard splits six choices into button rows", () => {
  const payload = JSON.parse(renderEffortSelectionCard({
    model: "GPT-5.6-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((value) => ({
      value,
      label: value
    }))
  }));

  const actionRows = payload.elements.filter((element: { tag: string }) => element.tag === "action");
  assert.equal(actionRows.length, 2);
  assert.equal(actionRows[0].actions.length, 3);
  assert.equal(actionRows[1].actions.length, 3);
});

test("project and task selection cards carry stable ids instead of list indexes", () => {
  const projectCard = JSON.parse(renderProjectSelectionCard({
    projects: [{ id: "project-1", name: "机器人", detail: "Git main@12345678", current: true }]
  }));
  assert.deepEqual(projectCard.elements[1].actions[0].value, {
    kind: "project_select",
    projectId: "project-1"
  });

  const taskCard = JSON.parse(renderTaskSelectionCard({
    projectName: "机器人",
    tasks: [{ id: "task-1", name: "卡片交互", current: false }]
  }));
  assert.deepEqual(taskCard.elements[1].actions[0].value, {
    kind: "task_select",
    taskId: "task-1"
  });
  assert.deepEqual(taskCard.elements[2].actions[0].value, {
    kind: "task_create_prompt"
  });

  const createPrompt = JSON.parse(renderTaskCreationPromptCard({ projectName: "机器人" }));
  assert.equal(createPrompt.header.title.content, "新建任务");
  assert.match(createPrompt.elements[0].text.content, /发送任务名称/);
});
