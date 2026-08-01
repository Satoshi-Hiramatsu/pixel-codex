import type {
  RemoteApprovalResponse,
  RemoteInstruction,
  RemotePreviewRequest,
  RemotePreviewSourcesRequest,
  RemoteQuestionResponse,
} from './RemoteProtocol';

export type RemoteCommand =
  | { kind: 'instruction'; instruction: RemoteInstruction }
  | { kind: 'approval'; approval: RemoteApprovalResponse }
  | { kind: 'question'; question: RemoteQuestionResponse }
  | { kind: 'previewSources'; request: RemotePreviewSourcesRequest }
  | { kind: 'preview'; request: RemotePreviewRequest };

export interface GuardResult {
  command?: RemoteCommand;
  error?: string;
}

const maxInstructionLength = 4_000;
const maxAnswerLength = 1_000;
const maxAnswerCount = 12;
const maxCommandAgeMs = 2 * 60_000;
const maxFutureSkewMs = 30_000;
const rememberedMessageLimit = 512;
/**
 * 撮影はウィンドウの生成とレンダリングを伴うので、連打されるとPCが目に見えて重く
 * なります。指示や承認と違って押し直しても意味がない操作なので、間隔を空けさせます。
 */
const previewIntervalMs = 5_000;
const previewSourcesIntervalMs = 2_000;
const trackedDeviceLimit = 32;
const acceptedTypes = new Set([
  'instruction.submit',
  'approval.respond',
  'question.respond',
  'preview.sources.request',
  'preview.request',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function trimmedString(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export class RemoteCommandGuard {
  private readonly seenMessageIds = new Set<string>();
  private readonly lastAcceptedAt = new Map<string, number>();

  validate(value: unknown, expectedHostId: string, now = Date.now()): GuardResult {
    const envelope = record(value);
    if (!envelope) return { error: 'メッセージ形式が不正です' };
    if (envelope.version !== 1) return { error: '対応していないプロトコルです' };
    const type = typeof envelope.type === 'string' ? envelope.type : '';
    if (!acceptedTypes.has(type)) return { error: '許可されていない操作です' };
    if (envelope.hostId !== expectedHostId) return { error: '送信先PCが一致しません' };

    const messageId = typeof envelope.messageId === 'string' ? envelope.messageId.trim() : '';
    if (!messageId || messageId.length > 128) return { error: 'messageIdが不正です' };
    if (this.seenMessageIds.has(messageId)) return { error: '同じ指示はすでに受信済みです' };

    const createdAt = typeof envelope.createdAt === 'string' ? Date.parse(envelope.createdAt) : NaN;
    if (!Number.isFinite(createdAt)) return { error: '送信時刻が不正です' };
    if (now - createdAt > maxCommandAgeMs || createdAt - now > maxFutureSkewMs) {
      return { error: '指示の有効期限が切れています' };
    }

    const payload = record(envelope.payload);
    const deviceId = trimmedString(payload?.deviceId, 128) || undefined;
    const throttled = this.throttled(type, deviceId, now);
    if (throttled) return { error: throttled };
    const built = this.build(type, payload, { messageId, deviceId, createdAt });
    if (built.error) return built;

    this.remember(messageId);
    this.recordAccepted(type, deviceId, now);
    return built;
  }

  private build(
    type: string,
    payload: Record<string, unknown> | undefined,
    head: { messageId: string; deviceId?: string; createdAt: number },
  ): GuardResult {
    if (type === 'instruction.submit') {
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!text || text.length > maxInstructionLength) {
        return { error: `指示は1～${maxInstructionLength}文字で送ってください` };
      }
      return { command: { kind: 'instruction', instruction: { ...head, text } } };
    }

    if (type === 'preview.sources.request') {
      return { command: { kind: 'previewSources', request: { ...head } } };
    }

    if (type === 'preview.request') {
      const sourceId = trimmedString(payload?.sourceId, 128);
      if (!sourceId) return { error: '撮影する対象が指定されていません' };
      const viewport = payload?.viewport === 'mobile' ? 'mobile' as const : 'desktop' as const;
      return { command: { kind: 'preview', request: { ...head, sourceId, viewport } } };
    }

    const requestId = trimmedString(payload?.requestId, 128);
    if (!requestId) return { error: '対象の要求が指定されていません' };

    if (type === 'approval.respond') {
      const decision = payload?.decision;
      if (decision !== 'accept' && decision !== 'decline') {
        return { error: '承認・拒否のどちらかを送ってください' };
      }
      return { command: { kind: 'approval', approval: { ...head, requestId, decision } } };
    }

    const rawAnswers = record(payload?.answers);
    if (!rawAnswers) return { error: '回答が入っていません' };
    const entries = Object.entries(rawAnswers).slice(0, maxAnswerCount);
    const answers: Record<string, string> = {};
    for (const [questionId, answer] of entries) {
      const id = questionId.trim().slice(0, 128);
      const text = trimmedString(answer, maxAnswerLength);
      if (!id || !text) return { error: 'すべての質問に回答してください' };
      answers[id] = text;
    }
    if (!Object.keys(answers).length) return { error: '回答が入っていません' };
    return { command: { kind: 'question', question: { ...head, requestId, answers } } };
  }

  /** 間隔を空けさせたい操作だけがキーを持ちます。指示や承認は対象外です。 */
  private throttleKey(type: string, deviceId?: string): string | undefined {
    if (type === 'preview.request') return `preview:${deviceId ?? ''}`;
    if (type === 'preview.sources.request') return `sources:${deviceId ?? ''}`;
    return undefined;
  }

  private throttleInterval(type: string): number {
    return type === 'preview.request' ? previewIntervalMs : previewSourcesIntervalMs;
  }

  private throttled(type: string, deviceId: string | undefined, now: number): string | undefined {
    const key = this.throttleKey(type, deviceId);
    if (!key) return undefined;
    const interval = this.throttleInterval(type);
    const last = this.lastAcceptedAt.get(key);
    if (last === undefined || now - last >= interval) return undefined;
    return `続けて要求しすぎです。${Math.ceil((interval - (now - last)) / 1_000)}秒ほど空けてください`;
  }

  private recordAccepted(type: string, deviceId: string | undefined, now: number): void {
    const key = this.throttleKey(type, deviceId);
    if (!key) return;
    this.lastAcceptedAt.delete(key);
    this.lastAcceptedAt.set(key, now);
    while (this.lastAcceptedAt.size > trackedDeviceLimit) {
      const oldest = this.lastAcceptedAt.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lastAcceptedAt.delete(oldest);
    }
  }

  private remember(messageId: string): void {
    this.seenMessageIds.add(messageId);
    while (this.seenMessageIds.size > rememberedMessageLimit) {
      const oldest = this.seenMessageIds.values().next().value as string | undefined;
      if (!oldest) break;
      this.seenMessageIds.delete(oldest);
    }
  }
}
