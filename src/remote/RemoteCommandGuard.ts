import type { RemoteInstruction } from './RemoteProtocol';

export interface GuardResult {
  instruction?: RemoteInstruction;
  error?: string;
}

const maxInstructionLength = 4_000;
const maxCommandAgeMs = 2 * 60_000;
const maxFutureSkewMs = 30_000;
const rememberedMessageLimit = 512;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

export class RemoteCommandGuard {
  private readonly seenMessageIds = new Set<string>();

  validate(value: unknown, expectedHostId: string, now = Date.now()): GuardResult {
    const envelope = record(value);
    if (!envelope) return { error: 'メッセージ形式が不正です' };
    if (envelope.version !== 1) return { error: '対応していないプロトコルです' };
    if (envelope.type !== 'instruction.submit') return { error: '許可されていない操作です' };
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
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > maxInstructionLength) {
      return { error: `指示は1～${maxInstructionLength}文字で送ってください` };
    }
    const deviceId = typeof payload?.deviceId === 'string'
      ? payload.deviceId.trim().slice(0, 128)
      : undefined;

    this.remember(messageId);
    return { instruction: { messageId, deviceId, text, createdAt } };
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
