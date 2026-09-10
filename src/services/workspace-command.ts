export type WorkspaceCommand =
  | { kind: "project_list" }
  | { kind: "project_create"; value: string }
  | { kind: "project_bind"; name: string; remoteUrl: string; branch?: string }
  | { kind: "project_sync"; value?: string }
  | { kind: "project_rename"; value: string }
  | { kind: "project_select"; value: string }
  | { kind: "task_list" }
  | { kind: "task_create"; value: string }
  | { kind: "task_rename"; value: string }
  | { kind: "task_select"; value: string }
  | { kind: "navigation_pick"; index: number };

export function parseWorkspaceCommand(text: string): WorkspaceCommand | undefined {
  const trimmed = text.trim();
  if (/^(项目|\/project)$/i.test(trimmed)) {
    return { kind: "project_list" };
  }
  if (/^(任务|\/task)$/i.test(trimmed)) {
    return { kind: "task_list" };
  }

  const projectBind = trimmed.match(
    /^(?:绑定项目|关联项目)\s*[:：]?\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/i
  );
  if (projectBind?.[1] && projectBind[2]) {
    return {
      kind: "project_bind",
      name: projectBind[1],
      remoteUrl: projectBind[2],
      branch: projectBind[3]
    };
  }

  const projectSync = trimmed.match(/^(?:同步项目|更新项目)(?:\s*[:：]?\s+(.+))?$/i);
  if (projectSync) {
    return {
      kind: "project_sync",
      value: projectSync[1]?.trim() || undefined
    };
  }

  const projectCreate = trimmed.match(/^(?:新项目|新建项目|创建项目)\s*[:：]?\s+(.+)$/i);
  if (projectCreate?.[1]?.trim()) {
    return { kind: "project_create", value: projectCreate[1].trim() };
  }

  const projectRename = trimmed.match(/^(?:重命名项目|项目重命名|项目改名)\s*[:：]?\s+(.+)$/i);
  if (projectRename?.[1]?.trim()) {
    return { kind: "project_rename", value: projectRename[1].trim() };
  }

  const taskCreate = trimmed.match(/^(?:新任务|新建任务|创建任务)\s*[:：]?\s+(.+)$/i);
  if (taskCreate?.[1]?.trim()) {
    return { kind: "task_create", value: taskCreate[1].trim() };
  }

  const taskRename = trimmed.match(/^(?:重命名任务|任务重命名|任务改名)\s*[:：]?\s+(.+)$/i);
  if (taskRename?.[1]?.trim()) {
    return { kind: "task_rename", value: taskRename[1].trim() };
  }

  const projectSelect = trimmed.match(/^(?:项目|\/project)\s*[:：]?\s+(.+)$/i);
  if (projectSelect?.[1]?.trim()) {
    return { kind: "project_select", value: projectSelect[1].trim() };
  }

  const taskSelect = trimmed.match(/^(?:任务|\/task)\s*[:：]?\s+(.+)$/i);
  if (taskSelect?.[1]?.trim()) {
    return { kind: "task_select", value: taskSelect[1].trim() };
  }

  return undefined;
}
