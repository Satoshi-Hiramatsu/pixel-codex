import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';

import WebSocket, { type RawData, WebSocketServer } from 'ws';

interface RelayPeer {
  role: 'host' | 'device';
  hostId: string;
}

interface RelaySocket extends WebSocket {
  alive: boolean;
  peer?: RelayPeer;
}

export interface DevelopmentRelayInfo {
  port: number;
  token: string;
  relayUrl: string;
  bindHost: string;
}

export interface DevelopmentRelayOptions {
  bindHost?: string;
  /** 保存済みトークン。渡さないと毎回作り直しになり、端末の再ペアリングが必要になります。 */
  token?: string;
  /** 最初に試すポート。使用中なら +9 まで順に探します。 */
  preferredPort?: number;
  /** `/health` で名乗るPCの身元。端末がLAN内からPCを探し直すのに使います。 */
  hostId?: string;
}

export type PairingPhase = 'open' | 'paired' | 'expired' | 'cancelled' | 'failed';

export interface PairingEvent {
  phase: PairingPhase;
  deviceName?: string;
  detail?: string;
}

export interface PairingTicket {
  code: string;
  expiresAt: number;
}

interface PairingWindow {
  code: string;
  hostId: string;
  expiresAt: number;
  attemptsLeft: number;
  timer: ReturnType<typeof setTimeout>;
}

/** 6桁コードの総当たりを防ぐ回数。使い切るとその場でペアリングを閉じます。 */
const maxPairingAttempts = 5;
const portScanRange = 10;
const previewPathPrefix = '/preview/';
/** 端末が取りに来ないまま溜まらないよう、この枚数を超えたら古いものから捨てます。 */
const maxPublishedPreviews = 12;

/**
 * 撮影した画像の置き場。WebSocketは16KB上限かつテキストのみなので、画像は
 * このHTTP側で渡します。ここに載せたidだけが配信対象で、リクエストに入っていた
 * 文字列からファイルの場所を組み立てることはありません。
 */
interface PublishedPreview {
  filePath: string;
  mimeType: string;
  expiresAt: number;
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

/**
 * 開発用のRelay。ポートとトークンを呼び出し側から渡せるので、一度ペアリングした
 * Android端末はPCを再起動しても同じ宛先へつなぎ直せます。
 */
export class DevelopmentRelay extends EventEmitter {
  private server?: http.Server;
  private websocketServer?: WebSocketServer;
  private info?: DevelopmentRelayInfo;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pairing?: PairingWindow;
  private readonly hosts = new Map<string, RelaySocket>();
  private readonly devices = new Map<string, Set<RelaySocket>>();
  private readonly previews = new Map<string, PublishedPreview>();

  async start(options: DevelopmentRelayOptions = {}): Promise<DevelopmentRelayInfo> {
    const bindHost = options.bindHost ?? '127.0.0.1';
    if (this.info && this.info.bindHost === bindHost) {
      if (!options.token || options.token === this.info.token) return this.info;
    }
    if (this.info) this.stop();
    const token = options.token || `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        // hostIdは宛先の識別子で、接続にはトークンが要ります。名乗っても接続はできません。
        response.end(JSON.stringify({
          ok: true,
          hosts: this.hosts.size,
          pairing: Boolean(this.pairing),
          hostId: options.hostId ?? '',
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/pair') {
        this.handlePairRequest(request, response);
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith(previewPathPrefix)) {
        this.handlePreviewRequest(request, response, token);
        return;
      }
      response.writeHead(404).end();
    });
    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16_384 });

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== '/relay' || url.searchParams.get('token') !== token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket);
      });
    });
    websocketServer.on('connection', (websocket) => this.accept(websocket as RelaySocket));

    const port = await this.listen(server, bindHost, options.preferredPort);

    this.server = server;
    this.websocketServer = websocketServer;
    this.info = {
      port,
      token,
      relayUrl: `ws://127.0.0.1:${port}/relay?token=${token}`,
      bindHost,
    };
    this.heartbeat = setInterval(() => this.ping(), 30_000);
    return this.info;
  }

  /**
   * 希望のポートから順に空きを探します。固定ポートで待てると、端末が保存した
   * 宛先をそのまま再利用できます。全部埋まっていたらOSに任せます。
   */
  private async listen(server: http.Server, bindHost: string, preferredPort?: number): Promise<number> {
    const candidates = preferredPort
      ? Array.from({ length: portScanRange }, (_unused, index) => preferredPort + index).concat(0)
      : [0];
    for (const candidate of candidates) {
      const bound = await new Promise<boolean>((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off('listening', onListening);
          if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
          else reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(true);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, bindHost);
      });
      if (!bound) continue;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('開発用Relayを開始できませんでした');
      return address.port;
    }
    throw new Error('開発用Relayに使える空きポートが見つかりませんでした');
  }

  /**
   * 端末に見せる6桁コードを発行します。期限切れか規定回数の失敗で自動的に閉じます。
   */
  openPairing(hostId: string, ttlMs = 180_000): PairingTicket {
    if (!this.info) throw new Error('Relayが起動していません');
    this.closePairing('cancelled');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = Date.now() + ttlMs;
    this.pairing = {
      code,
      hostId,
      expiresAt,
      attemptsLeft: maxPairingAttempts,
      timer: setTimeout(() => this.closePairing('expired'), ttlMs),
    };
    this.emit('pairing', { phase: 'open' } satisfies PairingEvent);
    return { code, expiresAt };
  }

  cancelPairing(): void {
    this.closePairing('cancelled');
  }

  private closePairing(phase: PairingPhase, deviceName?: string, detail?: string): void {
    const pairing = this.pairing;
    this.pairing = undefined;
    if (!pairing) return;
    clearTimeout(pairing.timer);
    this.emit('pairing', { phase, deviceName, detail } satisfies PairingEvent);
  }

  private handlePairRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const reply = (status: number, body: Record<string, unknown>): void => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2_048) {
        reply(413, { error: 'request too large' });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!response.writable || response.writableEnded) return;
      const pairing = this.pairing;
      const relay = this.info;
      if (!pairing || !relay) {
        reply(409, { error: 'PC側でペアリングが開始されていません' });
        return;
      }
      if (Date.now() > pairing.expiresAt) {
        this.closePairing('expired');
        reply(410, { error: 'ペアリングの有効期限が切れました' });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        reply(400, { error: 'invalid json' });
        return;
      }
      const provided = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : '';
      if (!secretMatches(pairing.code, provided)) {
        pairing.attemptsLeft -= 1;
        if (pairing.attemptsLeft <= 0) {
          this.closePairing('failed', undefined, 'コードを規定回数まちがえたため中止しました');
          reply(429, { error: 'コードの入力回数が上限に達しました' });
          return;
        }
        reply(403, { error: 'ペアリングコードが違います', attemptsLeft: pairing.attemptsLeft });
        return;
      }
      const deviceName = typeof body.deviceName === 'string'
        ? body.deviceName.replace(/[\r\n]/g, '').slice(0, 64)
        : '';
      const authority = requestAuthority(request, relay.port);
      reply(200, {
        token: relay.token,
        hostId: pairing.hostId,
        relayUrl: `ws://${authority}/relay?token=${relay.token}`,
      });
      this.closePairing('paired', deviceName || 'Android端末');
    });
  }

  /**
   * 撮った画像を取りに来られる状態にします。宛先は推測できないidで、期限を過ぎたら
   * 実ファイルごと消します。
   *
   * 返すのはパスだけです。PCがどのアドレスで見えているかは端末側しか知らないうえ、
   * 端末は接続に使っているRelayトークンをすでに持っているので、絶対URLの組み立ては
   * 端末に任せたほうが確実で、トークンをメッセージへ二重に載せずに済みます。
   */
  publishPreview(filePath: string, mimeType: string, ttlMs: number): {
    previewId: string;
    path: string;
    expiresAt: number;
  } {
    if (!this.info) throw new Error('Relayが起動していません');
    this.sweepPreviews();
    while (this.previews.size >= maxPublishedPreviews) {
      const oldest = this.previews.keys().next().value as string | undefined;
      if (!oldest) break;
      this.discardPreview(oldest);
    }
    const previewId = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.previews.set(previewId, { filePath, mimeType, expiresAt });
    return { previewId, path: `${previewPathPrefix}${previewId}`, expiresAt };
  }

  private discardPreview(previewId: string): void {
    const preview = this.previews.get(previewId);
    if (!preview) return;
    this.previews.delete(previewId);
    void fs.rm(preview.filePath, { force: true }).catch(() => undefined);
  }

  private sweepPreviews(): void {
    const now = Date.now();
    for (const [previewId, preview] of this.previews) {
      if (preview.expiresAt <= now) this.discardPreview(previewId);
    }
  }

  private handlePreviewRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    token: string,
  ): void {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (!secretMatches(token, url.searchParams.get('token') ?? '')) {
      response.writeHead(401).end();
      return;
    }
    const previewId = decodeURIComponent(url.pathname.slice(previewPathPrefix.length));
    const preview = this.previews.get(previewId);
    if (!preview || preview.expiresAt <= Date.now()) {
      if (preview) this.discardPreview(previewId);
      response.writeHead(404).end();
      return;
    }
    fs.readFile(preview.filePath).then((data) => {
      response.writeHead(200, {
        'content-type': preview.mimeType,
        'content-length': String(data.length),
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      response.end(data);
    }).catch(() => {
      this.discardPreview(previewId);
      if (!response.writableEnded) response.writeHead(404).end();
    });
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const previewId of [...this.previews.keys()]) this.discardPreview(previewId);
    this.closePairing('cancelled');
    for (const socket of this.websocketServer?.clients ?? []) socket.terminate();
    this.websocketServer?.close();
    this.server?.close();
    this.websocketServer = undefined;
    this.server = undefined;
    this.info = undefined;
    this.hosts.clear();
    this.devices.clear();
  }

  private accept(socket: RelaySocket): void {
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1008, 'binary messages are not supported');
        return;
      }
      this.route(socket, data);
    });
    socket.on('close', () => this.remove(socket));
  }

  private route(socket: RelaySocket, raw: RawData): void {
    const text = raw.toString();
    if (Buffer.byteLength(text, 'utf8') > 16_384) {
      socket.close(1009, 'message too large');
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      socket.close(1008, 'invalid json');
      return;
    }

    if (!socket.peer) {
      if (!this.register(socket, message)) socket.close(1008, 'hello required');
      return;
    }
    if (message.version !== 1 || message.hostId !== socket.peer.hostId) {
      socket.close(1008, 'routing boundary mismatch');
      return;
    }
    if (socket.peer.role === 'host') {
      for (const device of this.devices.get(socket.peer.hostId) ?? []) send(device, message);
      return;
    }
    const host = this.hosts.get(socket.peer.hostId);
    if (host) send(host, message);
    else this.sendHostStatus(socket, socket.peer.hostId, false);
  }

  private register(socket: RelaySocket, message: Record<string, unknown>): boolean {
    const hostId = typeof message.hostId === 'string' ? message.hostId : '';
    if (!hostId || message.version !== 1) return false;
    if (message.type === 'host.hello') {
      socket.peer = { role: 'host', hostId };
      const previous = this.hosts.get(hostId);
      if (previous && previous !== socket) previous.close(1000, 'new host connection');
      this.hosts.set(hostId, socket);
      for (const device of this.devices.get(hostId) ?? []) this.sendHostStatus(device, hostId, true);
      return true;
    }
    if (message.type === 'device.hello') {
      socket.peer = { role: 'device', hostId };
      const members = this.devices.get(hostId) ?? new Set<RelaySocket>();
      members.add(socket);
      this.devices.set(hostId, members);
      this.sendHostStatus(socket, hostId, this.hosts.has(hostId));
      return true;
    }
    return false;
  }

  private remove(socket: RelaySocket): void {
    if (!socket.peer) return;
    const { hostId, role } = socket.peer;
    if (role === 'host') {
      if (this.hosts.get(hostId) === socket) this.hosts.delete(hostId);
      for (const device of this.devices.get(hostId) ?? []) this.sendHostStatus(device, hostId, false);
      return;
    }
    const members = this.devices.get(hostId);
    members?.delete(socket);
    if (!members?.size) this.devices.delete(hostId);
  }

  private sendHostStatus(socket: WebSocket, hostId: string, online: boolean): void {
    send(socket, {
      version: 1,
      type: 'host.status',
      hostId,
      createdAt: new Date().toISOString(),
      payload: { online },
    });
  }

  private ping(): void {
    this.sweepPreviews();
    for (const websocket of this.websocketServer?.clients ?? []) {
      const socket = websocket as RelaySocket;
      if (!socket.alive) {
        socket.terminate();
        continue;
      }
      socket.alive = false;
      socket.ping();
    }
  }
}

/** 桁数の違いで早く返らないよう、長さを揃えてから比べます。 */
function secretMatches(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  // クエリ文字列から任意の値が来ても、長さ違いでtimingSafeEqualが例外を投げないようにします。
  if (provided.length !== expected.length) return false;
  if (Buffer.byteLength(provided, 'utf8') !== expectedBuffer.length) return false;
  const paddedProvided = provided.padEnd(expected.length, ' ').slice(0, expected.length);
  const matched = timingSafeEqual(expectedBuffer, Buffer.from(paddedProvided, 'utf8'));
  return matched && provided.length === expected.length;
}

/**
 * 端末が実際に叩いてきた宛先。ここからws://を組み立てると、PCが複数の
 * ネットワークにつながっていても端末から見える方のアドレスを返せます。
 */
function requestAuthority(request: http.IncomingMessage, fallbackPort: number): string {
  const header = request.headers.host ?? '';
  if (/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(header)) {
    return header.includes(':') ? header : `${header}:${fallbackPort}`;
  }
  const local = request.socket.localAddress ?? '127.0.0.1';
  return `${local}:${request.socket.localPort ?? fallbackPort}`;
}
