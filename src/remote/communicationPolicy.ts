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

export function formatCommunicationMessage(
  text: string | undefined,
  policy: CommunicationPolicy,
): string | undefined {
  if (!text || policy.contentLevel === 'status-only') return undefined;
  let formatted = text.trim();
  if (policy.hideSensitiveDetails) {
    formatted = formatted
      .replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, '[ファイルパス]')
      .replace(/\/(?:Users|home)\/[^\s"'<>|]+/g, '[ファイルパス]')
      .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[非表示]');
  }
  const limit = policy.contentLevel === 'summary' ? 240 : 1_000;
  return formatted.slice(0, limit);
}
