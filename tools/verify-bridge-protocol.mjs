import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  bridgeProtocolVersion,
  encodeMessage,
  isPlainAbsolutePath,
  isSupportedVersion,
  maxInstructionLength,
  maxLineBytes,
  parseClientLine,
  proofFor,
  proofMatches,
  randomNonce,
  validateTaskShape,
  verifyTaskFiles,
} from '../src/bridge/CaptureBridgeProtocol.ts';
import { loadBridgeIdentity, pipeAddress } from '../src/bridge/bridgeIdentity.ts';
import { CaptureBridgeServer } from '../src/bridge/CaptureBridgeServer.ts';

/**
 * Pixel Codex Bridgeの取り決めを固定する検証。C#側の
 * `gInk/tests/ExternalTaskProtocolTests.cs` と対になっており、両方が同じ入力を
 * 同じように断ることを確かめている。
 *
 * テスト用の依存を増やさないため、Node同梱のassertとTypeScriptの直接読み込み
 * （Node 22以降の型除去）だけで動かしている。
 */

const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const results = [];

async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`  OK   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixel-codex-bridge-test-'));
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace, { recursive: true });

async function writePng(name) {
  const target = path.join(root, name);
  await fs.writeFile(target, Buffer.concat([pngHead, Buffer.alloc(16)]));
  return target;
}

async function writeFake(name) {
  const target = path.join(root, name);
  // 拡張子だけPNGにした別物。名前を信じると読み込ませられてしまう。
  await fs.writeFile(target, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]));
  return target;
}

function taskFor(imagePath, patch = {}) {
  return {
    id: randomUUID().replace(/-/g, ''),
    instruction: 'ここを直してください',
    imagePath,
    workingDirectory: workspace,
    mode: 'Edit',
    source: 'akapen-sensei',
    createdAtUtc: new Date().toISOString(),
    ...patch,
  };
}

const realPng = await writePng('real.png');
const fakePng = await writeFake('fake.png');

console.log('Pixel Codex Bridge プロトコル検証');
console.log();

await check('合言葉の証明はトークンとnonceの両方で変わる', () => {
  const a = proofFor('token-a', 'nonce');
  assert.equal(a.length, 64);
  assert.notEqual(a, proofFor('token-b', 'nonce'));
  assert.notEqual(a, proofFor('token-a', 'other'));
  assert.ok(proofMatches(a, proofFor('token-a', 'nonce')));
});

await check('合言葉の照合は長さ違いを弾く', () => {
  const proof = proofFor('token', 'nonce');
  assert.equal(proofMatches(proof, proof.slice(1)), false);
  assert.equal(proofMatches(proof, undefined), false);
  assert.equal(proofMatches(proof, `${proof}0`), false);
});

await check('C#と同じ材料から同じ証明が出る', () => {
  // 片方だけ実装を変えると接続できなくなるので、計算そのものを固定する。
  const expected = createHmac('sha256', 'token').update('nonce').digest('hex');
  assert.equal(proofFor('token', 'nonce'), expected);
});

await check('nonceは毎回変わる', () => {
  const first = randomNonce();
  assert.equal(first.length, 32);
  assert.notEqual(first, randomNonce());
});

await check('UNCとネットワークパスを弾く', () => {
  assert.equal(isPlainAbsolutePath('\\\\server\\share\\a.png'), false);
  assert.equal(isPlainAbsolutePath('//server/share/a.png'), false);
  assert.equal(isPlainAbsolutePath('\\\\?\\C:\\a.png'), false);
});

await check('相対パスと空文字を弾く', () => {
  assert.equal(isPlainAbsolutePath(''), false);
  assert.equal(isPlainAbsolutePath('docs\\a.png'), false);
  assert.equal(isPlainAbsolutePath('C:a.png'), false);
  assert.equal(isPlainAbsolutePath('C:\\a\0.png'), false);
  assert.equal(isPlainAbsolutePath('C:\\work\\a.png'), true);
});

await check('形の検証は各項目を個別に断る', () => {
  assert.equal(validateTaskShape(taskFor(realPng)).ok, true);
  assert.equal(validateTaskShape(taskFor(realPng, { instruction: '   ' })).ok, false);
  assert.equal(
    validateTaskShape(taskFor(realPng, { instruction: 'あ'.repeat(maxInstructionLength + 1) })).ok,
    false,
  );
  assert.equal(validateTaskShape(taskFor(realPng, { mode: 'Delete' })).ok, false);
  assert.equal(validateTaskShape(taskFor(realPng, { source: '' })).ok, false);
  assert.equal(validateTaskShape(taskFor(realPng, { createdAtUtc: 'いつか' })).ok, false);
  assert.equal(validateTaskShape(taskFor('docs\\a.png')).ok, false);
  assert.equal(validateTaskShape(taskFor(realPng, { workingDirectory: 'rel' })).ok, false);
});

await check('PNGでない画像を弾く', async () => {
  const verified = await verifyTaskFiles(taskFor(fakePng));
  assert.equal(verified.ok, false);
  assert.match(verified.reason, /PNG/);
});

await check('PNGの署名を持つファイルは通す', async () => {
  const verified = await verifyTaskFiles(taskFor(realPng));
  assert.equal(verified.ok, true);
  assert.equal(verified.value.imageBytes, pngHead.length + 16);
});

await check('存在しない画像とフォルダを弾く', async () => {
  const missing = await verifyTaskFiles(taskFor(path.join(root, 'nope.png')));
  assert.equal(missing.ok, false);
  const badDir = await verifyTaskFiles(
    taskFor(realPng, { workingDirectory: path.join(root, 'nope') }),
  );
  assert.equal(badDir.ok, false);
});

await check('フォルダを画像として渡せない', async () => {
  const verified = await verifyTaskFiles(taskFor(workspace));
  assert.equal(verified.ok, false);
});

await check('壊れたJSONを弾く', () => {
  const parsed = parseClientLine('{"type":"hello"');
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /JSON/);
});

await check('知らない種別を弾く', () => {
  assert.equal(parseClientLine('{"type":"whatever"}').ok, false);
});

await check('長すぎる1行を弾く', () => {
  const huge = JSON.stringify({ type: 'cancelTask', taskId: 'x'.repeat(maxLineBytes) });
  const parsed = parseClientLine(huge);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /長すぎ/);
});

await check('helloはnonceの形を確かめる', () => {
  const good = parseClientLine(JSON.stringify({
    type: 'hello',
    protocolVersion: bridgeProtocolVersion,
    clientNonce: randomNonce(),
    client: { name: 'akapen-sensei', version: '1.4.4' },
  }));
  assert.equal(good.ok, true);
  const bad = parseClientLine(JSON.stringify({
    type: 'hello',
    protocolVersion: bridgeProtocolVersion,
    clientNonce: 'short',
  }));
  assert.equal(bad.ok, false);
});

await check('submitTaskは証明の形を確かめる', () => {
  const parsed = parseClientLine(JSON.stringify({
    type: 'submitTask',
    protocolVersion: bridgeProtocolVersion,
    requestId: 'r1',
    clientProof: 'not-a-proof',
    task: taskFor(realPng),
  }));
  assert.equal(parsed.ok, false);
});

await check('版数の対応可否を判定できる', () => {
  assert.equal(isSupportedVersion(bridgeProtocolVersion), true);
  assert.equal(isSupportedVersion(bridgeProtocolVersion + 1), false);
});

/*
  ここからは実際にパイプを開いて往復させる。名乗り、版不一致、合言葉違い、
  受領と画像の写し、そして受領前に切った場合の扱いを確かめる。
*/
const identityRoot = path.join(root, 'userData');
const identity = await loadBridgeIdentity(identityRoot);
const inboxRoot = path.join(root, 'inbox');
const server = new CaptureBridgeServer(identity, '0.0.0-test', inboxRoot);
const arrived = [];
server.on('task', (task) => arrived.push(task));
await server.start();

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeAddress(identity));
    socket.setEncoding('utf8');
    const timer = setTimeout(() => reject(new Error('connect timeout')), 3_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/**
 * 行を1本ずつ読む口。`accepted` と `status` のように続けて届くことがあるため、
 * 呼び出しごとに新しく待つのではなく、1本の受け皿に溜めてから切り出す。
 */
function lineReader(socket) {
  let buffer = '';
  const queue = [];
  const waiting = [];
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        const next = waiting.shift();
        if (next) next.resolve(parsed);
        else queue.push(parsed);
      }
      newline = buffer.indexOf('\n');
    }
  });
  return () => new Promise((resolve, reject) => {
    const ready = queue.shift();
    if (ready) {
      resolve(ready);
      return;
    }
    const entry = { resolve };
    waiting.push(entry);
    setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index < 0) return;
      waiting.splice(index, 1);
      reject(new Error('message timeout'));
    }, 5_000);
  });
}

async function shake(socket, readLine, version = bridgeProtocolVersion) {
  const clientNonce = randomNonce();
  socket.write(encodeMessage({
    type: 'hello',
    protocolVersion: version,
    clientNonce,
    client: { name: 'akapen-sensei', version: 'test' },
  }));
  const hello = await readLine(socket);
  return { hello, clientNonce };
}

await check('待ち合わせ場所の控えは推測できない値になる', async () => {
  const target = path.join(identityRoot, 'bridge.json');
  const stats = await fs.stat(target);
  assert.ok(stats.isFile());
  // パイプ名そのものを控えからしか知りえない値にしてある。名前を知らない利用者は
  // 接続を試すこともできない。
  assert.match(identity.pipe, /^pixel-codex-agent-inbox-v1-[0-9a-f]{16}$/);
  assert.match(identity.token, /^[0-9a-f]{64}$/);
  // POSIXのmodeはWindowsでは効かない。他の利用者から読めないことは、利用者の
  // プロファイル配下が継承するNTFSのACLが担っている。modeはそれ以外のOSのため。
  if (process.platform !== 'win32') assert.equal(stats.mode & 0o077, 0);
});

await check('控えが読めなければ相手は居ないものとして扱える', async () => {
  const empty = path.join(root, 'no-user-data');
  const missing = await fs
    .readFile(path.join(empty, 'bridge.json'), 'utf8')
    .then(() => false, () => true);
  assert.equal(missing, true);
});

await check('名乗りでサーバーが先に合言葉を証明する', async () => {
  const socket = await connect();
  try {
    const readLine = lineReader(socket);
    const { hello, clientNonce } = await shake(socket, readLine);
    assert.equal(hello.type, 'helloResult');
    assert.equal(hello.accepted, true);
    // 相手が本物であることを、こちらが名乗る前に確かめられる。
    assert.equal(hello.serverProof, proofFor(identity.token, clientNonce));
    assert.match(hello.serverNonce, /^[0-9a-f]{32}$/);
  } finally {
    socket.destroy();
  }
});

await check('版が違えば対応版を添えて断る', async () => {
  const socket = await connect();
  try {
    const readLine = lineReader(socket);
    const { hello } = await shake(socket, readLine, bridgeProtocolVersion + 1);
    assert.equal(hello.accepted, false);
    assert.deepEqual(hello.supported, [bridgeProtocolVersion]);
    assert.equal(hello.serverProof, undefined);
  } finally {
    socket.destroy();
  }
});

await check('合言葉が違えば受け取らない', async () => {
  const socket = await connect();
  try {
    const readLine = lineReader(socket);
    await shake(socket, readLine);
    socket.write(encodeMessage({
      type: 'submitTask',
      protocolVersion: bridgeProtocolVersion,
      requestId: 'r-bad',
      clientProof: 'f'.repeat(64),
      task: taskFor(realPng),
    }));
    const response = await readLine(socket);
    assert.equal(response.type, 'failed');
    assert.match(response.reason, /合言葉/);
  } finally {
    socket.destroy();
  }
});

await check('名乗る前のsubmitTaskを断る', async () => {
  const socket = await connect();
  try {
    const readLine = lineReader(socket);
    socket.write(encodeMessage({
      type: 'submitTask',
      protocolVersion: bridgeProtocolVersion,
      requestId: 'r-early',
      clientProof: 'a'.repeat(64),
      task: taskFor(realPng),
    }));
    const response = await readLine(socket);
    assert.equal(response.type, 'failed');
  } finally {
    socket.destroy();
  }
});

let acceptedTaskId = '';
await check('受領は画像を写し終えてから返る', async () => {
  const socket = await connect();
  try {
    const readLine = lineReader(socket);
    const { hello } = await shake(socket, readLine);
    socket.write(encodeMessage({
      type: 'submitTask',
      protocolVersion: bridgeProtocolVersion,
      requestId: 'r-ok',
      clientProof: proofFor(identity.token, hello.serverNonce),
      task: taskFor(realPng),
    }));
    const accepted = await readLine(socket);
    assert.equal(accepted.type, 'accepted');
    assert.equal(accepted.requestId, 'r-ok');
    acceptedTaskId = accepted.taskId;

    // `accepted` が返った時点で、写しはもう存在していなければならない。
    const copied = path.join(inboxRoot, `${accepted.taskId}.png`);
    const stats = await fs.stat(copied);
    assert.equal(stats.size, pngHead.length + 16);

    // 元の画像を消しても、Pixel Codex側の写しは残る。
    await fs.rm(realPng);
    await fs.stat(copied);

    const status = await readLine(socket);
    assert.equal(status.type, 'status');
    assert.equal(status.phase, 'pending');

    assert.equal(arrived.length, 1);
    assert.equal(arrived[0].imagePath, copied);
    assert.equal(arrived[0].mode, 'Edit');
  } finally {
    socket.destroy();
  }
});

await check('偽のPNGは受領されず、写しも作られない', async () => {
  const before = await fs.readdir(inboxRoot);
  const socket = await connect();
  try {
    const readLine = lineReader(socket);
    const { hello } = await shake(socket, readLine);
    socket.write(encodeMessage({
      type: 'submitTask',
      protocolVersion: bridgeProtocolVersion,
      requestId: 'r-fake',
      clientProof: proofFor(identity.token, hello.serverNonce),
      task: taskFor(fakePng),
    }));
    const response = await readLine(socket);
    assert.equal(response.type, 'failed');
    assert.match(response.reason, /PNG/);
    assert.deepEqual(await fs.readdir(inboxRoot), before);
  } finally {
    socket.destroy();
  }
});

await check('完了を伝えると預かった画像が片付く', async () => {
  const copied = path.join(inboxRoot, `${acceptedTaskId}.png`);
  await fs.stat(copied);
  server.sendCompleted(acceptedTaskId, '終わりました');
  // 片付けは非同期なので、消えるまで少しだけ待つ。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const gone = await fs.stat(copied).then(() => false, () => true);
    if (gone) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('預かった画像が残ったままです');
});

await check('相手は1本だけで、新しい接続が古い接続を引き継ぐ', async () => {
  const first = await connect();
  const firstClosed = new Promise((resolve) => {
    first.once('close', () => resolve(true));
    setTimeout(() => resolve(false), 2_000);
  });
  await shake(first, lineReader(first));

  const second = await connect();
  try {
    // 古いほうが閉じ、新しいほうがそのまま名乗れる。
    assert.equal(await firstClosed, true);
    const { hello } = await shake(second, lineReader(second));
    assert.equal(hello.accepted, true);
  } finally {
    first.destroy();
    second.destroy();
  }
});

server.stop();
await server.releaseAll();
await fs.rm(root, { recursive: true, force: true });

const failed = results.filter((entry) => !entry.ok);
console.log();
console.log(`${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`);
process.exit(failed.length ? 1 : 0);
