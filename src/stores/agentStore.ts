import { create } from 'zustand';

import {
  addUsage,
  defaultCostSettings,
  emptyUsage,
  type CostSettings,
  type TokenUsage,
} from '../costs';
import type {
  ActivityLog,
  AgentProfile,
  AgentState,
  AgentStatus,
  CodexEvent,
  ConversationMessage,
  ConnectionStatus,
  Deliverable,
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

function loadCostSettings(): CostSettings {
  try {
    const stored = globalThis.localStorage?.getItem(costSettingsStorageKey);
    if (!stored) return defaultCostSettings;
    const parsed = JSON.parse(stored) as Partial<CostSettings>;
    return { ...defaultCostSettings, ...parsed };
  } catch {
    return defaultCostSettings;
  }
}

function saveCostSettings(settings: CostSettings): void {
  try {
    globalThis.localStorage?.setItem(costSettingsStorageKey, JSON.stringify(settings));
  } catch {
    // Settings simply fall back to defaults on the next launch.
  }
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
  usage: TokenUsage;
  usageByThread: Record<string, ThreadUsage>;
  usageUpdatedAt: number;
  costSettings: CostSettings;
  setCostSettings: (patch: Partial<CostSettings>) => void;
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
    profile: Pick<AgentProfile, 'name' | 'job' | 'specialty' | 'personality' | 'color'>,
  ) => void;
  removeAgentProfile: (id: string) => void;
}

const now = Date.now();
const demoAgents: AgentState[] = [
  {
    id: 'manager',
    name: '企画一郎',
    role: '企画・統括担当',
    status: 'planning',
    task: 'プロジェクトを分解して担当を割り当て',
    activity: '計画を整理中',
    speech: 'まずはみんなの役割を決めるね！',
    speechKind: 'activity',
    color: 0xf0bd55,
    isRoot: true,
    updatedAt: now,
  },
  {
    id: 'researcher',
    name: '調辺探',
    role: '調査担当',
    status: 'researching',
    task: 'App Serverのイベント仕様を確認',
    activity: '資料室で調査中',
    speech: '必要なことを調べてくるね！',
    speechKind: 'activity',
    color: 0x65b7d8,
    updatedAt: now,
  },
  {
    id: 'builder',
    name: '組立実',
    role: '実装担当',
    status: 'coding',
    task: 'ピクセルオフィスUIを実装',
    activity: 'ファイルを編集中',
    speech: 'ただいま作業中～',
    speechKind: 'activity',
    color: 0xe1775b,
    updatedAt: now,
  },
  {
    id: 'tester',
    name: '試験守',
    role: 'テスト担当',
    status: 'running',
    task: 'Windowsビルドを検証',
    activity: 'テストを実行中',
    speech: 'ちゃんと動くか確かめているよ！',
    speechKind: 'activity',
    color: 0x78b56c,
    updatedAt: now,
  },
];

const initialMessages: ConversationMessage[] = [
  {
    id: 'demo-assistant',
    agentId: 'manager',
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
    message: '組立実が実装席へ移動しました',
  },
];

const colors = [0xf0bd55, 0x65b7d8, 0xe1775b, 0x78b56c, 0xb58bd4, 0xe09cb2];
const profileStorageKey = 'pixel-codex-agent-profiles-v1';
const fallbackAgentIdentities = [
  { name: '調辺探', role: '調査担当', color: 0x65b7d8 },
  { name: '組立実', role: '実装担当', color: 0xe1775b },
  { name: '試験守', role: 'テスト担当', color: 0x78b56c },
  { name: '絵描大好', role: 'デザイン担当', color: 0xe09cb2 },
  { name: '見直正', role: 'レビュー担当', color: 0xb58bd4 },
  { name: '文書綴', role: 'ドキュメント担当', color: 0xe4a05f },
  { name: '守安堅', role: 'セキュリティ担当', color: 0x6ca69a },
  { name: '速度駿', role: '性能改善担当', color: 0x7f9fd1 },
];

const defaultAgentProfiles: AgentProfile[] = [
  {
    id: 'manager-profile',
    name: '企画一郎',
    job: '企画・統括担当',
    specialty: '要件整理、計画、仕事の割り振り',
    personality: '落ち着いて全体をまとめるリーダー',
    color: 0xf0bd55,
    hired: true,
  },
  {
    id: 'scout-profile',
    name: '調辺探',
    job: '調査担当',
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
      hired: storedById.get(profile.id)?.hired ?? profile.hired,
    }));
    const custom = parsed.filter((profile) => profile.custom && !defaultIds.has(profile.id));
    return [...defaults, ...custom];
  } catch {
    return defaultAgentProfiles;
  }
}

function saveAgentProfiles(profiles: AgentProfile[]): void {
  try {
    globalThis.localStorage?.setItem(profileStorageKey, JSON.stringify(profiles));
  } catch {
    // The app still works for the current session when storage is unavailable.
  }
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

function itemSpeech(type?: string, phase?: string): string {
  const normalized = type?.toLowerCase() ?? '';
  if (normalized.includes('agentmessage')) {
    return phase === 'final_answer'
      ? 'できたよ！成果物を黒板にまとめたよ！'
      : 'いまの進み具合をまとめているよ';
  }
  if (normalized.includes('plan')) return 'どう進めるか考えているよ～';
  if (normalized.includes('commandexecution')) return 'ちゃんと動くか確かめているよ！';
  if (normalized.includes('filechange')) return 'ただいま作業中～。もう少し待ってね！';
  if (normalized.includes('websearch')) return '必要なことを調べてくるね！';
  if (normalized.includes('mcptool')) return '便利な道具を使って調べているよ';
  if (normalized.includes('collab')) return '仲間にも手伝ってもらうね！';
  return 'ただいま作業中～';
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

function commandText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is string => typeof part === 'string').join(' ');
  }
  return '';
}

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

function statusFromItem(type?: string): AgentStatus {
  const normalized = type?.toLowerCase() ?? '';
  if (normalized.includes('websearch')) return 'researching';
  if (normalized.includes('filechange')) return 'coding';
  if (normalized.includes('commandexecution') || normalized.includes('mcptool')) return 'running';
  if (normalized.includes('error')) return 'error';
  return 'planning';
}

function activityFromItem(type?: string): string {
  const normalized = type?.toLowerCase() ?? '';
  if (normalized.includes('websearch')) return 'Webを調査中';
  if (normalized.includes('filechange')) return 'ファイルを編集中';
  if (normalized.includes('commandexecution')) return 'コマンドを実行中';
  if (normalized.includes('mcptool')) return '外部ツールを使用中';
  if (normalized.includes('agentmessage')) return '報告を作成中';
  return '作業を進行中';
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
        name: patch.isRoot ? '企画一郎' : fallback.name,
        role: patch.isRoot ? '企画・統括担当' : fallback.role,
        status: 'idle',
        task: '指示を待っています',
        activity: '待機中',
        color: patch.isRoot ? colors[0] : fallback.color,
        updatedAt: Date.now(),
        ...patch,
      },
    ];
  }
  const next = [...agents];
  next[index] = { ...next[index], ...patch, updatedAt: Date.now() };
  return next;
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: demoAgents,
  selectedAgentId: 'manager',
  connection: 'demo',
  connectionLabel: 'デモ表示',
  workspace: '',
  logs: initialLogs,
  messages: initialMessages,
  deliverables: [],
  agentProfiles: loadAgentProfiles(),
  usage: emptyUsage,
  usageByThread: {},
  usageUpdatedAt: 0,
  costSettings: loadCostSettings(),
  setCostSettings: (patch) =>
    set((state) => {
      const costSettings = { ...state.costSettings, ...patch };
      saveCostSettings(costSettings);
      return { costSettings };
    }),
  resetUsage: () => set({ usage: emptyUsage, usageByThread: {}, usageUpdatedAt: Date.now() }),
  setWorkspace: (workspace) => set({ workspace, deliverables: [] }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  setConnection: (connection, connectionLabel) => set({ connection, connectionLabel }),
  setRootThread: (rootThreadId) => {
    set((state) => {
      const manager = state.agentProfiles.find((profile) => profile.id === 'manager-profile');
      return {
        rootThreadId,
        agents: upsertAgent(state.connection === 'connected' ? [] : state.agents, rootThreadId, {
          threadId: rootThreadId,
          name: manager?.name ?? '企画一郎',
          role: manager?.job ?? '企画・統括担当',
          color: manager?.color ?? colors[0],
          isRoot: true,
          status: 'idle',
          task: '最初の指示を待っています',
          activity: '待機中',
          speech: '次は何をすればいい？',
          speechKind: 'activity',
        }),
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
        profile.id === id && profile.id !== 'manager-profile'
          ? { ...profile, hired: false }
          : profile,
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

    if (method === 'pixel/disconnected') {
      get().setConnection('disconnected', '切断');
      get().addLog(textAt(params, 'message') ?? 'Codexとの接続が終了しました', 'error');
      return;
    }
    if (method === 'pixel/diagnostic') {
      get().addLog(textAt(params, 'message') ?? 'Codex diagnostic', 'warning');
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
        const manager = state.agentProfiles.find((profile) => profile.id === 'manager-profile');
        const usedNames = new Set(state.agents.map((agent) => agent.name));
        const availableProfile = state.agentProfiles.find(
          (profile) => profile.hired && profile.id !== 'manager-profile' && !usedNames.has(profile.name),
        );
        const fallback = fallbackAgentIdentities.find((identity) => !usedNames.has(identity.name))
          ?? fallbackAgentIdentities[state.agents.length % fallbackAgentIdentities.length];
        return {
          agents: upsertAgent(state.agents, threadId, {
            threadId,
            isRoot,
            name: isRoot
              ? manager?.name ?? '企画一郎'
              : existing?.name ?? availableProfile?.name ?? fallback.name,
            role: isRoot
              ? manager?.job ?? '企画・統括担当'
              : existing?.role ?? availableProfile?.job ?? fallback.role,
            color: isRoot
              ? manager?.color ?? colors[0]
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
            activity: 'メッセージを作成中',
            speech: 'いまの進み具合をまとめているよ',
            speechKind: 'message',
          }),
        };
      });
      return;
    }

    if ((method === 'item/started' || method === 'item/completed') && threadId) {
      const status = statusFromItem(itemType);
      const item = valueAt(params, 'item');
      const agentMessage = itemType?.toLowerCase() === 'agentmessage'
        ? textAt(item, 'text')
        : undefined;
      const phase = textAt(item, 'phase');
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
          status,
          activity: activityFromItem(itemType),
          task: itemType ? `${itemType}${itemId ? ` · ${itemId.slice(0, 8)}` : ''}` : 'タスクを処理中',
          speech: itemSpeech(itemType, phase),
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
              candidate.hired && (
                prompt.toLowerCase().includes(candidate.name.toLowerCase())
                || prompt.toLowerCase().includes(candidate.job.toLowerCase())
              ),
          );
          return upsertAgent(current, childThreadId, {
            parentThreadId: threadId,
            ...(profile
              ? { name: profile.name, role: profile.job, color: profile.color }
              : { role: 'サブエージェント' }),
            status: 'planning',
            task: prompt || '親エージェントから依頼を受信',
            activity: '担当タスクを確認中',
            speech: '任せて！担当の作業を始めるね',
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
