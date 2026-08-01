export const remoteProtocolVersion = 1 as const;

export type RemoteGatewayPhase =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface RemoteGatewayStatus {
  phase: RemoteGatewayPhase;
  label: string;
  lastConnectedAt?: number;
  error?: string;
}

export interface RemoteHostInfo {
  hostId: string;
  status: RemoteGatewayStatus;
  /** 端末から見えるPCのアドレス。Wi-Fiが無いときは空になります。 */
  lanAddress: string;
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '10.0.2.2']);

/**
 * QRに載せられる宛先へ直します。ループバックはPC自身を指す値なので、そのまま
 * 端末へ渡すと端末自身へつなぎにいってしまいます。
 */
export function reachableRelayUrl(relayUrl: string, lanAddress: string): string {
  if (!relayUrl) return '';
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return '';
  }
  if (!loopbackHosts.has(url.hostname)) return url.toString();
  if (!lanAddress) return '';
  url.hostname = lanAddress;
  return url.toString();
}

export interface UsbTestSession {
  hostId: string;
  relayUrl: string;
  deviceSerial: string;
}

export interface WirelessTestSession extends UsbTestSession {
  androidRelayUrl: string;
  lanAddress: string;
}

/** ケーブルを一切使わないペアリング。PCがこの内容を画面に出し、端末で入力します。 */
export interface WirelessPairingSession {
  hostId: string;
  lanAddress: string;
  port: number;
  code: string;
  expiresAt: number;
  /** PC自身がRelayへつなぐためのURL。通信設定に保存して次回起動で再利用します。 */
  relayUrl: string;
}

/**
 * QRに埋め込む内容。読み取り精度を落とさないようキーは1文字にしています。
 * - lan … 同一Wi-Fi。端末はh:pへペアリングコードcを送ってトークンを受け取ります。
 * - url … 外部Relay。URLに認証情報が入っているので、そのまま接続できます。
 */
export type PairingQrPayload =
  | { v: 1; t: 'lan'; h: string; p: number; c: string }
  | { v: 1; t: 'url'; u: string; i: string };

export function lanPairingQr(session: WirelessPairingSession): string {
  return JSON.stringify({
    v: 1,
    t: 'lan',
    h: session.lanAddress,
    p: session.port,
    c: session.code,
  } satisfies PairingQrPayload);
}

export function urlPairingQr(relayUrl: string, hostId: string): string {
  return JSON.stringify({ v: 1, t: 'url', u: relayUrl, i: hostId } satisfies PairingQrPayload);
}

export type WirelessPairingPhase = 'open' | 'paired' | 'expired' | 'cancelled' | 'failed';

export interface WirelessPairingEvent {
  phase: WirelessPairingPhase;
  deviceName?: string;
  detail?: string;
}

export interface RemoteGatewayConfig {
  enabled: boolean;
  relayUrl: string;
  autoReconnect: boolean;
}

/** PCが出している承認待ちを、端末で判断できるだけの粒度に落としたもの。 */
export interface RemoteApprovalRequest {
  requestId: string;
  kind: 'command' | 'fileChange' | 'unknown';
  title: string;
  headline: string;
  bullets: string[];
  /** 機微情報を隠す設定のときは省きます。 */
  command?: string;
  cwd?: string;
  risk: 'low' | 'medium' | 'high';
  riskLabel: string;
}

export interface RemoteQuestionItem {
  id: string;
  header: string;
  question: string;
  options: string[];
}

export interface RemoteQuestionRequest {
  requestId: string;
  questions: RemoteQuestionItem[];
}

export type RemoteApprovalDecision = 'accept' | 'decline';

export interface RemoteApprovalResponse {
  messageId: string;
  deviceId?: string;
  requestId: string;
  decision: RemoteApprovalDecision;
  createdAt: number;
}

export interface RemoteQuestionResponse {
  messageId: string;
  deviceId?: string;
  requestId: string;
  answers: Record<string, string>;
  createdAt: number;
}

export interface RemoteStateSnapshot {
  workspace: string;
  connection: string;
  connectionLabel: string;
  rootThreadId?: string;
  rootStatus?: string;
  rootName?: string;
  busy: boolean;
  pendingInstructions: number;
  approvalPending: boolean;
  questionPending: boolean;
  /** 端末から可否を返せるようにした場合だけ中身が入ります。 */
  approval?: RemoteApprovalRequest;
  question?: RemoteQuestionRequest;
  latestMessage?: string;
  updatedAt: number;
}

export interface RemoteInstruction {
  messageId: string;
  deviceId?: string;
  text: string;
  createdAt: number;
}

export type RemotePreviewViewport = 'mobile' | 'desktop';

export type RemotePreviewSourceKind = 'url' | 'file' | 'window';

/** 端末が選べる撮影対象。選ぶための情報だけを送り、実体はPC側に残します。 */
export interface RemotePreviewSourceSummary {
  id: string;
  kind: RemotePreviewSourceKind;
  label: string;
}

export interface RemotePreviewSourcesRequest {
  messageId: string;
  deviceId?: string;
  createdAt: number;
}

export interface RemotePreviewRequest {
  messageId: string;
  deviceId?: string;
  sourceId: string;
  viewport: RemotePreviewViewport;
  createdAt: number;
}

/**
 * 撮った画像そのものはWebSocketに載せられません（16KB上限・テキストのみ）。
 * 端末にはここで受け取ったURLを別途HTTPで取りに行かせます。
 */
export interface RemotePreviewReady {
  messageId: string;
  previewId: string;
  /**
   * Relayからの相対パス。PCがどのアドレスで見えているかは端末しか知らず、端末は
   * 接続に使っているトークンをすでに持っているので、絶対URLは端末が組み立てます。
   */
  path: string;
  width: number;
  height: number;
  bytes: number;
  expiresAt: number;
  /** Drive連携が有効なときだけ入ります。LAN外から見るための控えです。 */
  driveUrl?: string;
}

export interface RemotePreviewFailed {
  messageId: string;
  reason: string;
}

export type RemoteInstructionOutcome = 'started' | 'queued' | 'rejected' | 'failed';

export interface RemoteInstructionResult {
  messageId: string;
  outcome: RemoteInstructionOutcome;
  detail: string;
  time: number;
}

export interface RemoteEnvelope<T = unknown> {
  version: typeof remoteProtocolVersion;
  messageId: string;
  type: string;
  hostId: string;
  createdAt: string;
  payload: T;
}

export function remoteEnvelope<T>(
  hostId: string,
  type: string,
  payload: T,
  messageId: string = crypto.randomUUID(),
): RemoteEnvelope<T> {
  return {
    version: remoteProtocolVersion,
    messageId,
    type,
    hostId,
    createdAt: new Date().toISOString(),
    payload,
  };
}
