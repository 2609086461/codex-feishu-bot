import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

interface LoggerLike {
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
}

export interface GitProjectResult {
  branch: string;
  commit: string;
  changed: boolean;
}

export interface GitProjectServiceLike {
  clone(remoteUrl: string, workspaceId: string, branch?: string): Promise<GitProjectResult>;
  sync(workspaceId: string, branch: string): Promise<GitProjectResult>;
  validateRemoteUrl(remoteUrl: string): string;
  validateBranch(branch?: string): string | undefined;
}

export class GitProjectService implements GitProjectServiceLike {
  constructor(private readonly logger: LoggerLike) {}

  validateRemoteUrl(value: string): string {
    const remoteUrl = value.trim();
    if (!remoteUrl || /[\s\0\r\n]/.test(remoteUrl)) {
      throw new Error("Git 仓库地址格式不正确。");
    }

    if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/i.test(remoteUrl)) {
      return remoteUrl;
    }

    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new Error("仅支持 HTTPS 或 SSH Git 仓库地址。");
    }

    if (!['https:', 'ssh:'].includes(parsed.protocol)) {
      throw new Error("仅支持 HTTPS 或 SSH Git 仓库地址。");
    }
    if (!parsed.hostname || parsed.password || (parsed.protocol === 'https:' && parsed.username)) {
      throw new Error("仓库地址中不能包含账号、令牌或密码，请在服务器单独配置 Git 凭证。");
    }
    return remoteUrl;
  }

  validateBranch(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    const branch = value.trim();
    if (
      !branch ||
      branch.startsWith("-") ||
      !/^[A-Za-z0-9._/-]+$/.test(branch) ||
      branch.includes("..") ||
      branch.includes("@{") ||
      branch.includes("//") ||
      branch.endsWith("/") ||
      branch.endsWith(".")
    ) {
      throw new Error("Git 分支名称格式不正确。");
    }
    return branch;
  }

  async clone(remoteValue: string, workspaceId: string, branchValue?: string): Promise<GitProjectResult> {
    const remoteUrl = this.validateRemoteUrl(remoteValue);
    const requestedBranch = this.validateBranch(branchValue);
    await mkdir(dirname(workspaceId), { recursive: true });

    const args = ["clone", "--origin", "origin"];
    if (requestedBranch) {
      args.push("--branch", requestedBranch, "--single-branch");
    }
    args.push("--", remoteUrl, workspaceId);

    try {
      await this.runGit(args);
      const branch = await this.output(["branch", "--show-current"], workspaceId);
      const commit = await this.output(["rev-parse", "HEAD"], workspaceId);
      this.logger.info({ workspaceId, branch, commit: commit.slice(0, 12) }, "Git 项目已绑定");
      return { branch, commit, changed: true };
    } catch (error) {
      await rm(workspaceId, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async sync(workspaceId: string, branchValue: string): Promise<GitProjectResult> {
    const branch = this.validateBranch(branchValue);
    if (!branch) {
      throw new Error("项目缺少 Git 分支信息，请重新绑定。");
    }

    const dirty = await this.output(["status", "--porcelain"], workspaceId);
    if (dirty) {
      throw new Error("项目中存在未提交修改，已停止同步；请先提交或处理这些修改。");
    }

    const currentBranch = await this.output(["branch", "--show-current"], workspaceId);
    if (currentBranch !== branch) {
      throw new Error(`当前分支为 ${currentBranch || "detached HEAD"}，与绑定分支 ${branch} 不一致。`);
    }

    const before = await this.output(["rev-parse", "HEAD"], workspaceId);
    await this.runGit(["fetch", "--prune", "origin"], workspaceId);
    await this.runGit(["merge", "--ff-only", `origin/${branch}`], workspaceId);
    const commit = await this.output(["rev-parse", "HEAD"], workspaceId);
    this.logger.info(
      { workspaceId, branch, commit: commit.slice(0, 12), changed: before !== commit },
      "Git 项目已同步"
    );
    return { branch, commit, changed: before !== commit };
  }

  private async output(args: string[], cwd?: string): Promise<string> {
    return (await this.runGit(args, cwd)).stdout.trim();
  }

  private runGit(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const maxOutput = 32_000;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Git 操作超时，请检查仓库地址和服务器网络。"));
      }, 120_000);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-maxOutput);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-maxOutput);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`无法启动 Git：${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = stderr.trim().split("\n").at(-1) || `退出码 ${code ?? "未知"}`;
        this.logger.warn({ cwd, args: args.slice(0, 3), code }, "Git 操作失败");
        reject(new Error(`Git 操作失败：${detail}`));
      });
    });
  }
}
