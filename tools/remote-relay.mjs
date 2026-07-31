import http from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

const host = process.env.PIXEL_CODEX_RELAY_HOST || '127.0.0.1';
const port = Number(process.env.PIXEL_CODEX_RELAY_PORT || 8787);
const token = process.env.PIXEL_CODEX_RELAY_TOKEN || '';

if (!token || token.length < 16) {
  throw new Error('PIXEL_CODEX_RELAY_TOKENに16文字以上の開発用トークンを設定してください');
}

const hosts = new Map();
const devices = new Map();

function send(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function reject(socket, reason) {
  send(socket, { version: 1, type: 'relay.error', createdAt: new Date().toISOString(), payload: { reason } });
  socket.close(1008, reason.slice(0, 120));
}

function register(socket, message) {
  const hostId = typeof message.hostId === 'string' ? message.hostId : '';
  if (!hostId) return false;
  if (message.type === 'host.hello') {
    socket.peer = { role: 'host', hostId };
    const previous = hosts.get(hostId);
    if (previous && previous !== socket) previous.close(1000, 'new host connection');
    hosts.set(hostId, socket);
    for (const device of devices.get(hostId) || []) {
      send(device, { version: 1, type: 'host.status', hostId, createdAt: new Date().toISOString(), payload: { online: true } });
    }
    return true;
  }
  if (message.type === 'device.hello') {
    socket.peer = { role: 'device', hostId };
    const members = devices.get(hostId) || new Set();
    members.add(socket);
    devices.set(hostId, members);
    send(socket, { version: 1, type: 'host.status', hostId, createdAt: new Date().toISOString(), payload: { online: hosts.has(hostId) } });
    return true;
  }
  return false;
}

function route(socket, raw) {
  if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) return;
  const text = raw.toString();
  if (Buffer.byteLength(text, 'utf8') > 16_384) return reject(socket, 'message too large');
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return reject(socket, 'invalid json');
  }
  if (!socket.peer) {
    if (!register(socket, message)) return reject(socket, 'hello required');
    return;
  }
  if (message.hostId !== socket.peer.hostId || message.version !== 1) {
    return reject(socket, 'routing boundary mismatch');
  }

  if (socket.peer.role === 'host') {
    for (const device of devices.get(socket.peer.hostId) || []) send(device, message);
  } else {
    const desktop = hosts.get(socket.peer.hostId);
    if (!desktop) {
      send(socket, { version: 1, type: 'host.status', hostId: socket.peer.hostId, createdAt: new Date().toISOString(), payload: { online: false } });
      return;
    }
    send(desktop, message);
  }
}

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, hosts: hosts.size }));
    return;
  }
  response.writeHead(404).end();
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/relay' || url.searchParams.get('token') !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit('connection', websocket);
  });
});

websocketServer.on('connection', (socket) => {
  socket.alive = true;
  socket.on('pong', () => { socket.alive = true; });
  socket.on('message', (data, isBinary) => {
    if (isBinary) return reject(socket, 'binary messages are not supported');
    route(socket, data);
  });
  socket.on('close', () => {
    if (!socket.peer) return;
    if (socket.peer.role === 'host') {
      if (hosts.get(socket.peer.hostId) === socket) hosts.delete(socket.peer.hostId);
      for (const device of devices.get(socket.peer.hostId) || []) {
        send(device, { version: 1, type: 'host.status', hostId: socket.peer.hostId, createdAt: new Date().toISOString(), payload: { online: false } });
      }
    } else {
      const members = devices.get(socket.peer.hostId);
      members?.delete(socket);
      if (!members?.size) devices.delete(socket.peer.hostId);
    }
  });
});

const heartbeat = setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (!socket.alive) {
      socket.terminate();
      continue;
    }
    socket.alive = false;
    socket.ping();
  }
}, 30_000);

server.listen(port, host, () => {
  process.stdout.write(`Pixel Codex development relay: ws://${host}:${port}/relay\n`);
});

function shutdown() {
  clearInterval(heartbeat);
  websocketServer.close();
  server.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
