export type AgentStatus =
  | 'idle'
  | 'planning'
  | 'researching'
  | 'coding'
  | 'running'
  | 'approval'
  | 'done'
  | 'error';

export type ConnectionStatus =
  | 'demo'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface AgentState {
  id: string;
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  name: string;
  role: string;
  status: AgentStatus;
  task: string;
  activity: string;
  speech?: string;
  speechKind?: 'activity' | 'message' | 'question';
  color: number;
  isRoot?: boolean;
  updatedAt: number;
}

export interface ConversationMessage {
  id: string;
  agentId?: string;
  role: 'user' | 'assistant' | 'question';
  text: string;
  phase?: 'commentary' | 'final_answer';
  time: number;
}

export interface Deliverable {
  id: string;
  agentId?: string;
  path: string;
  kind: 'created' | 'updated' | 'deleted';
  time: number;
}

export interface AgentProfile {
  id: string;
  name: string;
  job: string;
  specialty: string;
  personality: string;
  color: number;
  hired: boolean;
  recommended?: boolean;
  custom?: boolean;
}

export interface UserQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options?: Array<{ label: string; description: string }>;
}

export interface UserQuestionRequest {
  requestId: number | string;
  agentId?: string;
  questions: UserQuestion[];
}

export interface ActivityLog {
  id: string;
  agentId?: string;
  time: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export interface CodexEvent {
  method: string;
  params?: Record<string, unknown>;
  requestId?: number | string;
}

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: 'directory' | 'file';
  size: number;
  modifiedAt: number;
}

export interface PixelCodexApi {
  getAppInfo: () => Promise<{ cwd: string; version: string }>;
  chooseWorkspace: () => Promise<string | null>;
  chooseCodexExecutable: () => Promise<string | null>;
  listWorkspaceDirectory: (workspace: string, relativePath?: string) => Promise<WorkspaceEntry[]>;
  openWorkspaceItem: (workspace: string, itemPath: string) => Promise<void>;
  startCodex: (executable?: string) => Promise<{ executable: string; version: string }>;
  stopCodex: () => Promise<void>;
  startThread: (cwd: string) => Promise<{ threadId: string }>;
  sendTask: (threadId: string, text: string) => Promise<{ turnId?: string }>;
  steerAgent: (threadId: string, turnId: string, text: string) => Promise<void>;
  interruptAgent: (threadId: string, turnId: string) => Promise<void>;
  respondApproval: (
    requestId: number | string,
    decision: 'accept' | 'decline' | 'cancel',
  ) => Promise<void>;
  respondUserInput: (
    requestId: number | string,
    answers: Record<string, string[]>,
  ) => Promise<void>;
  onEvent: (callback: (event: CodexEvent) => void) => () => void;
}
