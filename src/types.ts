import type { TokenUsage } from './costs';

export type AgentStatus =
  | 'idle'
  | 'planning'
  | 'researching'
  | 'coding'
  | 'running'
  | 'accounting'
  | 'approval'
  | 'done'
  | 'error';

/**
 * オフィスのどこにいるか。作業が始まると自動的に `working` へ戻ります。
 * - working … 自分の持ち場（担当部屋）で作業中
 * - lounge  … 手が空いたので休憩スペースにいる
 * - left    … 「お先に～」と退勤して、もうフロアにいない
 */
export type AgentPresence = 'working' | 'lounge' | 'left';

/** What an employee is hired to do. It decides which room they work in. */
export type AgentDuty =
  | 'director'
  | 'planner'
  | 'coder'
  | 'researcher'
  | 'tester'
  | 'reviewer'
  | 'designer'
  | 'accountant'
  | 'writer'
  | 'general';

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
  duty: AgentDuty;
  status: AgentStatus;
  task: string;
  activity: string;
  speech?: string;
  speechKind?: 'activity' | 'message' | 'question';
  color: number;
  /** 省略時は `working`。休憩・退勤の行き先はここだけで決まります。 */
  presence?: AgentPresence;
  /** 手が空いた時刻。休憩から退勤へ移るまでの時間を計るのに使います。 */
  restingSince?: number;
  isRoot?: boolean;
  /** Local-only staff (the accountant) never receive a Codex thread. */
  virtual?: boolean;
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
  duty: AgentDuty;
  specialty: string;
  personality: string;
  color: number;
  hired: boolean;
  recommended?: boolean;
  custom?: boolean;
  /** The director and the accountant are part of the company itself. */
  permanent?: boolean;
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

export type RoadmapStatus = 'pending' | 'active' | 'done';

/** One line of the 進行表 that the director posts before a big job starts. */
export interface RoadmapStep {
  id: string;
  title: string;
  owner?: string;
  status: RoadmapStatus;
  updatedAt: number;
}

export interface Roadmap {
  title: string;
  steps: RoadmapStep[];
  startedAt: number;
  updatedAt: number;
}

export interface AccountingLine {
  threadId: string;
  name: string;
  role: string;
  color: number;
  usage: TokenUsage;
  yen: number;
  /** Short Japanese descriptions of what this member actually did. */
  tasks: string[];
}

export interface AccountingEstimate {
  planId: string;
  label: string;
  kind: 'usage' | 'flat' | 'api';
  yen: number;
  note: string;
}

export interface AccountingReport {
  id: string;
  createdAt: number;
  /** Workspace active when the snapshot was created. */
  workspace?: string;
  title: string;
  summary: string;
  lines: AccountingLine[];
  deliverables: Deliverable[];
  steps: RoadmapStep[];
  usage: TokenUsage;
  totalYen: number;
  planId: string;
  planLabel: string;
  modelLabel: string;
  estimates: AccountingEstimate[];
  elapsedMs: number;
}

export interface CodexEvent {
  method: string;
  params?: Record<string, unknown>;
  requestId?: number | string;
}

/**
 * 指示に添えるファイル。実体はディスク上にあり、Codexへは絶対パスで伝えます。
 * 画像だけはモデルが直接見られるので、パスに加えて画像として送ります。
 */
export interface Attachment {
  id: string;
  name: string;
  /** 絶対パス。貼り付けた画像は一時フォルダに書き出したものを指します。 */
  path: string;
  size: number;
  kind: 'image' | 'file';
  /** 画面上で小さく見せるための data URL（画像のときだけ）。 */
  previewUrl?: string;
  /** このアプリが一時フォルダに作ったものか。 */
  temporary?: boolean;
}

/**
 * 使用量の枠ひとつぶん。Codexは短期（primary）と長期（secondary）の2枠を返します。
 * `usedPercent` は「使った割合」なので、残量は 100 から引いた値になります。
 */
export interface RateLimitWindow {
  usedPercent: number;
  /** 枠がひとまわりする長さ（分）。5時間や1週間といった単位です。 */
  windowDurationMins?: number;
  /** 枠が回復する時刻（ミリ秒）。 */
  resetsAt?: number;
}

export interface RateLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: number;
}

export interface RateLimitSnapshot {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  planType?: string;
  credits?: RateLimitCredits;
  updatedAt: number;
}

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: 'directory' | 'file';
  size: number;
  modifiedAt: number;
}

/** A codex process that is not the one this app spawned. */
export interface CodexProcessInfo {
  pid: number;
  name: string;
  memory: string;
}

export interface ThreadOptions {
  model?: string;
  effort?: string;
}

/** ゲームのセーブデータに書いておく「そのときの状況」。 */
export interface SaveMeta {
  label: string;
  createdAt: number;
  roadmapTitle?: string;
  roadmapDone?: number;
  roadmapTotal?: number;
  deliverables?: number;
  tokens?: number;
  yen?: number;
  model?: string;
  staff?: string[];
}

/**
 * セーブデータ1件＝作業フォルダのGitコミット1件。
 * `kind` は一覧での見せ方を変えるためのもので、どれも同じようにロードできます。
 * - save  … 手動でセーブしたもの
 * - auto  … ロードの直前に自動で取った控え（ロードのやり直しに使えます）
 * - load  … ロードした操作そのものの記録
 * - other … このアプリ以外で作られたコミット
 */
export type SaveKind = 'save' | 'auto' | 'load' | 'other';

export interface SaveSlot {
  commit: string;
  shortCommit: string;
  time: number;
  subject: string;
  author: string;
  kind: SaveKind;
  /** このアプリの「セーブ」ボタンで作られたものか。 */
  isAppSave: boolean;
  meta?: SaveMeta;
}

export interface RepoStatus {
  gitAvailable: boolean;
  isRepo: boolean;
  hasCommits: boolean;
  branch: string;
  changedFiles: number;
  /** 変更のあったファイル名（先頭のいくつか）。 */
  changes: string[];
  /**
   * 作業フォルダの中にある、それ自体がGit管理されているフォルダ。
   * 親のセーブには含められないので、除外したうえで利用者に知らせます。
   */
  nestedRepos: string[];
  message?: string;
}

export interface LoadResult {
  status: RepoStatus;
  meta?: SaveMeta;
  autoSavedCommit?: string;
}

export interface PixelCodexApi {
  getAppInfo: () => Promise<{ cwd: string; version: string }>;
  chooseWorkspace: () => Promise<string | null>;
  chooseCodexExecutable: () => Promise<string | null>;
  listWorkspaceDirectory: (workspace: string, relativePath?: string) => Promise<WorkspaceEntry[]>;
  openWorkspaceItem: (workspace: string, itemPath: string) => Promise<void>;
  /** ファイル選択ダイアログから添付を選びます。 */
  chooseAttachments: () => Promise<Attachment[]>;
  /** ドラッグ＆ドロップされたファイルを、そのままの場所で添付として読みます。 */
  describeAttachments: (paths: string[]) => Promise<Attachment[]>;
  /** 貼り付けた画像など、まだディスクに無いものを一時フォルダへ保存します。 */
  saveAttachment: (name: string, dataBase64: string) => Promise<Attachment>;
  /** ドロップされたFileの元の場所。取得できないときは空文字を返します。 */
  getPathForFile: (file: File) => string;
  getRepoStatus: (workspace: string) => Promise<RepoStatus>;
  initRepo: (workspace: string) => Promise<RepoStatus>;
  listSaves: (workspace: string) => Promise<SaveSlot[]>;
  createSave: (workspace: string, label: string, meta: SaveMeta) => Promise<SaveSlot[]>;
  loadSave: (workspace: string, commit: string) => Promise<LoadResult>;
  listCodexProcesses: () => Promise<CodexProcessInfo[]>;
  terminateCodexProcesses: (pids: number[]) => Promise<{ stopped: number[]; failed: number[] }>;
  startCodex: (executable?: string) => Promise<{ executable: string; version: string }>;
  stopCodex: () => Promise<void>;
  startThread: (cwd: string, options?: ThreadOptions) => Promise<{ threadId: string }>;
  sendTask: (
    threadId: string,
    text: string,
    attachments?: Array<Pick<Attachment, 'path' | 'kind'>>,
  ) => Promise<{ turnId?: string }>;
  steerAgent: (
    threadId: string,
    turnId: string,
    text: string,
    attachments?: Array<Pick<Attachment, 'path' | 'kind'>>,
  ) => Promise<void>;
  /**
   * いまの使用量の枠。Codexが返す生の内容をそのまま渡し、読み取りは
   * 通知イベントと同じ場所（agentStore）でまとめて行います。
   * 対応していないCodexでは undefined になります。
   */
  getRateLimits: () => Promise<unknown>;
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
