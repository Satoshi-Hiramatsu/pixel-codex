import type { TokenUsage } from './costs';
import type {
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  RemoteHostInfo,
  RemoteApprovalResponse,
  RemoteInstruction,
  RemoteInstructionResult,
  RemoteQuestionResponse,
  RemoteStateSnapshot,
  UsbTestSession,
  WirelessPairingEvent,
  WirelessPairingSession,
  WirelessTestSession,
} from './remote/RemoteProtocol';

export type {
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  RemoteHostInfo,
  RemoteApprovalRequest,
  RemoteApprovalResponse,
  RemoteInstruction,
  RemoteInstructionResult,
  RemoteQuestionRequest,
  RemoteQuestionResponse,
  RemoteStateSnapshot,
  UsbTestSession,
  WirelessPairingEvent,
  WirelessPairingSession,
  WirelessTestSession,
} from './remote/RemoteProtocol';

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
  | 'communicator'
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
  /** Local-only staff, such as the accountant and communicator, never receive a Codex thread. */
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
  /** Permanent staff are part of the company itself. */
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

/**
 * スキルの系統。RPGの「属性」にあたるもので、一覧の並びと色分けに使います。
 * 保存ファイルには文字列がそのまま入るので、増やすときは末尾に足してください。
 */
export type SkillCategory =
  | 'coding'
  | 'planning'
  | 'guard'
  | 'research'
  | 'review'
  | 'writing'
  | 'workflow'
  | 'other';

/**
 * スキルの置き場所。
 * - global  … どの作業フォルダでも使える。ユーザーデータ側に保存されます。
 * - project … いまの作業フォルダ専用。`.pixel-codex/skills/` に保存されます。
 */
export type SkillScope = 'global' | 'project';

/**
 * 装備できるルール1件＝マークダウン1ファイル。
 * 見出し（name/category/effect）は冒頭のメタ欄に、`detail` は本文に入ります。
 */
export interface Skill {
  /** ファイル名から拡張子を除いたもの。同じ置き場所のなかで一意です。 */
  id: string;
  name: string;
  category: SkillCategory;
  /** 効果。一覧に1行で出す要約です。 */
  effect: string;
  /** 詳細。実際にCodexへ渡す指示文の本体です。 */
  detail: string;
  scope: SkillScope;
  /** どの作業フォルダで生まれたか。他プロジェクトから取り込むときの目印です。 */
  origin?: string;
  /** 取り込み元のスキル名。最適化コピーの由来を残します。 */
  copiedFrom?: string;
  createdAt: number;
  updatedAt: number;
  /** ファイルの絶対パス。`開く`のような操作に使います。 */
  path: string;
}

/** 保存する前のスキル。`id` があれば上書き、なければ新規作成になります。 */
export type SkillDraft = Pick<Skill, 'name' | 'category' | 'effect' | 'detail'> &
  Partial<Pick<Skill, 'id' | 'origin' | 'copiedFrom'>>;

/** いまの作業フォルダから見たスキルの全体像。 */
export interface SkillBook {
  workspace: string;
  global: Skill[];
  project: Skill[];
  /** 装備中のスキルID。`global` / `project` それぞれの id を指します。 */
  equippedGlobal: string[];
  equippedProject: string[];
}

/** 他プロジェクトの本棚。スキルを見つけて持ってくるために使います。 */
export interface SkillShelf {
  workspace: string;
  /** フォルダ名。一覧の見出しに使います。 */
  name: string;
  skills: Skill[];
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
  getRemoteHostInfo: () => Promise<RemoteHostInfo>;
  configureRemoteGateway: (config: RemoteGatewayConfig) => Promise<RemoteGatewayStatus>;
  startUsbRemoteTest: () => Promise<UsbTestSession>;
  startWirelessRemoteTest: () => Promise<WirelessTestSession>;
  startWirelessPairing: () => Promise<WirelessPairingSession>;
  cancelWirelessPairing: () => Promise<void>;
  onRemotePairing: (callback: (event: WirelessPairingEvent) => void) => () => void;
  updateRemoteState: (state: RemoteStateSnapshot) => Promise<void>;
  acknowledgeRemoteInstruction: (result: RemoteInstructionResult) => Promise<void>;
  onRemoteStatus: (callback: (status: RemoteGatewayStatus) => void) => () => void;
  onRemoteInstruction: (callback: (instruction: RemoteInstruction) => void) => () => void;
  onRemoteApproval: (callback: (response: RemoteApprovalResponse) => void) => () => void;
  onRemoteQuestion: (callback: (response: RemoteQuestionResponse) => void) => () => void;
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
  /** グローバルと、いまの作業フォルダのスキルをまとめて読み込みます。 */
  readSkillBook: (workspace: string) => Promise<SkillBook>;
  /** 新規作成または上書き保存。保存後のスキルを返します。 */
  saveSkill: (scope: SkillScope, workspace: string, draft: SkillDraft) => Promise<Skill>;
  deleteSkill: (scope: SkillScope, workspace: string, id: string) => Promise<void>;
  /** 装備中のスキルIDを置き換えます。返るのは実在するものだけです。 */
  setEquippedSkills: (
    scope: SkillScope,
    workspace: string,
    ids: string[],
  ) => Promise<string[]>;
  /** 渡した作業フォルダのなかから、スキルを持っているものだけを返します。 */
  listSkillShelves: (workspaces: string[]) => Promise<SkillShelf[]>;
  /**
   * 文章ひとつぶんだけCodexに書いてもらいます。オフィスには出社させず、
   * 使った分の費用だけ「スキル指南役」として計上します。
   */
  askCodex: (cwd: string, prompt: string, options?: ThreadOptions) => Promise<string>;
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
