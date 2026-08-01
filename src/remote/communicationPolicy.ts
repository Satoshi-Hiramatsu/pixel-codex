import type { ApprovalRequest } from '../stores/agentStore';
import type { UserQuestionRequest } from '../types';
import { normalizePreviewUrls } from './previewSources';
import type { RemoteApprovalRequest, RemoteQuestionRequest } from './RemoteProtocol';

export type CommunicationContentLevel = 'status-only' | 'summary' | 'final-message';

export interface CommunicationEvents {
  turnCompleted: boolean;
  approvalRequested: boolean;
  questionRequested: boolean;
  errorOccurred: boolean;
}

export interface CommunicationPolicy {
  enabled: boolean;
  relayUrl: string;
  autoReconnect: boolean;
  allowRemoteInstructions: boolean;
  /**
   * 端末から承認の可否と質問への回答を返せるようにするか。コマンド実行の許可を
   * 手元から出せてしまうため、既定では切ってあります。
   */
  allowRemoteApprovals: boolean;
  /**
   * 端末からの要求で画面を撮って渡せるようにするか。撮ったものがそのまま端末へ
   * 届くため、承認と同じく既定では切ってあります。
   */
  allowRemotePreview: boolean;
  /** 撮影対象として登録した開発サーバーなどのURL。 */
  previewUrls: string[];
  events: CommunicationEvents;
  contentLevel: CommunicationContentLevel;
  hideSensitiveDetails: boolean;
}

export type CommunicationPolicyPatch =
  Partial<Omit<CommunicationPolicy, 'events'>> & {
    events?: Partial<CommunicationEvents>;
  };

const storageKey = 'pixel-codex-communication-policy-v1';

export const defaultCommunicationPolicy: CommunicationPolicy = {
  enabled: false,
  relayUrl: '',
  autoReconnect: true,
  allowRemoteInstructions: true,
  allowRemoteApprovals: false,
  allowRemotePreview: false,
  previewUrls: [],
  events: {
    turnCompleted: true,
    approvalRequested: true,
    questionRequested: true,
    errorOccurred: true,
  },
  contentLevel: 'summary',
  hideSensitiveDetails: true,
};

const contentLevels = new Set<CommunicationContentLevel>([
  'status-only',
  'summary',
  'final-message',
]);

function normalizePolicy(value: unknown): CommunicationPolicy {
  if (!value || typeof value !== 'object') return defaultCommunicationPolicy;
  const stored = value as Partial<CommunicationPolicy>;
  const events: Partial<CommunicationEvents> = stored.events && typeof stored.events === 'object'
    ? stored.events
    : {};

  return {
    enabled: stored.enabled === true,
    relayUrl: typeof stored.relayUrl === 'string' ? stored.relayUrl.trim() : '',
    autoReconnect: stored.autoReconnect !== false,
    allowRemoteInstructions: stored.allowRemoteInstructions !== false,
    allowRemoteApprovals: stored.allowRemoteApprovals === true,
    allowRemotePreview: stored.allowRemotePreview === true,
    previewUrls: normalizePreviewUrls(stored.previewUrls),
    events: {
      turnCompleted: events.turnCompleted !== false,
      approvalRequested: events.approvalRequested !== false,
      questionRequested: events.questionRequested !== false,
      errorOccurred: events.errorOccurred !== false,
    },
    contentLevel: contentLevels.has(stored.contentLevel as CommunicationContentLevel)
      ? stored.contentLevel as CommunicationContentLevel
      : 'summary',
    hideSensitiveDetails: stored.hideSensitiveDetails !== false,
  };
}

export function loadCommunicationPolicy(): CommunicationPolicy {
  try {
    const stored = globalThis.localStorage?.getItem(storageKey);
    return stored ? normalizePolicy(JSON.parse(stored)) : defaultCommunicationPolicy;
  } catch {
    return defaultCommunicationPolicy;
  }
}

export function saveCommunicationPolicy(policy: CommunicationPolicy): void {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(normalizePolicy(policy)));
  } catch {
    // A blocked localStorage must not prevent the office from starting.
  }
}

export function mergeCommunicationPolicy(
  current: CommunicationPolicy,
  patch: CommunicationPolicyPatch,
): CommunicationPolicy {
  return normalizePolicy({
    ...current,
    ...patch,
    events: {
      ...current.events,
      ...patch.events,
    },
  });
}

function redactSensitive(text: string, policy: CommunicationPolicy): string {
  if (!policy.hideSensitiveDetails) return text;
  return text
    .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, '[ファイルパス]')
    .replace(/\/(?:Users|home)\/[^\s"'<>|]+/g, '[ファイルパス]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[非表示]');
}

export function formatCommunicationMessage(
  text: string | undefined,
  policy: CommunicationPolicy,
): string | undefined {
  if (!text || policy.contentLevel === 'status-only') return undefined;
  const formatted = redactSensitive(text.trim(), policy);
  const limit = policy.contentLevel === 'summary' ? 240 : 1_000;
  return formatted.slice(0, limit);
}

/**
 * 承認待ちを端末へ渡せる形にします。可否を委ねない設定なら何も渡しません。
 * 実行するコマンド自体は判断材料なので、機微情報を隠す設定のときだけ伏せます。
 */
export function formatRemoteApproval(
  approval: ApprovalRequest | undefined,
  policy: CommunicationPolicy,
): RemoteApprovalRequest | undefined {
  if (!approval || !policy.allowRemoteApprovals) return undefined;
  return {
    requestId: String(approval.requestId),
    kind: approval.kind,
    title: approval.title.slice(0, 200),
    headline: redactSensitive(approval.headline, policy).slice(0, 400),
    bullets: approval.bullets.slice(0, 6).map((bullet) => redactSensitive(bullet, policy).slice(0, 200)),
    command: approval.command ? redactSensitive(approval.command, policy).slice(0, 600) : undefined,
    cwd: approval.cwd ? redactSensitive(approval.cwd, policy).slice(0, 300) : undefined,
    risk: approval.risk,
    riskLabel: approval.riskLabel.slice(0, 60),
  };
}

export function formatRemoteQuestion(
  request: UserQuestionRequest | undefined,
  policy: CommunicationPolicy,
): RemoteQuestionRequest | undefined {
  if (!request || !policy.allowRemoteApprovals) return undefined;
  return {
    requestId: String(request.requestId),
    questions: request.questions.slice(0, 12).map((question) => ({
      id: question.id,
      header: question.header.slice(0, 80),
      // 秘密扱いの入力は端末へ出しません。PCで答えてもらいます。
      question: question.isSecret
        ? '（秘密の入力のためPCで回答してください）'
        : redactSensitive(question.question, policy).slice(0, 600),
      options: (question.options ?? []).slice(0, 6).map((option) => option.label.slice(0, 80)),
    })),
  };
}
