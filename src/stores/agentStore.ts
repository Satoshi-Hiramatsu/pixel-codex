import { create } from 'zustand';

import {
  addUsage,
  defaultCostSettings,
  emptyUsage,
  estimateAllPlans,
  findPlan,
  jpyCost,
  type CostSettings,
  type TokenUsage,
} from '../costs';
import {
  defaultModelSettings,
  modelLabel,
  modelPlanId,
  type ModelSettings,
} from '../models';
import type {
  AccountingLine,
  AccountingReport,
  ActivityLog,
  AgentDuty,
  AgentProfile,
  AgentState,
  AgentStatus,
  CodexEvent,
  ConversationMessage,
  ConnectionStatus,
  Deliverable,
  RateLimitSnapshot,
  RateLimitWindow,
  Roadmap,
  RoadmapStep,
  SaveMeta,
  UserQuestion,
  UserQuestionRequest,
} from '../types';

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface ApprovalRequest {
  requestId: number | string;
  method: string;
  agentId?: string;
  /** What kind of permission Codex is asking for. */
  kind: 'command' | 'fileChange' | 'unknown';
  /** Japanese title shown as the modal heading. */
  title: string;
  /** One plain sentence: what happens if you approve. */
  headline: string;
  /** Concrete consequences, one short Japanese sentence each. */
  bullets: string[];
  command?: string;
  cwd?: string;
  reason?: string;
  files: Array<{ path: string; kind: Deliverable['kind'] }>;
  risk: ApprovalRisk;
  riskLabel: string;
  /** Raw payload, kept behind a "技術的な詳細" disclosure. */
  raw: string;
}

/** Per-thread token totals. `cumulative` marks sources that already report a running total. */
interface ThreadUsage {
  usage: TokenUsage;
  cumulative: boolean;
}

const costSettingsStorageKey = 'pixel-codex-cost-settings-v1';
const modelSettingsStorageKey = 'pixel-codex-model-settings-v1';
const accountingReportsStorageKey = 'pixel-codex-accounting-reports-v1';
const accountingReportLimit = 50;

function readStored<T>(key: string, fallback: T): T {
  try {
    const stored = globalThis.localStorage?.getItem(key);
    if (!stored) return fallback;
    return { ...fallback, ...(JSON.parse(stored) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Settings simply fall back to defaults on the next launch.
  }
}

function loadAccountingReports(): AccountingReport[] {
  try {
    const stored = globalThis.localStorage?.getItem(accountingReportsStorageKey);
    if (!stored) return [];
    const value = JSON.parse(stored) as { reports?: unknown };
    if (!Array.isArray(value.reports)) return [];
    return value.reports
      .filter((entry): entry is AccountingReport => Boolean(
        entry && typeof entry === 'object' && typeof (entry as AccountingReport).id === 'string',
      ))
      .slice(0, accountingReportLimit);
  } catch {
    return [];
  }
}

function saveAccountingReports(reports: AccountingReport[]): void {
  writeStored(accountingReportsStorageKey, { reports: reports.slice(0, accountingReportLimit) });
}

interface AgentStore {
  agents: AgentState[];
  selectedAgentId: string;
  connection: ConnectionStatus;
  connectionLabel: string;
  workspace: string;
  rootThreadId?: string;
  logs: ActivityLog[];
  messages: ConversationMessage[];
  deliverables: Deliverable[];
  approval?: ApprovalRequest;
  questionRequest?: UserQuestionRequest;
  agentProfiles: AgentProfile[];
  roadmap: Roadmap;
  /** Short Japanese notes of what each thread actually did, for the invoice. */
  taskHistory: Record<string, string[]>;
  projectStartedAt: number;
  accountingReport?: AccountingReport;
  /** Automatically persisted accounting snapshots, newest first. */
  accountingReports: AccountingReport[];
  /** Codexのconfig.tomlに問題があるときの説明。接続できない原因になります。 */
  configWarning?: string;
  clearConfigWarning: () => void;
  usage: TokenUsage;
  usageByThread: Record<string, ThreadUsage>;
  usageUpdatedAt: number;
  /** Codexから届く「あとどれだけ使えるか」。取得できていないときは undefined。 */
  rateLimits?: RateLimitSnapshot;
  /** Codexの応答をそのまま渡すと、読み取って保存します。 */
  applyRateLimits: (payload: unknown) => void;
  costSettings: CostSettings;
  modelSettings: ModelSettings;
  setCostSettings: (patch: Partial<CostSettings>) => void;
  setModelSettings: (patch: Partial<ModelSettings>) => void;
  resetUsage: () => void;
  setWorkspace: (workspace: string) => void;
  selectAgent: (id: string) => void;
  setConnection: (status: ConnectionStatus, label: string) => void;
  setRootThread: (threadId: string) => void;
  addLog: (message: string, level?: ActivityLog['level'], agentId?: string) => void;
  addMessage: (message: Omit<ConversationMessage, 'id' | 'time'> & { id?: string }) => void;
  handleCodexEvent: (event: CodexEvent) => void;
  clearApproval: () => void;
  clearQuestion: () => void;
  resetWorkspaceSession: () => void;
  hireAgentProfile: (id: string) => void;
  dismissAgentProfile: (id: string) => void;
  createAgentProfile: (
    profile: Pick<AgentProfile, 'name' | 'job' | 'duty' | 'specialty' | 'personality' | 'color'>,
  ) => void;
  removeAgentProfile: (id: string) => void;
  startProject: (title: string) => void;
  setRoadmap: (title: string, steps: Array<Pick<RoadmapStep, 'title' | 'owner' | 'status'>>) => void;
  /** The director's idle chatter: progress percent and a rough finish time. */
  narrateProgress: () => void;
  buildAccountingReport: (reason: string) => void;
  openAccountingReport: (id: string) => void;
  clearAccountingReport: () => void;
  /** ロードしたセーブデータの「そのときの状況」を進行表に戻します。 */
  applyLoadedSave: (meta: SaveMeta) => void;
}

const directorColor = 0xd8863f;
const accountantColor = 0x9d7fc4;
export const accountantAgentId = 'accountant-desk';

const now = Date.now();
const demoAgents: AgentState[] = [
  {
    id: 'director',
    name: '東葛大五郎',
    role: 'プロジェクト統括責任者',
    duty: 'director',
    status: 'planning',
    task: 'ロードマップを引いて担当を割り当てる',
    activity: 'ロードマップを作成中',
    speech: 'まずは進行表を作って、みんなに割り振るぞ。',
    speechKind: 'activity',
    color: directorColor,
    isRoot: true,
    updatedAt: now,
  },
  {
    id: 'manager',
    name: '企画一郎',
    role: '企画担当',
    duty: 'planner',
    status: 'planning',
    task: '要件を整理して仕様に落とす',
    activity: '要件を整理中',
    speech: '要件をまとめて、仕様に落とし込んでいるよ',
    speechKind: 'activity',
    color: 0xf0bd55,
    updatedAt: now,
  },
  {
    id: 'researcher',
    name: '調辺探',
    role: '調査担当',
    duty: 'researcher',
    status: 'researching',
    task: 'App Serverのイベント仕様を確認',
    activity: '資料室で仕様を調査中',
    speech: 'App Serverの仕様を資料室で調べているよ',
    speechKind: 'activity',
    color: 0x65b7d8,
    updatedAt: now,
  },
  {
    id: 'builder',
    name: '組立実',
    role: '実装担当',
    duty: 'coder',
    status: 'coding',
    task: 'ピクセルオフィスUIを実装',
    activity: 'App.tsx を編集中',
    speech: '開発室で App.tsx を書き換えているよ',
    speechKind: 'activity',
    color: 0xe1775b,
    updatedAt: now,
  },
  {
    id: 'tester',
    name: '試験守',
    role: 'テスト担当',
    duty: 'tester',
    status: 'running',
    task: 'Windowsビルドを検証',
    activity: 'npm run typecheck を実行中',
    speech: 'テストラボで npm run typecheck を実行中',
    speechKind: 'activity',
    color: 0x78b56c,
    updatedAt: now,
  },
  {
    id: accountantAgentId,
    name: '金田計理',
    role: '経理担当',
    duty: 'accountant',
    status: 'accounting',
    task: 'トークン使用量を集計',
    activity: '使用量を記帳中',
    speech: 'みんなの働きぶりを帳簿につけているよ',
    speechKind: 'activity',
    color: accountantColor,
    virtual: true,
    updatedAt: now,
  },
];

const initialMessages: ConversationMessage[] = [
  {
    id: 'demo-assistant',
    agentId: 'director',
    role: 'assistant',
    phase: 'commentary',
    text: 'ここにAIからの進捗報告、回答、質問が表示されます。',
    time: now,
  },
];

const initialLogs: ActivityLog[] = [
  {
    id: 'welcome',
    time: now,
    level: 'info',
    message: 'デモモードでオフィスを表示しています',
  },
  {
    id: 'builder-started',
    time: now - 21_000,
    level: 'success',
    agentId: 'builder',
    message: '組立実が開発室へ移動しました',
  },
];

const emptyRoadmap: Roadmap = { title: '', steps: [], startedAt: 0, updatedAt: 0 };

const profileStorageKey = 'pixel-codex-agent-profiles-v2';
const fallbackAgentIdentities: Array<{
  name: string;
  role: string;
  duty: AgentDuty;
  color: number;
}> = [
  { name: '企画一郎', role: '企画担当', duty: 'planner', color: 0xf0bd55 },
  { name: '調辺探', role: '調査担当', duty: 'researcher', color: 0x65b7d8 },
  { name: '組立実', role: '実装担当', duty: 'coder', color: 0xe1775b },
  { name: '試験守', role: 'テスト担当', duty: 'tester', color: 0x78b56c },
  { name: '絵描大好', role: 'デザイン担当', duty: 'designer', color: 0xe09cb2 },
  { name: '見直正', role: 'レビュー担当', duty: 'reviewer', color: 0xb58bd4 },
  { name: '文書綴', role: 'ドキュメント担当', duty: 'writer', color: 0xe4a05f },
  { name: '守安堅', role: 'セキュリティ担当', duty: 'reviewer', color: 0x6ca69a },
  { name: '速度駿', role: '性能改善担当', duty: 'coder', color: 0x7f9fd1 },
];

const defaultAgentProfiles: AgentProfile[] = [
  {
    id: 'director-profile',
    name: '東葛大五郎',
    job: 'プロジェクト統括責任者',
    duty: 'director',
    specialty: '全体設計、ロードマップ作成、担当への割り振り、進捗管理',
    personality: '自分では手を動かさず、適材適所で仕事を任せる現場のまとめ役',
    color: directorColor,
    hired: true,
    permanent: true,
  },
  {
    id: 'accountant-profile',
    name: '金田計理',
    job: '経理担当',
    duty: 'accountant',
    specialty: 'トークン使用量の監視、費用の記帳、会計報告の作成',
    personality: '一円単位まで気にする几帳面な帳簿番',
    color: accountantColor,
    hired: true,
    permanent: true,
  },
  {
    id: 'manager-profile',
    name: '企画一郎',
    job: '企画担当',
    duty: 'planner',
    specialty: '要件整理、仕様づくり、段取りの検討',
    personality: '落ち着いて話をまとめる企画マン',
    color: 0xf0bd55,
    hired: true,
    recommended: true,
  },
  {
    id: 'scout-profile',
    name: '調辺探',
    job: '調査担当',
    duty: 'researcher',
    specialty: '仕様調査、コードベース探索、情報収集',
    personality: '好奇心旺盛で、分からないことをすぐ調べる',
    color: 0x65b7d8,
    hired: false,
    recommended: true,
  },
  {
    id: 'builder-profile',
    name: '組立実',
    job: '実装担当',
    duty: 'coder',
    specialty: '機能実装、リファクタリング、不具合修正',
    personality: '手を動かすのが早い、頼れるものづくり担当',
    color: 0xe1775b,
    hired: false,
    recommended: true,
  },
  {
    id: 'checker-profile',
    name: '試験守',
    job: 'テスト担当',
    duty: 'tester',
    specialty: 'テスト、動作確認、品質チェック',
    personality: '細かな違和感も見逃さない慎重派',
    color: 0x78b56c,
    hired: false,
    recommended: true,
  },
  {
    id: 'designer-profile',
    name: '絵描大好',
    job: 'デザイン担当',
    duty: 'designer',
    specialty: '画面設計、使いやすさ、見た目の改善',
    personality: '利用者の気持ちを大切にするアイデア担当',
    color: 0xe09cb2,
    hired: false,
    recommended: true,
  },
  {
    id: 'reviewer-profile',
    name: '見直正',
    job: 'レビュー担当',
    duty: 'reviewer',
    specialty: '設計確認、安全性、仕上げのレビュー',
    personality: '冷静で、完成前にしっかり品質を整える',
    color: 0xb58bd4,
    hired: false,
    recommended: true,
  },
];

function loadAgentProfiles(): AgentProfile[] {
  try {
    const stored = globalThis.localStorage?.getItem(profileStorageKey);
    if (!stored) return defaultAgentProfiles;
    const parsed = JSON.parse(stored) as AgentProfile[];
    if (!Array.isArray(parsed)) return defaultAgentProfiles;
    const storedById = new Map(parsed.map((profile) => [profile.id, profile]));
    const defaultIds = new Set(defaultAgentProfiles.map((profile) => profile.id));
    const defaults = defaultAgentProfiles.map((profile) => ({
      ...profile,
      // The director and the accountant are always on staff.
      hired: profile.permanent ? true : storedById.get(profile.id)?.hired ?? profile.hired,
    }));
    const custom = parsed
      .filter((profile) => profile.custom && !defaultIds.has(profile.id))
      .map((profile) => ({ ...profile, duty: profile.duty ?? 'general' }));
    return [...defaults, ...custom];
  } catch {
    return defaultAgentProfiles;
  }
}

function saveAgentProfiles(profiles: AgentProfile[]): void {
  writeStored(profileStorageKey, profiles);
}

function valueAt(source: unknown, ...keys: string[]): unknown {
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function textAt(source: unknown, ...keys: string[]): string | undefined {
  const value = valueAt(source, ...keys);
  return typeof value === 'string' && value ? value : undefined;
}

function arrayAt(source: unknown, ...keys: string[]): unknown[] {
  const value = valueAt(source, ...keys);
  return Array.isArray(value) ? value : [];
}

function fileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

/** Keeps speech bubbles to one readable line. */
function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === 'string').join(' ');
  }
  return '';
}

function changedPaths(item: unknown): string[] {
  const changes = valueAt(item, 'changes');
  if (Array.isArray(changes)) {
    return changes
      .map((change) => textAt(change, 'path'))
      .filter((path): path is string => Boolean(path));
  }
  if (changes && typeof changes === 'object') return Object.keys(changes as Record<string, unknown>);
  return [];
}

/**
 * What the office sees an agent doing. Instead of a generic 「作業中」 this
 * digs the real command, file name or search phrase out of the Codex payload,
 * so the bubble says 「npm test を実行中」 rather than 「ただいま作業中～」.
 */
interface ItemDescription {
  status: AgentStatus;
  activity: string;
  speech: string;
  task: string;
}

function describeItem(
  itemType: string | undefined,
  item: unknown,
  phase: string | undefined,
): ItemDescription {
  const normalized = itemType?.toLowerCase() ?? '';

  if (normalized.includes('commandexecution')) {
    const command = clip(
      commandText(valueAt(item, 'command') ?? valueAt(item, 'commandLine')),
      64,
    );
    const shown = command || 'コマンド';
    return {
      status: 'running',
      activity: `${clip(shown, 34)} を実行中`,
      speech: `テストラボで ${clip(shown, 46)} を動かして確認中`,
      task: `コマンド実行: ${shown}`,
    };
  }

  if (normalized.includes('filechange') || normalized.includes('patch')) {
    const paths = changedPaths(item);
    const head = paths[0] ? fileName(paths[0]) : 'ファイル';
    const extra = paths.length > 1 ? ` ほか${paths.length - 1}件` : '';
    return {
      status: 'coding',
      activity: `${clip(head, 26)}${extra} を編集中`,
      speech: `開発室で ${clip(head, 34)}${extra} を書き換えているよ`,
      task: `ファイル編集: ${paths.slice(0, 4).join(', ') || '(未取得)'}`,
    };
  }

  if (normalized.includes('websearch') || normalized.includes('search')) {
    const query = clip(
      textAt(item, 'query') ?? textAt(item, 'text') ?? textAt(item, 'pattern') ?? '',
      48,
    );
    return {
      status: 'researching',
      activity: query ? `「${clip(query, 20)}」を調査中` : '資料を調査中',
      speech: query
        ? `資料室で「${query}」について調べているよ`
        : '資料室で必要なことを調べているよ',
      task: `調査: ${query || '(条件なし)'}`,
    };
  }

  if (normalized.includes('mcptool') || normalized.includes('tool')) {
    const tool = clip(
      textAt(item, 'tool') ?? textAt(item, 'name') ?? textAt(item, 'server') ?? '',
      40,
    );
    return {
      status: 'running',
      activity: tool ? `${clip(tool, 26)} を使用中` : '外部ツールを使用中',
      speech: tool ? `${tool} という道具を使って作業中` : '便利な道具を使って調べているよ',
      task: `ツール利用: ${tool || '(名称不明)'}`,
    };
  }

  if (normalized.includes('todo') || normalized.includes('plan')) {
    return {
      status: 'planning',
      activity: '進行表を更新中',
      speech: '進行表に手順を書き出しているところ',
      task: '進行表の作成・更新',
    };
  }

  if (normalized.includes('reasoning') || normalized.includes('thinking')) {
    return {
      status: 'planning',
      activity: '進め方を検討中',
      speech: 'どう進めるのがいいか考えているよ',
      task: '進め方の検討',
    };
  }

  if (normalized.includes('collab') || normalized.includes('agentspawn')) {
    const prompt = clip(textAt(item, 'prompt') ?? '', 44);
    return {
      status: 'planning',
      activity: '担当へ作業を依頼中',
      speech: prompt ? `担当に「${prompt}」をお願いしているよ` : '担当に作業をお願いしているよ',
      task: `作業の割り振り: ${prompt || '(内容不明)'}`,
    };
  }

  if (normalized.includes('agentmessage')) {
    const text = clip(textAt(item, 'text') ?? '', 52);
    return {
      status: 'planning',
      activity: phase === 'final_answer' ? '完了報告を作成中' : '進捗を報告中',
      speech: phase === 'final_answer'
        ? 'できたよ！成果物を黒板にまとめたよ！'
        : text || 'いまの進み具合をまとめているよ',
      task: phase === 'final_answer' ? '完了報告の作成' : '進捗報告',
    };
  }

  if (normalized.includes('error')) {
    return {
      status: 'error',
      activity: 'エラーを確認中',
      speech: 'うまくいかなかったみたい。原因を調べるね',
      task: 'エラー対応',
    };
  }

  return {
    status: 'planning',
    activity: '作業を進行中',
    speech: 'ただいま作業中～',
    task: itemType ? `処理中: ${itemType}` : 'タスクを処理中',
  };
}

function deliverableKind(value: unknown): Deliverable['kind'] {
  const normalized = (
    typeof value === 'string'
      ? value
      : textAt(value, 'type') ?? textAt(value, 'kind') ?? ''
  ).toLowerCase();
  if (normalized.includes('delete')) return 'deleted';
  if (normalized.includes('add') || normalized.includes('create')) return 'created';
  return 'updated';
}

function markLatestAssistantFinal(
  messages: ConversationMessage[],
  agentId: string,
): ConversationMessage[] {
  let index = -1;
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'assistant' && messages[cursor].agentId === agentId) {
      index = cursor;
      break;
    }
  }
  if (index < 0 || messages[index].phase === 'final_answer') return messages;
  const next = [...messages];
  next[index] = { ...next[index], phase: 'final_answer' };
  return next;
}

function upsertDeliverables(
  deliverables: Deliverable[],
  additions: Deliverable[],
): Deliverable[] {
  const next = [...deliverables];
  for (const addition of additions) {
    const index = next.findIndex((entry) => entry.path === addition.path);
    if (index < 0) next.push(addition);
    else next[index] = addition;
  }
  return next.slice(-100);
}

function upsertMessage(
  messages: ConversationMessage[],
  message: ConversationMessage,
): ConversationMessage[] {
  const index = messages.findIndex((entry) => entry.id === message.id);
  if (index < 0) return [...messages, message].slice(-80);
  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return next;
}

function rememberTask(
  history: Record<string, string[]>,
  threadId: string,
  task: string,
): Record<string, string[]> {
  const existing = history[threadId] ?? [];
  if (existing.includes(task)) return history;
  return { ...history, [threadId]: [...existing, task].slice(-40) };
}

function parseQuestions(params: Record<string, unknown>): UserQuestion[] {
  return arrayAt(params, 'questions').flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const options = arrayAt(value, 'options').flatMap((option) => {
      const label = textAt(option, 'label');
      if (!label) return [];
      return [{ label, description: textAt(option, 'description') ?? '' }];
    });
    return [{
      id: textAt(value, 'id') ?? `question-${index + 1}`,
      header: textAt(value, 'header') ?? 'AIからの質問',
      question: textAt(value, 'question') ?? '回答を入力してください。',
      isSecret: Boolean(valueAt(value, 'isSecret')),
      options: options.length ? options : undefined,
    }];
  });
}

function roadmapStatus(value: unknown): RoadmapStep['status'] {
  if (value === true) return 'done';
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('complete') || normalized.includes('done') || normalized === 'true') {
    return 'done';
  }
  if (normalized.includes('progress') || normalized.includes('active') || normalized.includes('current')) {
    return 'active';
  }
  return 'pending';
}

/** Codex's todo/plan items, whichever shape this build happens to send. */
function parseRoadmapItems(item: unknown): Array<Pick<RoadmapStep, 'title' | 'status'>> {
  const raw = [...arrayAt(item, 'items'), ...arrayAt(item, 'plan'), ...arrayAt(item, 'steps')];
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') {
      return entry.trim() ? [{ title: entry.trim(), status: 'pending' as const }] : [];
    }
    const title =
      textAt(entry, 'text') ?? textAt(entry, 'step') ?? textAt(entry, 'title') ?? textAt(entry, 'label');
    if (!title) return [];
    const status = roadmapStatus(
      valueAt(entry, 'status') ?? valueAt(entry, 'completed') ?? valueAt(entry, 'done'),
    );
    return [{ title: title.trim(), status }];
  });
}

/**
 * A fallback for when Codex reports no structured plan: pick a numbered list
 * out of the director's own message so the 進行表 still fills in.
 */
function parseRoadmapFromText(text: string): Array<Pick<RoadmapStep, 'title' | 'status'>> {
  if (!/ロードマップ|進行表|作業計画|手順|ステップ/.test(text)) return [];
  const steps = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(\d+[.)、]|[-*・])\s*\S/.test(line))
    .map((line) => line.replace(/^(\d+[.)、]|[-*・])\s*/, '').trim())
    .filter((line) => line.length > 1 && line.length < 120);
  if (steps.length < 2) return [];
  return steps.slice(0, 14).map((title) => ({ title, status: 'pending' as const }));
}

/** Finds the staff member a roadmap line is addressed to. */
function ownerFromTitle(title: string, profiles: AgentProfile[]): string | undefined {
  return profiles.find(
    (profile) => profile.hired && (title.includes(profile.name) || title.includes(profile.job)),
  )?.name;
}

function numberAt(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Reads a Codex usage payload, tolerating both snake_case and camelCase shapes. */
function readUsage(source: unknown): TokenUsage | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const input = numberAt(record, 'input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const output = numberAt(record, 'output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  const cachedInput = numberAt(
    record,
    'cached_input_tokens',
    'cachedInputTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens',
  );
  const reasoning = numberAt(
    record,
    'reasoning_output_tokens',
    'reasoningOutputTokens',
    'reasoning_tokens',
    'reasoningTokens',
  );
  if (!input && !output && !cachedInput && !reasoning) return undefined;
  return { input, output, cachedInput, reasoning };
}

/** 「いつ回復するか」。秒でも、時刻の文字列でも受け取れるようにしています。 */
function readResetTime(value: unknown): number | undefined {
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  // ミリ秒・秒・「あと何秒」のどれで来ても、未来の時刻になるように直します。
  const asTimestamp = value > 1e12 ? value : value * 1000;
  const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  return asTimestamp > oneYearAgo ? asTimestamp : Date.now() + value * 1000;
}

function readRateLimitWindow(source: unknown): RateLimitWindow | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  const hasUsed = 'usedPercent' in record || 'used_percent' in record;
  if (!hasUsed) return undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, numberAt(record, 'usedPercent', 'used_percent'))),
    windowDurationMins:
      numberAt(
        record,
        'windowDurationMins',
        'window_duration_mins',
        'windowMinutes',
        'window_minutes',
      ) || undefined,
    resetsAt: readResetTime(record.resetsAt ?? record.resets_at ?? record.resetsInSeconds),
  };
}

/**
 * Codexの使用量スナップショットを読み取ります。短期（primary）と長期（secondary）の
 * 2つの枠があり、どちらも「使った割合」で返ってきます。
 */
export function readRateLimits(source: unknown): RateLimitSnapshot | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as Record<string, unknown>;
  // 応答は { rateLimits: {...} } のことも、枠が直に入っていることもあります。
  const snapshot = (record.rateLimits ?? record.rate_limits ?? record) as Record<string, unknown>;
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const primary = readRateLimitWindow(snapshot.primary);
  const secondary = readRateLimitWindow(snapshot.secondary);
  if (!primary && !secondary) return undefined;
  const credits = snapshot.credits as Record<string, unknown> | undefined;
  return {
    primary,
    secondary,
    planType: typeof snapshot.planType === 'string' ? snapshot.planType : undefined,
    credits: credits && typeof credits === 'object'
      ? {
          hasCredits: Boolean(credits.hasCredits),
          unlimited: Boolean(credits.unlimited),
          balance: typeof credits.balance === 'number' ? credits.balance : undefined,
        }
      : undefined,
    updatedAt: Date.now(),
  };
}

function sumUsage(byThread: Record<string, ThreadUsage>): TokenUsage {
  return Object.values(byThread).reduce((total, entry) => addUsage(total, entry.usage), emptyUsage);
}

function mergeThreadUsage(
  byThread: Record<string, ThreadUsage>,
  threadId: string,
  usage: TokenUsage,
  mode: 'total' | 'delta',
): Record<string, ThreadUsage> {
  const existing = byThread[threadId];
  if (mode === 'total') {
    return { ...byThread, [threadId]: { usage, cumulative: true } };
  }
  // Once a thread reports running totals, per-turn deltas would double-count it.
  if (existing?.cumulative) return byThread;
  return {
    ...byThread,
    [threadId]: { usage: addUsage(existing?.usage ?? emptyUsage, usage), cumulative: false },
  };
}

const commandExplanations: Array<{ match: RegExp; text: string; risk: ApprovalRisk }> = [
  { match: /(^|\s)(rm|rmdir|del|erase)(\s|$)|remove-item/i, text: 'ファイルやフォルダを削除します。元に戻せないことがあります。', risk: 'high' },
  { match: /git\s+push|git\s+remote\s+add/i, text: 'GitHubなどのインターネット上へ変更を送信（公開）します。', risk: 'high' },
  { match: /chmod|chown|icacls|sudo|runas|reg\s+add/i, text: 'パソコンの権限や設定を書き換えます。', risk: 'high' },
  { match: /git\s+(reset|checkout|clean|revert)/i, text: '作業中の変更を巻き戻します。保存していない内容が消える可能性があります。', risk: 'high' },
  { match: /git\s+commit/i, text: 'いまの変更内容をGitの履歴として記録します。', risk: 'medium' },
  { match: /npm\s+(install|i|ci)\b|yarn\s+add|pnpm\s+(add|install)|pip\s+install/i, text: '必要な部品（ライブラリ）をインターネットから取得して追加します。', risk: 'medium' },
  { match: /curl|wget|invoke-webrequest|fetch\s+http/i, text: 'インターネットに接続してデータを取得します。', risk: 'medium' },
  { match: /npm\s+(run|test|start)|yarn\s+(run|test)|pnpm\s+run|jest|vitest|pytest|go\s+test|cargo\s+test/i, text: 'テストやビルドのスクリプトを実行して、動作を確かめます。', risk: 'low' },
  { match: /^(ls|dir|cat|type|head|tail|grep|rg|find|fd|wc|tree|pwd|echo)\b/i, text: 'ファイルの中身や一覧を見るだけの操作です。', risk: 'low' },
  { match: /git\s+(status|log|diff|show|branch)/i, text: 'Gitの状態を確認するだけの操作です。', risk: 'low' },
  { match: /mkdir|touch|new-item/i, text: '新しいフォルダやファイルを作ります。', risk: 'low' },
];

const riskLabels: Record<ApprovalRisk, string> = {
  low: '安全度：高（見るだけ・確かめるだけの操作です）',
  medium: '安全度：中（内容が書き換わります。よく確認してください）',
  high: '安全度：低（取り消せない可能性があります。特に注意してください）',
};

function approvalFiles(item: unknown): Array<{ path: string; kind: Deliverable['kind'] }> {
  const changes = valueAt(item, 'changes');
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      const path = textAt(change, 'path');
      if (!path) return [];
      return [{ path, kind: deliverableKind(valueAt(change, 'kind') ?? valueAt(change, 'type')) }];
    });
  }
  if (changes && typeof changes === 'object') {
    return Object.entries(changes as Record<string, unknown>).map(([path, change]) => ({
      path,
      kind: deliverableKind(change),
    }));
  }
  return [];
}

/** Turns a raw Codex approval request into something readable without any English or code. */
function describeApproval(
  method: string,
  params: Record<string, unknown>,
  requestId: number | string,
  agentId?: string,
): ApprovalRequest {
  const normalized = method.toLowerCase();
  const command = commandText(
    valueAt(params, 'command') ?? valueAt(params, 'item', 'command') ?? valueAt(params, 'commandLine'),
  );
  const cwd = textAt(params, 'cwd') ?? textAt(params, 'item', 'cwd') ?? textAt(params, 'workdir');
  const reason = textAt(params, 'reason') ?? textAt(params, 'item', 'reason') ?? textAt(params, 'explanation');
  const files = approvalFiles(params).length ? approvalFiles(params) : approvalFiles(valueAt(params, 'item'));
  const raw = JSON.stringify({ method, ...params }, null, 2);

  if (files.length && (normalized.includes('filechange') || normalized.includes('patch') || !command)) {
    const willDelete = files.some((file) => file.kind === 'deleted');
    const bullets = files.slice(0, 12).map((file) => {
      const action = file.kind === 'created' ? '新しく作成' : file.kind === 'deleted' ? '削除' : '書き換え';
      return `${file.path} を${action}します`;
    });
    if (files.length > 12) bullets.push(`ほか ${files.length - 12} 件のファイルも変更されます`);
    const risk: ApprovalRisk = willDelete ? 'high' : 'medium';
    return {
      requestId,
      method,
      agentId,
      kind: 'fileChange',
      title: 'ファイルの書き換え許可のお願い',
      headline: `作業フォルダの中の ${files.length} 個のファイルを書き換えてもよいか確認しています。`,
      bullets,
      cwd,
      reason,
      files,
      risk,
      riskLabel: riskLabels[risk],
      raw,
    };
  }

  if (command) {
    const explanation = commandExplanations.find((entry) => entry.match.test(command));
    const bullets = [
      explanation?.text ?? 'パソコン上でこのコマンドを実行します。',
      `実行される内容：${command}`,
    ];
    if (cwd) bullets.push(`実行する場所：${cwd}`);
    if (reason) bullets.push(`エージェントの説明：${reason}`);
    const risk = explanation?.risk ?? 'medium';
    return {
      requestId,
      method,
      agentId,
      kind: 'command',
      title: 'コマンド実行の許可のお願い',
      headline: 'パソコン上でコマンドを実行してよいか確認しています。',
      bullets,
      command,
      cwd,
      reason,
      files: [],
      risk,
      riskLabel: riskLabels[risk],
      raw,
    };
  }

  return {
    requestId,
    method,
    agentId,
    kind: 'unknown',
    title: '作業を進めてよいかの確認',
    headline: reason ?? 'エージェントが次の作業に進む許可を求めています。',
    bullets: [
      '内容を確認して、進めてよければ「承認する」を押してください。',
      'よく分からないときは「拒否する」を選べば、この操作だけ取りやめになります。',
    ],
    cwd,
    reason,
    files: [],
    risk: 'medium',
    riskLabel: riskLabels.medium,
    raw,
  };
}

function upsertAgent(
  agents: AgentState[],
  id: string,
  patch: Partial<AgentState>,
): AgentState[] {
  const index = agents.findIndex((agent) => agent.id === id || agent.threadId === id);
  if (index < 0) {
    const fallback = fallbackAgentIdentities[Math.max(0, agents.length - 1) % fallbackAgentIdentities.length];
    return [
      ...agents,
      {
        id,
        threadId: id,
        name: patch.isRoot ? '東葛大五郎' : fallback.name,
        role: patch.isRoot ? 'プロジェクト統括責任者' : fallback.role,
        duty: patch.isRoot ? 'director' : fallback.duty,
        status: 'idle',
        task: '指示を待っています',
        activity: '待機中',
        color: patch.isRoot ? directorColor : fallback.color,
        updatedAt: Date.now(),
        ...patch,
      },
    ];
  }
  const next = [...agents];
  next[index] = { ...next[index], ...patch, updatedAt: Date.now() };
  return next;
}

function accountantAgent(): AgentState {
  return {
    id: accountantAgentId,
    name: '金田計理',
    role: '経理担当',
    duty: 'accountant',
    status: 'accounting',
    task: 'トークン使用量を監視',
    activity: '使用量を記帳中',
    speech: '経理室でみんなの使用量を見ているよ',
    speechKind: 'activity',
    color: accountantColor,
    virtual: true,
    updatedAt: Date.now(),
  };
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '1分未満';
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function reportTimestamp(time: number): string {
  const date = new Date(time);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

const workingStatuses: AgentStatus[] = ['planning', 'researching', 'coding', 'running'];

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: demoAgents,
  selectedAgentId: 'director',
  connection: 'demo',
  connectionLabel: 'デモ表示',
  workspace: '',
  logs: initialLogs,
  messages: initialMessages,
  deliverables: [],
  agentProfiles: loadAgentProfiles(),
  roadmap: emptyRoadmap,
  taskHistory: {},
  projectStartedAt: 0,
  accountingReports: loadAccountingReports(),
  usage: emptyUsage,
  usageByThread: {},
  usageUpdatedAt: 0,
  applyRateLimits: (payload) => {
    const rateLimits = readRateLimits(payload);
    if (rateLimits) set({ rateLimits });
  },
  costSettings: readStored(costSettingsStorageKey, defaultCostSettings),
  modelSettings: readStored(modelSettingsStorageKey, defaultModelSettings),
  setCostSettings: (patch) =>
    set((state) => {
      const costSettings = { ...state.costSettings, ...patch };
      writeStored(costSettingsStorageKey, costSettings);
      return { costSettings };
    }),
  setModelSettings: (patch) =>
    set((state) => {
      const modelSettings = { ...state.modelSettings, ...patch };
      writeStored(modelSettingsStorageKey, modelSettings);
      // The payroll meter should follow the model that is actually in use.
      const costSettings = state.costSettings.planId === 'custom'
        ? state.costSettings
        : { ...state.costSettings, planId: modelPlanId(modelSettings) };
      if (costSettings !== state.costSettings) writeStored(costSettingsStorageKey, costSettings);
      return { modelSettings, costSettings };
    }),
  resetUsage: () => set({ usage: emptyUsage, usageByThread: {}, usageUpdatedAt: Date.now() }),
  setWorkspace: (workspace) => set({ workspace, deliverables: [] }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  setConnection: (connection, connectionLabel) => set({ connection, connectionLabel }),
  setRootThread: (rootThreadId) => {
    set((state) => {
      const director = state.agentProfiles.find((profile) => profile.id === 'director-profile');
      const base = state.connection === 'connected' ? [] : state.agents;
      const withDirector = upsertAgent(base, rootThreadId, {
        threadId: rootThreadId,
        name: director?.name ?? '東葛大五郎',
        role: director?.job ?? 'プロジェクト統括責任者',
        duty: 'director',
        color: director?.color ?? directorColor,
        isRoot: true,
        status: 'idle',
        task: '最初の指示を待っています',
        activity: '統括席で待機中',
        speech: '指示をくれれば、担当に割り振るぞ。',
        speechKind: 'activity',
      });
      // 経理担当はCodexのスレッドを持たず、いつも経理室に常駐しています。
      const agents = withDirector.some((agent) => agent.id === accountantAgentId)
        ? withDirector
        : [...withDirector, accountantAgent()];
      return {
        rootThreadId,
        agents,
        messages: state.connection === 'connected'
          ? state.messages.filter((message) => message.id !== 'demo-assistant')
          : state.messages,
        deliverables: state.connection === 'connected' ? [] : state.deliverables,
        selectedAgentId: rootThreadId,
      };
    });
  },
  addLog: (message, level = 'info', agentId) =>
    set((state) => ({
      logs: [
        { id: `${Date.now()}-${Math.random()}`, time: Date.now(), level, message, agentId },
        ...state.logs,
      ].slice(0, 80),
    })),
  addMessage: (message) =>
    set((state) => ({
      messages: upsertMessage(state.messages, {
        id: message.id ?? `${Date.now()}-${Math.random()}`,
        time: Date.now(),
        ...message,
      }),
    })),
  clearApproval: () => set({ approval: undefined }),
  clearQuestion: () =>
    set((state) => ({
      questionRequest: undefined,
      agents: state.questionRequest?.agentId
        ? upsertAgent(state.agents, state.questionRequest.agentId, {
            status: 'planning',
            activity: '回答を受け取り、作業を再開しました',
            speech: 'ありがとう！じゃあ続きを進めるね！',
            speechKind: 'message',
          })
        : state.agents,
    })),
  resetWorkspaceSession: () =>
    set({
      agents: [],
      selectedAgentId: '',
      rootThreadId: undefined,
      messages: [],
      deliverables: [],
      approval: undefined,
      questionRequest: undefined,
      roadmap: emptyRoadmap,
      taskHistory: {},
      projectStartedAt: 0,
      accountingReport: undefined,
      usage: emptyUsage,
      usageByThread: {},
      usageUpdatedAt: Date.now(),
    }),
  hireAgentProfile: (id) =>
    set((state) => {
      const agentProfiles = state.agentProfiles.map((profile) =>
        profile.id === id ? { ...profile, hired: true } : profile,
      );
      saveAgentProfiles(agentProfiles);
      return { agentProfiles };
    }),
  dismissAgentProfile: (id) =>
    set((state) => {
      const agentProfiles = state.agentProfiles.map((profile) =>
        profile.id === id && !profile.permanent ? { ...profile, hired: false } : profile,
      );
      saveAgentProfiles(agentProfiles);
      return { agentProfiles };
    }),
  createAgentProfile: (profile) =>
    set((state) => {
      const agentProfiles = [
        ...state.agentProfiles,
        {
          ...profile,
          id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          hired: true,
          custom: true,
        },
      ];
      saveAgentProfiles(agentProfiles);
      return { agentProfiles };
    }),
  removeAgentProfile: (id) =>
    set((state) => {
      const agentProfiles = state.agentProfiles.filter(
        (profile) => profile.id !== id || !profile.custom,
      );
      saveAgentProfiles(agentProfiles);
      return { agentProfiles };
    }),
  startProject: (title) =>
    set({
      projectStartedAt: Date.now(),
      accountingReport: undefined,
      roadmap: { title, steps: [], startedAt: Date.now(), updatedAt: Date.now() },
    }),
  setRoadmap: (title, steps) =>
    set((state) => {
      if (!steps.length) return {};
      const previous = new Map(state.roadmap.steps.map((step) => [step.title, step]));
      const next: RoadmapStep[] = steps.map((step, index) => {
        const existing = previous.get(step.title);
        return {
          id: existing?.id ?? `step-${index}-${step.title.slice(0, 12)}`,
          title: step.title,
          owner: step.owner ?? existing?.owner ?? ownerFromTitle(step.title, state.agentProfiles),
          status: step.status,
          updatedAt: existing?.status === step.status ? existing.updatedAt : Date.now(),
        };
      });
      return {
        roadmap: {
          title: title || state.roadmap.title || 'プロジェクト進行表',
          steps: next,
          startedAt: state.roadmap.startedAt || Date.now(),
          updatedAt: Date.now(),
        },
      };
    }),
  narrateProgress: () => {
    const state = get();
    const director = state.agents.find((agent) => agent.duty === 'director');
    if (!director) return;
    const busy = state.agents.filter(
      (agent) =>
        agent.id !== director.id &&
        agent.duty !== 'accountant' &&
        workingStatuses.includes(agent.status),
    ).length;
    // 「手が空いている」＝自分では手を動かしていないとき。担当が動いている間の
    // 待ちも含みます。逆に統括自身が承認待ちやエラー対応中なら口を挟みません。
    const free =
      director.status === 'idle' ||
      director.status === 'done' ||
      (director.status === 'planning' && busy > 0);
    if (!free) return;
    const steps = state.roadmap.steps;

    let percent: number;
    if (steps.length) {
      const done = steps.filter((step) => step.status === 'done').length;
      const active = steps.filter((step) => step.status === 'active').length;
      percent = Math.round(((done + active * 0.5) / steps.length) * 100);
    } else {
      const workers = state.agents.filter((agent) => agent.duty !== 'accountant');
      const finished = workers.filter((agent) => agent.status === 'done').length;
      percent = workers.length ? Math.round((finished / workers.length) * 100) : 0;
    }
    percent = Math.max(0, Math.min(100, percent));

    const elapsed = state.projectStartedAt ? Date.now() - state.projectStartedAt : 0;
    let eta = '';
    if (percent >= 100) {
      eta = 'まもなく完了';
    } else if (elapsed > 20_000 && percent > 4) {
      eta = `のこり およそ ${formatDuration((elapsed / percent) * (100 - percent))}`;
    } else {
      eta = '残り時間は計測中';
    }
    const active = steps.find((step) => step.status === 'active');
    const detail = active
      ? `いまは「${clip(active.title, 22)}」`
      : busy
        ? `${busy}名が作業中`
        : '手空きの者はおらんな';

    set((current) => ({
      agents: upsertAgent(current.agents, director.id, {
        speech: `進捗 ${percent}%。${eta}。${detail}。`,
        speechKind: 'message',
        activity: `進捗 ${percent}% を確認中`,
      }),
    }));
  },
  buildAccountingReport: (reason) => {
    const state = get();
    const planId = state.costSettings.planId;
    const plan = findPlan(planId);
    const lines: AccountingLine[] = Object.entries(state.usageByThread)
      .map(([threadId, entry]) => {
        const agent = state.agents.find(
          (candidate) => candidate.id === threadId || candidate.threadId === threadId,
        );
        return {
          threadId,
          name: agent?.name ?? '退勤したスタッフ',
          role: agent?.role ?? '過去のスレッド',
          color: agent?.color ?? 0x94a0a0,
          usage: entry.usage,
          yen: jpyCost(entry.usage, state.costSettings),
          tasks: state.taskHistory[threadId] ?? [],
        };
      })
      .sort((left, right) => right.yen - left.yen);

    const totalYen = jpyCost(state.usage, state.costSettings);
    const elapsedMs = state.projectStartedAt ? Date.now() - state.projectStartedAt : 0;
    const doneSteps = state.roadmap.steps.filter((step) => step.status === 'done').length;
    const createdAt = Date.now();
    const workSummary = [
      state.roadmap.steps.length
        ? `進行 ${doneSteps}/${state.roadmap.steps.length}`
        : '進行表なし',
      `成果物 ${state.deliverables.length}件`,
      `参加 ${lines.length}名`,
    ].join('・');
    const report: AccountingReport = {
      id: `report-${createdAt}`,
      createdAt,
      workspace: state.workspace,
      title: `${reportTimestamp(createdAt)}｜${state.roadmap.title || '今回のプロジェクト'}｜${workSummary}`,
      summary: [
        `${reason}のため、経理担当がここまでの費用をまとめました。`,
        `作業時間 ${formatDuration(elapsedMs)}／参加 ${lines.length}名`,
        state.roadmap.steps.length
          ? `進行表 ${doneSteps}/${state.roadmap.steps.length} 項目が完了`
          : '進行表は作成されていません',
        `成果物 ${state.deliverables.length} 件`,
      ].join(' ・ '),
      lines,
      deliverables: state.deliverables,
      steps: state.roadmap.steps,
      usage: state.usage,
      totalYen,
      planId,
      planLabel: plan.label,
      modelLabel: modelLabel(state.modelSettings),
      estimates: estimateAllPlans(state.usage, state.costSettings),
      elapsedMs,
    };

    set((current) => {
      const accountingReports = [
        report,
        ...current.accountingReports.filter((entry) => entry.id !== report.id),
      ].slice(0, accountingReportLimit);
      saveAccountingReports(accountingReports);
      return {
        accountingReport: report,
        accountingReports,
        agents: upsertAgent(current.agents, accountantAgentId, {
        status: 'accounting',
        activity: '会計報告を作成中',
        speech: `会計報告ができたよ。合計 ￥${totalYen.toFixed(2)} だね`,
        speechKind: 'message',
        }),
      };
    });
    get().addLog('経理担当が会計報告を提出しました', 'success', accountantAgentId);
  },
  openAccountingReport: (id) => set((state) => ({
    accountingReport: state.accountingReports.find((report) => report.id === id)
      ?? state.accountingReport,
  })),
  clearAccountingReport: () => set({ accountingReport: undefined }),
  clearConfigWarning: () => set({ configWarning: undefined }),
  applyLoadedSave: (meta) => {
    set((state) => ({
      // 進行表の見出しと進み具合を、そのセーブの時点に戻します。項目そのものは
      // ファイルとして復元されているので、次のCodexの計画更新で上書きされます。
      roadmap: meta.roadmapTitle
        ? {
            title: meta.roadmapTitle,
            steps: state.roadmap.steps.map((step, index) => ({
              ...step,
              status: index < (meta.roadmapDone ?? 0) ? ('done' as const) : ('pending' as const),
            })),
            startedAt: meta.createdAt,
            updatedAt: Date.now(),
          }
        : state.roadmap,
      accountingReport: undefined,
    }));
    get().addLog(`セーブ「${meta.label}」を読み込みました`, 'success');
  },
  handleCodexEvent: (event) => {
    const params = event.params ?? {};
    const method = event.method;
    const threadId =
      textAt(params, 'threadId') ??
      textAt(params, 'thread', 'id') ??
      textAt(params, 'item', 'threadId');
    const turnId = textAt(params, 'turnId') ?? textAt(params, 'turn', 'id');
    const itemType = textAt(params, 'item', 'type');
    const itemId = textAt(params, 'item', 'id') ?? textAt(params, 'itemId');

    // Token accounting runs for every event: Codex reports usage on several
    // different methods, and some report running totals while others report a
    // single turn.
    const cumulativeUsage =
      // Current App Server versions publish a dedicated notification shaped as
      // { tokenUsage: { total, last } }. This is the fastest and authoritative
      // per-thread source, emitted after each upstream model response.
      readUsage(valueAt(params, 'tokenUsage', 'total')) ??
      readUsage(valueAt(params, 'token_usage', 'total')) ??
      readUsage(valueAt(params, 'info', 'total_token_usage')) ??
      readUsage(valueAt(params, 'info', 'totalTokenUsage')) ??
      readUsage(valueAt(params, 'total_token_usage')) ??
      readUsage(valueAt(params, 'totalTokenUsage'));
    const incrementalUsage =
      readUsage(valueAt(params, 'usage')) ??
      readUsage(valueAt(params, 'turn', 'usage')) ??
      readUsage(valueAt(params, 'info', 'last_token_usage')) ??
      readUsage(valueAt(params, 'info', 'lastTokenUsage'));
    const reportedUsage = cumulativeUsage ?? incrementalUsage;
    if (reportedUsage) {
      const mode = cumulativeUsage ? 'total' : 'delta';
      set((state) => {
        const usageByThread = mergeThreadUsage(
          state.usageByThread,
          threadId ?? 'session',
          reportedUsage,
          mode,
        );
        return { usageByThread, usage: sumUsage(usageByThread), usageUpdatedAt: Date.now() };
      });
    }

    // 使用量の枠は account/rateLimits/updated で届きますが、ターンの終わりに
    // 相乗りしてくることもあるので、どのイベントでも見ておきます。
    const rateLimits = readRateLimits(valueAt(params, 'rateLimits') ?? valueAt(params, 'rate_limits'));
    if (rateLimits) set({ rateLimits });

    if (method === 'pixel/disconnected') {
      get().setConnection('disconnected', '切断');
      get().addLog(textAt(params, 'message') ?? 'Codexとの接続が終了しました', 'error');
      return;
    }
    if (method === 'pixel/diagnostic') {
      get().addLog(textAt(params, 'message') ?? 'Codex diagnostic', 'warning');
      return;
    }

    // Codex reports a broken config.toml here and then carries on with
    // defaults, but `thread/start` still refuses to run — so this warning is
    // the only early clue the user gets. Surface it instead of swallowing it.
    if (method === 'configWarning') {
      const summary = textAt(params, 'summary') ?? 'Codexの設定に問題があります';
      const details = textAt(params, 'details') ?? '';
      set({ configWarning: details ? `${summary} ${details}` : summary });
      get().addLog(`Codexの設定に問題があります：${details || summary}`, 'warning');
      return;
    }

    if (method === 'item/tool/requestUserInput' && event.requestId !== undefined) {
      const questions = parseQuestions(params);
      const questionText = questions.map((question) => question.question).join('\n');
      const requestId = event.requestId as number | string;
      set((state) => ({
        questionRequest: { requestId, agentId: threadId, questions },
        messages: upsertMessage(state.messages, {
          id: `question-${String(requestId)}`,
          agentId: threadId,
          role: 'question',
          text: questionText || 'AIが回答を待っています。',
          time: Date.now(),
        }),
        agents: threadId
          ? upsertAgent(state.agents, threadId, {
              status: 'approval',
              activity: 'あなたの回答を待っています',
              speech: 'ちょっと聞きたいことがあるよ！',
              speechKind: 'question',
              turnId,
            })
          : state.agents,
      }));
      get().addLog('AIから質問が届きました', 'warning', threadId);
      return;
    }

    if (method === 'serverRequest/resolved') {
      const resolvedId = valueAt(params, 'requestId');
      const activeRequest = get().questionRequest;
      if (
        activeRequest &&
        resolvedId !== undefined &&
        String(resolvedId) === String(activeRequest.requestId)
      ) {
        get().clearQuestion();
        get().addLog('AIの質問は自動的に解決されました', 'info', threadId);
      }
      return;
    }

    const isApproval = method.toLowerCase().includes('requestapproval');
    if (isApproval && event.requestId !== undefined) {
      const approval = describeApproval(
        method,
        params,
        event.requestId as number | string,
        threadId,
      );
      set((state) => ({
        approval,
        agents: threadId
          ? upsertAgent(state.agents, threadId, {
              status: 'approval',
              activity: '承認を待っています',
              speech: 'このまま進めてもいいかな？',
              speechKind: 'question',
              turnId,
            })
          : state.agents,
      }));
      get().addLog('操作の承認が必要です', 'warning', threadId);
      return;
    }

    if (method === 'thread/started' && threadId) {
      set((state) => {
        const existing = state.agents.find(
          (agent) => agent.id === threadId || agent.threadId === threadId,
        );
        const isRoot = existing?.isRoot ?? !state.rootThreadId;
        const director = state.agentProfiles.find((profile) => profile.id === 'director-profile');
        const usedNames = new Set(state.agents.map((agent) => agent.name));
        const availableProfile = state.agentProfiles.find(
          (profile) =>
            profile.hired && !profile.permanent && !usedNames.has(profile.name),
        );
        const fallback = fallbackAgentIdentities.find((identity) => !usedNames.has(identity.name))
          ?? fallbackAgentIdentities[state.agents.length % fallbackAgentIdentities.length];
        return {
          agents: upsertAgent(state.agents, threadId, {
            threadId,
            isRoot,
            name: isRoot
              ? director?.name ?? '東葛大五郎'
              : existing?.name ?? availableProfile?.name ?? fallback.name,
            role: isRoot
              ? director?.job ?? 'プロジェクト統括責任者'
              : existing?.role ?? availableProfile?.job ?? fallback.role,
            duty: isRoot
              ? 'director'
              : existing?.duty ?? availableProfile?.duty ?? fallback.duty,
            color: isRoot
              ? director?.color ?? directorColor
              : existing?.color ?? availableProfile?.color ?? fallback.color,
            status: 'idle',
            activity: '出社しました',
            speech: '準備できたよ。何をすればいい？',
            speechKind: 'activity',
          }),
          rootThreadId: state.rootThreadId ?? threadId,
        };
      });
      const arrivedAgent = get().agents.find(
        (agent) => agent.id === threadId || agent.threadId === threadId,
      );
      get().addLog(`${arrivedAgent?.name ?? '新しい仲間'}が出社しました`, 'success', threadId);
      return;
    }

    if (method === 'turn/started' && threadId) {
      set((state) => ({
        projectStartedAt: state.projectStartedAt || Date.now(),
        agents: upsertAgent(state.agents, threadId, {
          turnId,
          status: 'planning',
          activity: '作業を開始しました',
          speech: 'よし、さっそく始めるね！',
          speechKind: 'activity',
        }),
      }));
      get().addLog('新しいターンを開始しました', 'info', threadId);
      return;
    }

    if (method === 'item/agentMessage/delta' && threadId) {
      const delta = textAt(params, 'delta') ?? '';
      if (!delta) return;
      const messageId = itemId ?? `${threadId}-${turnId ?? 'turn'}-message`;
      set((state) => {
        const previous = state.messages.find((message) => message.id === messageId)?.text ?? '';
        const text = `${previous}${delta}`;
        return {
          messages: upsertMessage(state.messages, {
            id: messageId,
            agentId: threadId,
            role: 'assistant',
            text,
            time: Date.now(),
          }),
          agents: upsertAgent(state.agents, threadId, {
            turnId,
            status: 'planning',
            activity: '報告を作成中',
            // 先頭を出すことで、流れてくる途中でも文の頭から読めます。
            speech: clip(text, 64) || 'いまの進み具合をまとめているよ',
            speechKind: 'message',
          }),
        };
      });
      return;
    }

    if ((method === 'item/started' || method === 'item/completed') && threadId) {
      const item = valueAt(params, 'item');
      const phase = textAt(item, 'phase');
      const description = describeItem(itemType, item, phase);
      const agentMessage = itemType?.toLowerCase() === 'agentmessage'
        ? textAt(item, 'text')
        : undefined;

      // 進行表：Codexが計画（todo/plan）を出したら、そのまま掲示します。
      const roadmapItems = parseRoadmapItems(item);
      if (roadmapItems.length) {
        get().setRoadmap(
          get().roadmap.title || 'プロジェクト進行表',
          roadmapItems,
        );
      } else if (agentMessage && threadId === get().rootThreadId) {
        const fromText = parseRoadmapFromText(agentMessage);
        if (fromText.length && !get().roadmap.steps.length) {
          get().setRoadmap('プロジェクト進行表', fromText);
        }
      }

      const completedDeliverables = method === 'item/completed' && itemType?.toLowerCase() === 'filechange'
        ? arrayAt(item, 'changes').flatMap((change, index) => {
            const path = textAt(change, 'path');
            if (!path) return [];
            return [{
              id: `${itemId ?? 'change'}-${index}`,
              agentId: threadId,
              path,
              kind: deliverableKind(valueAt(change, 'kind')),
              time: Date.now(),
            } satisfies Deliverable];
          })
        : [];
      set((state) => ({
        taskHistory: rememberTask(state.taskHistory, threadId, description.task),
        messages: agentMessage && itemId
          ? upsertMessage(state.messages, {
              id: itemId,
              agentId: threadId,
              role: 'assistant',
              text: agentMessage,
              phase: phase === 'commentary' || phase === 'final_answer' ? phase : undefined,
              time: Date.now(),
            })
          : state.messages,
        deliverables: completedDeliverables.length
          ? upsertDeliverables(state.deliverables, completedDeliverables)
          : state.deliverables,
        agents: upsertAgent(state.agents, threadId, {
          turnId,
          status: description.status,
          activity: description.activity,
          task: description.task,
          speech: description.speech,
          speechKind: agentMessage ? 'message' : 'activity',
        }),
      }));
      return;
    }

    if (method === 'turn/completed' && threadId) {
      const failed = Boolean(valueAt(params, 'turn', 'error'));
      set((state) => ({
        messages: failed ? state.messages : markLatestAssistantFinal(state.messages, threadId),
        agents: upsertAgent(state.agents, threadId, {
          status: failed ? 'error' : 'done',
          activity: failed ? 'エラーで停止しました' : '作業を完了しました',
          speech: failed
            ? 'うまくいかなかったみたい。確認してみるね'
            : 'できたよ！黒板を見てね！',
          speechKind: failed ? 'question' as const : 'message' as const,
        }),
      }));
      get().addLog(failed ? 'ターンが失敗しました' : 'ターンが完了しました', failed ? 'error' : 'success', threadId);

      // 全員の手が止まったら、経理担当が会計報告をまとめます。担当者のほうが
      // あとに終わることもあるので、どのスレッドの完了でも判定します。
      const state = get();
      const stillWorking = state.agents.some(
        (agent) => agent.duty !== 'accountant' && workingStatuses.includes(agent.status),
      );
      const rootAgent = state.agents.find(
        (agent) => agent.id === state.rootThreadId || agent.threadId === state.rootThreadId,
      );
      if (!failed && !stillWorking && rootAgent?.status === 'done' && !state.accountingReport) {
        const roadmap = state.roadmap;
        if (roadmap.steps.length) {
          get().setRoadmap(
            roadmap.title,
            roadmap.steps.map((step) => ({ ...step, status: 'done' as const })),
          );
        }
        get().buildAccountingReport('全作業の完了');
      }
      return;
    }

    const childThreadIds = [
      textAt(params, 'item', 'newThreadId'),
      textAt(params, 'newThreadId'),
      textAt(params, 'receiverThreadId'),
      ...arrayAt(params, 'item', 'receiverThreadIds').filter(
        (value): value is string => typeof value === 'string',
      ),
    ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
    if (itemType?.toLowerCase().includes('collab') && childThreadIds.length) {
      set((state) => ({
        agents: childThreadIds.reduce((current, childThreadId) => {
          const prompt = textAt(params, 'item', 'prompt') ?? '';
          const profile = state.agentProfiles.find(
            (candidate) =>
              candidate.hired && !candidate.permanent && (
                prompt.toLowerCase().includes(candidate.name.toLowerCase())
                || prompt.toLowerCase().includes(candidate.job.toLowerCase())
              ),
          );
          return upsertAgent(current, childThreadId, {
            parentThreadId: threadId,
            ...(profile
              ? { name: profile.name, role: profile.job, duty: profile.duty, color: profile.color }
              : { role: 'サブエージェント' }),
            status: 'planning',
            task: prompt || '統括責任者から依頼を受信',
            activity: '担当タスクを確認中',
            speech: prompt
              ? `「${clip(prompt, 34)}」を担当することになったよ`
              : '任せて！担当の作業を始めるね',
            speechKind: 'activity',
          });
        }, state.agents),
      }));
      for (const childThreadId of childThreadIds) {
        const joinedAgent = get().agents.find(
          (agent) => agent.id === childThreadId || agent.threadId === childThreadId,
        );
        get().addLog(`${joinedAgent?.name ?? '新しい仲間'}が参加しました`, 'success', childThreadId);
      }
    }
  },
}));
