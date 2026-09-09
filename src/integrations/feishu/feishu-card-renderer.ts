import { basename } from "node:path";

import type { ConversationItem } from "../../domain/types.js";

interface LegacyInteractiveCard {
  config: {
    wide_screen_mode: boolean;
    enable_forward: boolean;
    update_multi: boolean;
  };
  header: {
    template: "blue" | "green" | "orange" | "red" | "wathet" | "grey";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  elements: Array<Record<string, unknown>>;
}

interface InteractiveCard {
  schema: "2.0";
  config: {
    wide_screen_mode: boolean;
    enable_forward: boolean;
    update_multi: boolean;
  };
  header?: {
    template: "blue" | "green" | "orange" | "red" | "wathet" | "grey";
    title: {
      tag: "plain_text";
      content: string;
    };
  };
  body: {
    elements: Array<Record<string, unknown>>;
  };
}

function markdownBlock(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_align: "left"
  };
}

function collapsiblePanel(title: string, content: string): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: title
      },
      width: "auto_when_fold",
      vertical_align: "center",
      padding: "2px 0 2px 6px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "14px 14px"
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180
    },
    padding: "6px 8px 6px 8px",
    vertical_spacing: "6px",
    border: {
      color: "grey",
      corner_radius: "5px"
    },
    elements: [markdownBlock(content)]
  };
}

function markdownTitleCollapsiblePanel(title: string, content: string): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: title
      },
      width: "auto_when_fold",
      vertical_align: "center",
      padding: "2px 0 2px 6px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        size: "14px 14px"
      },
      icon_position: "follow_text",
      icon_expanded_angle: -180
    },
    padding: "6px 8px 6px 8px",
    vertical_spacing: "6px",
    border: {
      color: "grey",
      corner_radius: "5px"
    },
    elements: [markdownBlock(content)]
  };
}

function divider(): Record<string, unknown> {
  return {
    tag: "hr"
  };
}

function stripLeadingLabel(body: string, labels: string[]): string {
  const pattern = new RegExp(
    `^(?:[-*]\\s*)?(?:${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*[：:]\\s*`,
    "u"
  );
  return body.replace(pattern, "").trim();
}

function stripLeadingProcessParagraph(body: string): string {
  return body
    .replace(/^(?:[-*]\s*)?(?:中间过程|过程同步|过程说明)\s*[：:].*?(?:\n\s*\n|$)/su, "")
    .trim();
}

function summarizeTitle(body: string, fallback: string, maxLength = 48): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("```"));

  if (!firstLine) {
    return fallback;
  }

  const normalized = firstLine
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*#>\d.)\s]+/u, "")
    .replace(/[|`*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return fallback;
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function processPreviewTitle(body: string): string {
  return summarizeTitle(body, "过程");
}

function summarizeCommand(command: string): string {
  const shellWrapped = command.match(/^\/bin\/bash -lc\s+(.+)$/);
  const raw = shellWrapped?.[1] ?? command;
  const unquoted = raw.replace(/^['"]|['"]$/g, "");
  return summarizeTitle(unquoted, "命令", 56);
}

function summarizeFilePaths(paths: string[]): string {
  const firstPath = paths[0];
  if (!firstPath) {
    return "文件";
  }

  if (paths.length === 1) {
    return basename(firstPath);
  }

  return `${basename(firstPath)} 等 ${paths.length} 个文件`;
}

function summarizeToolTitle(item: ConversationItem): string {
  if (item.command) {
    return summarizeCommand(item.command);
  }

  if (item.filePaths.length > 0) {
    return summarizeFilePaths(item.filePaths);
  }

  if (item.title && !["执行命令", "修改文件", "工具调用"].includes(item.title)) {
    return item.title;
  }

  return summarizeTitle(item.details.join("\n"), "处理");
}

function escapeMarkdownText(text: string): string {
  return text
    .replace(/\\/g, "&#92;")
    .replace(/</g, "&#60;")
    .replace(/>/g, "&#62;");
}

function fencedCode(content: string, language?: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  const maxBackticks = Math.max(...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length), 2);
  const fence = "`".repeat(maxBackticks + 1);
  const lang = language?.trim() ? language.trim() : "";
  return `${fence}${lang}\n${normalized}\n${fence}`;
}

function toolPhaseLabel(phase: ConversationItem["phase"]): string {
  switch (phase) {
    case "queued":
      return "等待执行";
    case "streaming":
      return "执行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
  }
}

function progressHeader(phase: ConversationItem["phase"]): {
  template: InteractiveCard["header"] extends infer T
    ? T extends { template: infer U }
      ? U
      : never
    : never;
  title: string;
} {
  switch (phase) {
    case "completed":
      return { template: "green", title: "执行完成" };
    case "failed":
      return { template: "red", title: "执行失败" };
    case "queued":
      return { template: "grey", title: "等待执行" };
    case "streaming":
      return { template: "blue", title: "正在处理" };
  }
}

function progressMark(status: "pending" | "inProgress" | "completed" | "running" | "failed"): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "inProgress":
    case "running":
      return "[>]";
    case "failed":
      return "[!]";
    case "pending":
      return "[ ]";
  }
}

function formatElapsed(item: ConversationItem): string {
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.parse(item.updatedAt) - Date.parse(item.createdAt)) / 1000)
  );
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} 秒`;
  }
  return `${Math.floor(elapsedSeconds / 60)} 分 ${elapsedSeconds % 60} 秒`;
}

export function renderTextMessageContent(content: string): string {
  return JSON.stringify({
    text: content.trim() || "处理中..."
  });
}

export function renderFileMessageContent(fileKey: string): string {
  return JSON.stringify({
    file_key: fileKey
  });
}

function legacyMarkdown(content: string): Record<string, unknown> {
  return {
    tag: "div",
    text: {
      tag: "lark_md",
      content
    }
  };
}

function cardButton(
  label: string,
  value: Record<string, string>,
  type: "default" | "primary" = "default"
): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: label
    },
    type,
    value
  };
}

function actionRows(buttons: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < buttons.length; index += 3) {
    rows.push({
      tag: "action",
      actions: buttons.slice(index, index + 3)
    });
  }
  return rows;
}

function compactButtonLabel(value: string): string {
  const normalized = value.trim();
  return normalized.length > 28 ? `${normalized.slice(0, 27)}…` : normalized;
}

export function renderModelSelectionCard(input: {
  currentModel: string;
  models: Array<{ model: string; displayName: string; isDefault: boolean }>;
}): string {
  const buttons = [
    cardButton("自动选择", { kind: "auto_select" }, "primary"),
    ...input.models.map((model) =>
      cardButton(
        `${model.displayName}${model.isDefault ? "（推荐）" : ""}`,
        { kind: "model_select", model: model.model }
      )
    )
  ];
  const card: LegacyInteractiveCard = {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "选择 Codex 模型"
      }
    },
    elements: [
      legacyMarkdown(`当前模式：**${input.currentModel}**\n\n请选择自动模式或手动模型。`),
      ...actionRows(buttons),
      legacyMarkdown("也可以在 10 分钟内回复原来的序号。")
    ]
  };
  return JSON.stringify(card);
}

export function renderEffortSelectionCard(input: {
  model: string;
  efforts: Array<{ value: string; label: string }>;
}): string {
  const card: LegacyInteractiveCard = {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true
    },
    header: {
      template: "wathet",
      title: {
        tag: "plain_text",
        content: "选择思考深度"
      }
    },
    elements: [
      legacyMarkdown(`已选择模型：**${input.model}**\n\n请选择思考深度，完成后切换生效。`),
      ...actionRows(input.efforts.map((effort) =>
        cardButton(effort.label, {
          kind: "effort_select",
          effort: effort.value
        })
      )),
      legacyMarkdown("也可以在 10 分钟内回复原来的序号或档位名称。")
    ]
  };
  return JSON.stringify(card);
}

export function renderProjectSelectionCard(input: {
  projects: Array<{
    id: string;
    name: string;
    detail: string;
    current: boolean;
  }>;
}): string {
  const summary = input.projects.length > 0
    ? input.projects.map((project) =>
      `${project.current ? "✅" : "•"} **${project.name}** · ${project.detail}`
    ).join("\n")
    : "当前没有可切换的项目。";
  const card: LegacyInteractiveCard = {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "切换项目"
      }
    },
    elements: [
      legacyMarkdown(summary),
      ...actionRows(input.projects.map((project) =>
        cardButton(
          compactButtonLabel(`${project.current ? "✓ " : ""}${project.name}`),
          { kind: "project_select", projectId: project.id },
          project.current ? "primary" : "default"
        )
      )),
      legacyMarkdown("卡片 10 分钟内有效；也可以回复原来的序号。")
    ]
  };
  return JSON.stringify(card);
}

export function renderTaskSelectionCard(input: {
  projectName: string;
  tasks: Array<{
    id: string;
    name: string;
    current: boolean;
  }>;
}): string {
  const card: LegacyInteractiveCard = {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true
    },
    header: {
      template: "wathet",
      title: {
        tag: "plain_text",
        content: "切换任务"
      }
    },
    elements: [
      legacyMarkdown(`当前项目：**${input.projectName}**`),
      ...actionRows(input.tasks.map((task) =>
        cardButton(
          compactButtonLabel(`${task.current ? "✓ " : ""}${task.name}`),
          { kind: "task_select", taskId: task.id },
          task.current ? "primary" : "default"
        )
      )),
      legacyMarkdown("卡片 10 分钟内有效；也可以回复原来的序号。发送“新任务 名称”可创建独立任务。")
    ]
  };
  return JSON.stringify(card);
}

export function renderSelectionConfirmedCard(title: string, content: string): string {
  const card: LegacyInteractiveCard = {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: true
    },
    header: {
      template: "green",
      title: {
        tag: "plain_text",
        content: title
      }
    },
    elements: [legacyMarkdown(content)]
  };
  return JSON.stringify(card);
}

export function renderAssistantCardContent(item: ConversationItem): string {
  let body = item.content?.trim() || "处理中...";
  if (item.source === "final_answer") {
    body = stripLeadingProcessParagraph(body);
    body = stripLeadingLabel(body, ["最终结论", "结论", "Final Answer"]);
  } else {
    body = stripLeadingLabel(body, ["中间过程", "过程同步", "过程说明"]);
  }

  body = body || "处理中...";
  if (item.footer?.trim()) {
    body = `${body}\n\n---\n${item.footer.trim()}`;
  }
  const elements =
    item.source === "commentary"
      ? [collapsiblePanel(processPreviewTitle(body), body)]
      : [markdownBlock(body)];

  const card: InteractiveCard = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true
    },
    body: {
      elements
    }
  };

  return JSON.stringify(card);
}

export function renderToolCardContent(item: ConversationItem): string {
  const sections = [`**${toolPhaseLabel(item.phase)}**`];
  if (item.details.length > 0) {
    sections.push(item.details.map((line) => `- ${escapeMarkdownText(line)}`).join("\n"));
  }
  if (item.command) {
    sections.push(`**命令**\n${fencedCode(item.command, "bash")}`);
  }
  if (item.output) {
    sections.push(`**输出**\n${fencedCode(item.output.slice(-1800))}`);
  }
  if (item.filePaths.length > 0) {
    sections.push(`**涉及文件**\n${item.filePaths.map((path) => `- ${escapeMarkdownText(path)}`).join("\n")}`);
  }

  const summary = summarizeToolTitle(item);
  const elements: Array<Record<string, unknown>> = [
    markdownTitleCollapsiblePanel(`**${toolPhaseLabel(item.phase)} · ${summary}**`, sections.join("\n\n"))
  ];

  const card: InteractiveCard = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true
    },
    body: {
      elements
    }
  };

  return JSON.stringify(card);
}

export function renderProgressCardContent(item: ConversationItem): string {
  const plan = item.progressPlan ?? [];
  const entries = (item.progressEntries ?? []).slice(-8);
  const completedSteps = plan.filter((step) => step.status === "completed").length;
  const sections: string[] = [];

  if (plan.length > 0) {
    sections.push(
      `**计划 ${completedSteps}/${plan.length}**\n${plan
        .map((step) => `${progressMark(step.status)} ${escapeMarkdownText(step.step)}`)
        .join("\n")}`
    );
  } else if (item.content?.trim()) {
    sections.push(`**当前计划**\n${escapeMarkdownText(item.content.trim())}`);
  }

  if (entries.length > 0) {
    const lines = entries.map((entry) => {
      const summary = entry.command
        ? summarizeCommand(entry.command)
        : entry.filePaths.length > 0
          ? summarizeFilePaths(entry.filePaths)
          : summarizeTitle(entry.detail ?? entry.title, entry.title, 56);
      return `${progressMark(entry.status)} **${escapeMarkdownText(entry.title)}** · ${escapeMarkdownText(summary)}`;
    });
    sections.push(`**最近操作**\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    sections.push("正在准备执行...");
  }

  sections.push(`耗时：${formatElapsed(item)}`);
  const header = progressHeader(item.phase);
  const card: InteractiveCard = {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true
    },
    header: {
      template: header.template,
      title: {
        tag: "plain_text",
        content: header.title
      }
    },
    body: {
      elements: [markdownBlock(sections.join("\n\n"))]
    }
  };

  return JSON.stringify(card);
}
