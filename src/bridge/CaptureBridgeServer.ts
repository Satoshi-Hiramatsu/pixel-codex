import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

import { pipeAddress, type BridgeIdentity } from './bridgeIdentity';
import {
  bridgeProtocolVersion,
  bridgeSupportedVersions,
  describeForLog,
  encodeMessage,
  isSupportedVersion,
  maxLineBytes,
  maxPendingTasks,
  parseClientLine,
  proofFor,
  proofMatches,
  randomNonce,
  verifyTaskFiles,
  type BridgeServerMessage,
  type BridgeTaskMode,
  type BridgeTaskPayload,
  type BridgeTaskPhase,
} from './CaptureBridgeProtocol';

/** 名乗りを終えるまでの猶予。黙って占有し続ける相手を居座らせないための上限です。 */
const handshakeTimeoutMs = 10_000;

/** Pixel Codexが預かった赤入れ1件。画像はすでにこちらの管理下へ写してあります。 */
export interface BridgeInboxTask {
  taskId: string;
  instruction: string;
  /** Pixel Codexの一時領域にあるコピー。元の場所ではありません。 */
  imagePath: string;
  workingDirectory: string;
  mode: BridgeTaskMode;
  source: string;
  receivedAt: number;
}

export type BridgeServerPhase = 'stopped' | 'listening' | 'error';

export interface BridgeServerStatus {
  phase: BridgeServerPhase;
  label: string;
  connected: boolean;
}

interface Connection {
  socket: net.Socket;
  buffer: string;
  /** 名乗りが済んだ相手にだけ、この値と一致する証明を求めます。 */
  expectedClientProof?: string;
  authenticated: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 赤ペン先生からの赤入れを受け取る窓口。
 *
 * ここが返す `accepted` は「JSONを読んだ」ではなく「画像をPixel Codexの管理下へ
 * 写し終えた」という意味です。赤ペン先生は、これを受け取るまで元の画像を消しません。
 * 受け取っただけではCodexを動かしません。動かすのは利用者が画面で送ったときです。
 */
export class CaptureBridgeServer extends EventEmitter {
  private server?: net.Server;
  private connection?: Connection;
  private status: BridgeServerStatus = { phase: 'stopped', label: '受け取り停止中', connected: false };
  /** 預かった画像の置き場所。`accepted` を返した後の後始末に使います。 */
  private readonly held = new Map<string, string>();
  private readonly identity: BridgeIdentity;
  private readonly appVersion: string;
  private readonly inboxRoot: string;

  // 引数からそのまま項目を作る書き方（パラメータープロパティ）は使いません。
  // 検証スクリプトがこの一枚をNodeで直接読み込むためです。
  constructor(identity: BridgeIdentity, appVersion: string, inboxRoot: string) {
    super();
    this.identity = identity;
    this.appVersion = appVersion;
    this.inboxRoot = inboxRoot;
  }

  getStatus(): BridgeServerStatus {
    return { ...this.status };
  }

  get pendingCount(): number {
    return this.held.size;
  }

  async start(): Promise<BridgeServerStatus> {
    if (this.server) return this.getStatus();
    await fs.mkdir(this.inboxRoot, { recursive: true });

    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    server.on('error', (error) => {
      this.server = undefined;
      this.setStatus({
        phase: 'error',
        label: '受け取り口を開けませんでした',
        connected: false,
      });
      this.emit('log', `bridge listen failed: ${error.message}`);
    });

    await new Promise<void>((resolve) => {
      server.listen(pipeAddress(this.identity), () => resolve());
      server.once('error', () => resolve());
    });

    if (this.server) {
      this.setStatus({ phase: 'listening', label: '赤ペン先生からの受け取り待ち', connected: false });
    }
    return this.getStatus();
  }

  stop(): void {
    this.closeConnection();
    const server = this.server;
    this.server = undefined;
    server?.close();
    this.setStatus({ phase: 'stopped', label: '受け取り停止中', connected: false });
  }

  /** 画面の状況を赤ペン先生へ短く伝えます。会話の中身は流しません。 */
  sendStatus(taskId: string, phase: BridgeTaskPhase, detail: string): void {
    if (!this.held.has(taskId)) return;
    this.write({ type: 'status', taskId, phase, detail });
  }

  sendCompleted(taskId: string, summary?: string): void {
    if (!this.held.has(taskId)) return;
    this.write({ type: 'completed', taskId, summary });
    void this.release(taskId);
  }

  sendFailed(taskId: string, reason: string): void {
    if (!this.held.has(taskId)) return;
    this.write({ type: 'failed', taskId, reason });
    void this.release(taskId);
  }

  /** 預かった画像を捨てます。完了、破棄、終了のいずれでも通り道はここ1本です。 */
  async release(taskId: string): Promise<void> {
    const filePath = this.held.get(taskId);
    if (!filePath) return;
    this.held.delete(taskId);
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }

  async releaseAll(): Promise<void> {
    this.held.clear();
    await fs.rm(this.inboxRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  private setStatus(status: BridgeServerStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }

  /**
   * 同時に相手をするのは1本だけにします。赤入れは人が1枚ずつ描いて送るものなので、
   * 並列に開かせても得るものがなく、状態だけが増えるためです。
   */
  private accept(socket: net.Socket): void {
    // 相手をするのは1本だけですが、新しく来たほうを通します。赤ペン先生が落ちて
    // 立ち上げ直した場合、前の接続が切れたとこちらが気づくのは少し後になるため、
    // 古いほうを優先すると、しばらく誰もつなげない時間ができてしまいます。
    // 同じ利用者しかここへ辿り着けないので、割り込みを警戒する必要もありません。
    // 受け渡しの途中だった場合は `handleSubmit` が写しを捨て、赤入れは赤ペン先生の
    // 持ち物のまま残ります。
    if (this.connection) this.closeConnection();
    socket.setEncoding('utf8');
    const connection: Connection = { socket, buffer: '', authenticated: false };
    connection.timer = setTimeout(() => {
      if (!connection.authenticated) this.closeConnection();
    }, handshakeTimeoutMs);
    this.connection = connection;
    this.setStatus({ ...this.status, connected: true });

    socket.on('data', (chunk: string) => this.receive(connection, chunk));
    socket.on('error', () => this.closeConnection());
    socket.on('close', () => {
      if (this.connection === connection) {
        this.connection = undefined;
        clearTimeout(connection.timer);
        this.setStatus({ ...this.status, connected: false });
      }
    });
  }

  private closeConnection(): void {
    const connection = this.connection;
    if (!connection) return;
    clearTimeout(connection.timer);
    connection.socket.destroy();
    this.connection = undefined;
    this.setStatus({ ...this.status, connected: false });
  }

  /**
   * 断る理由を伝えてから閉じます。`destroy` は書き込み待ちの内容ごと捨てるため、
   * 直前に書いた理由が相手へ届きません。理由の分からない切断は、赤ペン先生側で
   * 「Pixel Codexが黙って落ちた」と見えてしまいます。
   */
  private endConnection(): void {
    const connection = this.connection;
    if (!connection) return;
    clearTimeout(connection.timer);
    this.connection = undefined;
    this.setStatus({ ...this.status, connected: false });
    connection.socket.end();
  }

  private receive(connection: Connection, chunk: string): void {
    if (this.connection !== connection) return;
    connection.buffer += chunk;
    // 改行が来ないまま膨らみ続ける相手は、こちらの領域を食い潰すだけなので切ります。
    if (Buffer.byteLength(connection.buffer, 'utf8') > maxLineBytes) {
      this.emit('log', 'bridge input exceeded the line limit');
      this.closeConnection();
      return;
    }

    let newline = connection.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = connection.buffer.slice(0, newline).trim();
      connection.buffer = connection.buffer.slice(newline + 1);
      if (line) void this.handleLine(connection, line);
      if (this.connection !== connection) return;
      newline = connection.buffer.indexOf('\n');
    }
  }

  private async handleLine(connection: Connection, line: string): Promise<void> {
    const parsed = parseClientLine(line);
    if (!parsed.ok) {
      this.emit('log', `bridge rejected a message: ${parsed.reason}`);
      this.write({ type: 'failed', reason: parsed.reason });
      return;
    }
    this.emit('log', `bridge received ${describeForLog(parsed.value)}`);
    const message = parsed.value;

    if (message.type === 'hello') {
      this.handleHello(connection, message.protocolVersion, message.clientNonce);
      return;
    }

    if (!connection.authenticated) {
      this.write({ type: 'failed', reason: '先にhelloを送ってください' });
      this.endConnection();
      return;
    }

    if (message.type === 'cancelTask') {
      this.emit('cancel', message.taskId);
      await this.release(message.taskId);
      return;
    }

    await this.handleSubmit(connection, message.requestId, message.clientProof, message.task);
  }

  private handleHello(connection: Connection, version: number, clientNonce: string): void {
    if (!isSupportedVersion(version)) {
      this.write({
        type: 'helloResult',
        protocolVersion: bridgeProtocolVersion,
        accepted: false,
        app: { name: 'Pixel Codex', version: this.appVersion },
        supported: bridgeSupportedVersions,
        reason: '対応していない版です',
      });
      this.endConnection();
      return;
    }

    // 先にこちらが合言葉を知っていることを示します。順番が逆だと、パイプ名を
    // 先取りした偽のサーバーへ赤ペン先生が指示と画像の場所を渡してしまいます。
    const serverNonce = randomNonce();
    connection.expectedClientProof = proofFor(this.identity.token, serverNonce);
    connection.authenticated = true;
    clearTimeout(connection.timer);

    this.write({
      type: 'helloResult',
      protocolVersion: bridgeProtocolVersion,
      accepted: true,
      app: { name: 'Pixel Codex', version: this.appVersion },
      serverProof: proofFor(this.identity.token, clientNonce),
      serverNonce,
    });
  }

  private async handleSubmit(
    connection: Connection,
    requestId: string,
    clientProof: string,
    task: BridgeTaskPayload,
  ): Promise<void> {
    if (!connection.expectedClientProof || !proofMatches(connection.expectedClientProof, clientProof)) {
      this.write({ type: 'failed', requestId, reason: '合言葉が一致しません' });
      this.endConnection();
      return;
    }
    if (this.held.size >= maxPendingTasks) {
      this.write({ type: 'failed', requestId, reason: '確認待ちが多すぎます。Pixel Codexで処理してください' });
      return;
    }

    const verified = await verifyTaskFiles(task);
    if (!verified.ok) {
      this.write({ type: 'failed', requestId, reason: verified.reason });
      return;
    }

    // ここから先が所有権の移り目。写し終えるまでは `accepted` を返しません。
    const taskId = randomUUID();
    const copied = path.join(this.inboxRoot, `${taskId}.png`);
    try {
      await fs.mkdir(this.inboxRoot, { recursive: true });
      await fs.copyFile(verified.value.imagePath, copied);
    } catch {
      await fs.rm(copied, { force: true }).catch(() => undefined);
      this.write({ type: 'failed', requestId, reason: '赤入れ画像を預かれませんでした' });
      return;
    }

    // 写している間に相手が消えていることがあります。その場合は預からず、
    // 元の画像は赤ペン先生の持ち物のままにしておきます。
    if (this.connection !== connection || connection.socket.destroyed) {
      await fs.rm(copied, { force: true }).catch(() => undefined);
      return;
    }

    this.held.set(taskId, copied);
    this.write({ type: 'accepted', requestId, taskId });

    const inbox: BridgeInboxTask = {
      taskId,
      instruction: task.instruction,
      imagePath: copied,
      workingDirectory: verified.value.workingDirectory,
      mode: task.mode,
      source: task.source,
      receivedAt: Date.now(),
    };
    this.emit('task', inbox);
    this.write({ type: 'status', taskId, phase: 'pending', detail: 'Pixel Codexで確認を待っています' });
  }

  private write(message: BridgeServerMessage): void {
    const socket = this.connection?.socket;
    if (!socket || socket.destroyed) return;
    socket.write(encodeMessage(message));
  }
}
