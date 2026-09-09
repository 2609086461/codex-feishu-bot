import type {
  ChatSession,
  CodexEvent,
  CodexModelInfo,
  CodexRouteDecision,
  CodexWorkspaceProject,
  IncomingChatMessage
} from "../../domain/types.js";

export interface CodexTurnContext {
  session?: ChatSession;
  workspaceId: string;
  message: IncomingChatMessage;
}

export interface CodexWorker {
  start?(): Promise<void>;
  close?(): Promise<void>;
  getDefaultModel?(): string;
  listModels?(): Promise<CodexModelInfo[]>;
  routeTurn?(context: CodexTurnContext): Promise<CodexRouteDecision>;
  listWorkspaceProjects?(): Promise<CodexWorkspaceProject[]>;
  ensureThread(context: CodexTurnContext): Promise<string>;
  steerTurn?(context: CodexTurnContext & { threadId: string; turnId: string }): Promise<void>;
  interruptTurn?(context: { threadId: string; turnId: string }): Promise<void>;
  runTurn(context: CodexTurnContext & { threadId: string }): AsyncGenerator<CodexEvent>;
}
