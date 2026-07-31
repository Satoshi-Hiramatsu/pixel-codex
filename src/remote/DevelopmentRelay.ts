import { randomUUID } from 'node:crypto';
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
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

export class DevelopmentRelay {
  private server?: http.Server;
  private websocketServer?: WebSocketServer;
  private info?: DevelopmentRelayInfo;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly hosts = new Map<string, RelaySocket>();
  private readonly devices = new Map<string, Set<RelaySocket>>();

  async start(): Promise<DevelopmentRelayInfo> {
    if (this.info) return this.info;
    const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    const server = http.createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, hosts: this.hosts.size }));
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

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('USBテストRelayを開始できませんでした');

    this.server = server;
    this.websocketServer = websocketServer;
    this.info = {
      port: address.port,
      token,
      relayUrl: `ws://127.0.0.1:${address.port}/relay?token=${token}`,
    };
    this.heartbeat = setInterval(() => this.ping(), 30_000);
    return this.info;
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
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
