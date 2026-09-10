import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkspaceCommand } from "./workspace-command.js";

test("parseWorkspaceCommand parses project commands", () => {
  assert.deepEqual(parseWorkspaceCommand("项目"), { kind: "project_list" });
  assert.deepEqual(parseWorkspaceCommand("新项目 秋招投递"), {
    kind: "project_create",
    value: "秋招投递"
  });
  assert.deepEqual(parseWorkspaceCommand("项目改名 秋招求职"), {
    kind: "project_rename",
    value: "秋招求职"
  });
  assert.deepEqual(parseWorkspaceCommand("项目 秋招投递"), {
    kind: "project_select",
    value: "秋招投递"
  });
  assert.deepEqual(parseWorkspaceCommand("绑定项目 简历 git@github.com:cai/resume.git main"), {
    kind: "project_bind",
    name: "简历",
    remoteUrl: "git@github.com:cai/resume.git",
    branch: "main"
  });
  assert.deepEqual(parseWorkspaceCommand("同步项目"), {
    kind: "project_sync",
    value: undefined
  });
  assert.deepEqual(parseWorkspaceCommand("同步项目 简历"), {
    kind: "project_sync",
    value: "简历"
  });
});

test("parseWorkspaceCommand parses task commands", () => {
  assert.deepEqual(parseWorkspaceCommand("任务"), { kind: "task_list" });
  assert.deepEqual(parseWorkspaceCommand("新任务 邮件状态同步"), {
    kind: "task_create",
    value: "邮件状态同步"
  });
  assert.deepEqual(parseWorkspaceCommand("任务 邮件状态同步"), {
    kind: "task_select",
    value: "邮件状态同步"
  });
  assert.deepEqual(parseWorkspaceCommand("任务改名 Codex机器人"), {
    kind: "task_rename",
    value: "Codex机器人"
  });
});
