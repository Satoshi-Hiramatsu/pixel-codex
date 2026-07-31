import assert from 'node:assert/strict';

import WebSocket from 'ws';

const relayUrl = process.env.PIXEL_CODEX_RELAY_URL
  || 'ws://127.0.0.1:8787/relay?token=pixel-codex-test-token-2026';
const hostId = '00000000-0000-4000-8000-000000000001';

function envelope(type, payload = {}) {
  return {
    version: 1,
    messageId: crypto.randomUUID(),
    type,
    hostId,
    createdAt: new Date().toISOString(),
    payload,
  };
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timer = setTimeout(() => reject(new Error('relay connection timeout')), 3_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function waitFor(socket, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`message timeout: ${type}`)), 3_000);
    const listener = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

const host = await openSocket();
host.send(JSON.stringify(envelope('host.hello', { platform: 'test' })));

const device = await openSocket();
device.send(JSON.stringify(envelope('device.hello', { deviceId: 'android-test' })));
await waitFor(device, 'host.status');

const instruction = envelope('instruction.submit', { deviceId: 'android-test', text: '回帰テストを実行してください' });
const receivedByHost = waitFor(host, 'instruction.submit');
device.send(JSON.stringify(instruction));
assert.equal((await receivedByHost).payload.text, instruction.payload.text);

const receivedByDevice = waitFor(device, 'command.acknowledged');
host.send(JSON.stringify(envelope('command.acknowledged', {
  messageId: instruction.messageId,
  outcome: 'queued',
  detail: '現在の作業が終わり次第実行します',
})));
assert.equal((await receivedByDevice).payload.outcome, 'queued');

host.close();
device.close();
process.stdout.write('remote relay integration: ok\n');
