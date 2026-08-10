import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 赤ペン先生（AkapenSensei）から赤入れ画像と指示を受け取るための取り決め。
 *
 * この一枚は意図的にどこにも依存させていません。Pixel Codex本体だけでなく、
 * 検証用のスクリプトからもそのまま読み込めるようにするためです。
 */

export const bridgeProtocolVersion = 1;

/** まだ受け入れられる版。古い赤ペン先生を切り捨てるときはここから外します。 */
export const bridgeSupportedVersions: readonly number[] = [1];

/** JSONLの1行の上限。超えた時点で読むのをやめ、接続ごと閉じます。 */
export const maxLineBytes = 64 * 1024;
/** 指示の長さ。既存の `codex:send-task` と同じ上限に揃えています。 */
export const maxInstructionLength = 20_000;
/** 赤入れ画像の上限。既存の添付（`maxAttachmentBytes`）と同じにしています。 */
export const maxImageBytes = 20 * 1024 * 1024;
/** 確認待ちのまま溜められる件数。人が捌ける量を超えても意味がないので絞ります。 */
export const maxPendingTasks = 8;
export const maxSourceLength = 64;
/** nonceと証明の長さ（16進）。 */
export const nonceHexLength = 32;
export const proofHexLength = 64;

/** PNGの先頭8バイト。拡張子ではなく中身で確かめます。 */
export const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type BridgeTaskMode = 'Discuss' | 'Edit';

/** 赤ペン先生が送ってくる仕事ひとつぶん。 */
export interface BridgeTaskPayload {
  id: string;
  instruction: string;
  imagePath: string;
  workingDirectory: string;
  mode: BridgeTaskMode;
  source: string;
  createdAtUtc: string;
}

export interface BridgeHello {
  type: 'hello';
  protocolVersion: number;
  clientNonce: string;
  client: { name: string; version: string };
}

export interface BridgeSubmitTask {
  type: 'submitTask';
  protocolVersion: number;
  requestId: string;
  clientProof: string;
  task: BridgeTaskPayload;
}

export interface BridgeCancelTask {
  type: 'cancelTask';
  taskId: string;
}

export type BridgeClientMessage = BridgeHello | BridgeSubmitTask | BridgeCancelTask;

export interface BridgeHelloResult {
  type: 'helloResult';
  protocolVersion: number;
  accepted: boolean;
  app: { name: string; version: string };
  /** 受け入れたときだけ入ります。サーバーが同じトークンを知っている証明です。 */
  serverProof?: string;
  serverNonce?: string;
  /** 断ったときだけ入ります。 */
  supported?: readonly number[];
  reason?: string;
}

export interface BridgeAccepted {
  type: 'accepted';
  requestId: string;
  taskId: string;
}

export type BridgeTaskPhase = 'pending' | 'started';

export interface BridgeStatus {
  type: 'status';
  taskId: string;
  phase: BridgeTaskPhase;
  detail: string;
}

export interface BridgeCompleted {
  type: 'completed';
  taskId: string;
  summary?: string;
}

export interface BridgeFailed {
  type: 'failed';
  reason: string;
  taskId?: string;
  requestId?: string;
}

export type BridgeServerMessage =
  | BridgeHelloResult
  | BridgeAccepted
  | BridgeStatus
  | BridgeCompleted
  | BridgeFailed;

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail<T>(reason: string): BridgeResult<T> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** 1行ぶんのJSONを組み立てます。JSONLなので改行は本文に混ぜられません。 */
export function encodeMessage(message: BridgeServerMessage | BridgeClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function randomNonce(): string {
  return randomBytes(nonceHexLength / 2).toString('hex');
}

/**
 * 相手が同じトークンを知っていることの証明。トークンそのものは決して送りません。
 * 名前付きパイプの名前を先取りした偽のサーバーがいても、これを作れません。
 */
export function proofFor(token: string, nonce: string): string {
  return createHmac('sha256', token).update(nonce).digest('hex');
}

/** 長さの違いで中身を推測されないよう、比較そのものも時間を一定に保ちます。 */
export function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

function isHex(value: unknown, length: number): boolean {
  return typeof value === 'string'
    && value.length === length
    && /^[0-9a-f]+$/i.test(value);
}

/**
 * Windowsの絶対パスであることの確認。UNCとネットワークパスは、必要がないので
 * 受け付けません。`\\?\` のような装飾も、実体の判別が難しくなるため断ります。
 */
export function isPlainAbsolutePath(value: string): boolean {
  if (!value || value.length > 32_767) return false;
  if (value.includes('\0')) return false;
  if (value.startsWith('\\\\') || value.startsWith('//')) return false;
  return path.win32.isAbsolute(value) && /^[a-z]:[\\/]/i.test(value);
}

/** 受け取った1行を、こちらが知っている形へ直します。 */
export function parseClientLine(line: string): BridgeResult<BridgeClientMessage> {
  if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
    return fail('1行が長すぎます');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail('JSONとして読めません');
  }
  if (!isRecord(parsed)) return fail('メッセージの形が違います');

  switch (parsed.type) {
    case 'hello':
      return parseHello(parsed);
    case 'submitTask':
      return parseSubmitTask(parsed);
    case 'cancelTask': {
      const taskId = readString(parsed, 'taskId');
      if (!taskId || taskId.length > 64) return fail('taskIdが不正です');
      return { ok: true, value: { type: 'cancelTask', taskId } };
    }
    default:
      return fail('知らない種別です');
  }
}

function parseHello(source: Record<string, unknown>): BridgeResult<BridgeHello> {
  const protocolVersion = source.protocolVersion;
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
    return fail('protocolVersionがありません');
  }
  if (!isHex(source.clientNonce, nonceHexLength)) return fail('clientNonceが不正です');
  const client = isRecord(source.client) ? source.client : {};
  return {
    ok: true,
    value: {
      type: 'hello',
      protocolVersion,
      clientNonce: source.clientNonce as string,
      client: {
        name: readString(client, 'name').slice(0, maxSourceLength),
        version: readString(client, 'version').slice(0, maxSourceLength),
      },
    },
  };
}

function parseSubmitTask(source: Record<string, unknown>): BridgeResult<BridgeSubmitTask> {
  const protocolVersion = source.protocolVersion;
  if (typeof protocolVersion !== 'number' || !Number.isInteger(protocolVersion)) {
    return fail('protocolVersionがありません');
  }
  const requestId = readString(source, 'requestId');
  if (!requestId || requestId.length > 64) return fail('requestIdが不正です');
  if (!isHex(source.clientProof, proofHexLength)) return fail('clientProofが不正です');
  const task = validateTaskShape(source.task);
  if (!task.ok) return fail(task.reason);
  return {
    ok: true,
    value: {
      type: 'submitTask',
      protocolVersion,
      requestId,
      clientProof: source.clientProof as string,
      task: task.value,
    },
  };
}

/**
 * ディスクを見ずに分かるところまでの確認。実ファイルの確認は `verifyTaskFiles`
 * が行います。分けてあるのは、形が違うだけの相手にファイル操作をさせないためです。
 */
export function validateTaskShape(value: unknown): BridgeResult<BridgeTaskPayload> {
  if (!isRecord(value)) return fail('taskがありません');

  const id = readString(value, 'id');
  if (!id || id.length > 64 || !/^[0-9a-z-]+$/i.test(id)) return fail('task.idが不正です');

  const instruction = readString(value, 'instruction').trim();
  if (!instruction) return fail('指示が空です');
  if (instruction.length > maxInstructionLength) return fail('指示が長すぎます');

  const imagePath = readString(value, 'imagePath');
  if (!isPlainAbsolutePath(imagePath)) return fail('画像の場所が絶対パスではありません');

  const workingDirectory = readString(value, 'workingDirectory');
  if (!isPlainAbsolutePath(workingDirectory)) return fail('作業フォルダが絶対パスではありません');

  const mode = readString(value, 'mode');
  if (mode !== 'Discuss' && mode !== 'Edit') return fail('モードが不正です');

  const source = readString(value, 'source').slice(0, maxSourceLength);
  if (!source) return fail('送信元がありません');

  const createdAtUtc = readString(value, 'createdAtUtc');
  if (!createdAtUtc || Number.isNaN(Date.parse(createdAtUtc))) return fail('作成日時が不正です');

  return {
    ok: true,
    value: { id, instruction, imagePath, workingDirectory, mode, source, createdAtUtc },
  };
}

export interface VerifiedTaskFiles {
  /** シンボリックリンクを解いた後の実際の場所。コピー元にはこちらを使います。 */
  imagePath: string;
  workingDirectory: string;
  imageBytes: number;
}

/**
 * 実ファイルの確認。拡張子ではなく先頭8バイトでPNGだと確かめます。名前だけを
 * 信じると、`.png` という名前の別物を読み込ませられるためです。
 */
export async function verifyTaskFiles(task: BridgeTaskPayload): Promise<BridgeResult<VerifiedTaskFiles>> {
  let imagePath: string;
  let workingDirectory: string;
  try {
    imagePath = await fs.realpath(task.imagePath);
  } catch {
    return fail('赤入れ画像が見つかりません');
  }
  try {
    workingDirectory = await fs.realpath(task.workingDirectory);
  } catch {
    return fail('作業フォルダが見つかりません');
  }
  // リンクの先が別の場所へ出ていることもあるので、解いた後にもう一度確かめます。
  if (!isPlainAbsolutePath(imagePath) || !isPlainAbsolutePath(workingDirectory)) {
    return fail('たどり着いた場所が受け付けられません');
  }

  const imageStats = await fs.stat(imagePath).catch(() => undefined);
  if (!imageStats || !imageStats.isFile()) return fail('赤入れ画像が通常のファイルではありません');
  if (imageStats.size > maxImageBytes) return fail('赤入れ画像が大きすぎます');
  if (imageStats.size <= pngSignature.length) return fail('赤入れ画像が壊れています');

  const workingStats = await fs.stat(workingDirectory).catch(() => undefined);
  if (!workingStats || !workingStats.isDirectory()) return fail('作業フォルダがフォルダではありません');

  const head = Buffer.alloc(pngSignature.length);
  const handle = await fs.open(imagePath, 'r').catch(() => undefined);
  if (!handle) return fail('赤入れ画像を開けません');
  try {
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!head.equals(pngSignature)) return fail('赤入れ画像がPNGではありません');

  return { ok: true, value: { imagePath, workingDirectory, imageBytes: imageStats.size } };
}

export function isSupportedVersion(version: number): boolean {
  return bridgeSupportedVersions.includes(version);
}

/**
 * ログへ出してよい形。指示の全文、画像の中身、利用者名を含む絶対パスは残しません。
 * 追えるだけの情報として、種別と長さだけを持たせます。
 */
export function describeForLog(message: BridgeClientMessage): string {
  switch (message.type) {
    case 'hello':
      return `hello v${message.protocolVersion}`;
    case 'submitTask':
      return `submitTask ${message.task.mode} 指示${message.task.instruction.length}文字`;
    case 'cancelTask':
      return 'cancelTask';
  }
}
