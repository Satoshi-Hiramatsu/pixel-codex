import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  bridgeProtocolVersion,
  encodeMessage,
  proofFor,
  randomNonce,
} from '../src/bridge/CaptureBridgeProtocol.ts';

/**
 * 赤ペン先生の代役。動いているPixel Codexへ、本物と同じ手順で赤入れを送ります。
 *
 * Pixel Codex側の見え方（到着帯、指示欄への下書き、作業フォルダの食い違い、
 * 取り下げ、一時画像の後始末）を、赤ペン先生を起動せずに確かめるための道具です。
 * どちらか片方だけを直したいときに、原因の切り分けが楽になります。
 *
 * 例:
 *   npm run bridge:send
 *   npm run bridge:send -- --mode Discuss --cwd D:\work\repo
 *   npm run bridge:send -- --image C:\path\capture.png --hold
 *   npm run bridge:send -- --drop-after-accept
 */

/** 中断は例外にして、開いた接続を畳んでから終わります。 */
class Abort extends Error {}

function fail(message) {
  throw new Abort(message);
}

/** 1x1の赤い点。PNGとして正しい最小限の中身。 */
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function readOptions() {
  const { values } = parseArgs({
    options: {
      image: { type: 'string' },
      cwd: { type: 'string' },
      mode: { type: 'string', default: 'Edit' },
      instruction: { type: 'string', default: 'この赤入れのとおりに直してください（受け取り確認用）' },
      /** 送ったあと接続を保ったまま待つ。status と completed の到着を見るため。 */
      hold: { type: 'boolean', default: false },
      /** 受領のあと、わざと即座に切る。受領後でも写しが残ることの確認用。 */
      'drop-after-accept': { type: 'boolean', default: false },
      /** 名乗りの直後に切る。受領前の切断で写しが作られないことの確認用。 */
      'drop-before-submit': { type: 'boolean', default: false },
      'bridge-file': { type: 'string' },
    },
  });
  return values;
}

/** 届いた行を1本ずつ配ります。accepted と status は続けて届きます。 */
function lineReader(socket) {
  const queue = [];
  const waiting = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        const next = waiting.shift();
        if (next) next(parsed);
        else queue.push(parsed);
      }
      newline = buffer.indexOf('\n');
    }
  });
  return (timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const ready = queue.shift();
    if (ready) return resolve(ready);
    const timer = timeoutMs > 0
      ? setTimeout(() => reject(new Abort('返事が来ません')), timeoutMs)
      : undefined;
    waiting.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

async function resolveImage(requested) {
  if (requested) {
    const target = path.resolve(requested);
    await fs.access(target).catch(() => fail(`画像が見つかりません: ${target}`));
    return target;
  }
  const target = path.join(os.tmpdir(), `akapen-test-${Date.now()}.png`);
  await fs.writeFile(target, Buffer.from(tinyPng, 'base64'));
  return target;
}

async function main() {
  const values = readOptions();
  const bridgeFile = values['bridge-file']
    ?? path.join(process.env.APPDATA ?? os.homedir(), 'Pixel Codex', 'bridge.json');

  let identity;
  try {
    identity = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
  } catch {
    fail(`待ち合わせ場所の控えが読めません: ${bridgeFile}\n`
      + '       Pixel Codexを一度起動してから、もう一度試してください。');
  }
  console.log(`控え: ${bridgeFile}`);
  console.log(`パイプ: ${identity.pipe}`);

  const imagePath = await resolveImage(values.image);
  const workingDirectory = path.resolve(values.cwd ?? process.cwd());
  const mode = values.mode === 'Discuss' ? 'Discuss' : 'Edit';

  const socket = net.createConnection(`\\\\.\\pipe\\${identity.pipe}`);
  socket.setEncoding('utf8');
  const nextMessage = lineReader(socket);

  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', (error) => reject(new Abort(
        `接続できません: ${error.message}\n`
        + '       Pixel Codexが起動していて、通信室で受け取りが有効か確かめてください。',
      )));
    });

    const clientNonce = randomNonce();
    socket.write(encodeMessage({
      type: 'hello',
      protocolVersion: bridgeProtocolVersion,
      clientNonce,
      client: { name: 'akapen-sensei', version: 'test-tool' },
    }));

    const hello = await nextMessage();
    if (hello.type !== 'helloResult' || !hello.accepted) {
      fail(`名乗りを断られました: ${hello.reason ?? JSON.stringify(hello)}`);
    }
    // 相手が本物かどうかを、こちらが名乗る前に確かめます。ここを飛ばすと、
    // パイプ名を先取りした偽物へ指示と画像の場所を渡してしまいます。
    if (hello.serverProof !== proofFor(identity.token, clientNonce)) {
      fail('受け取り口を確認できませんでした。接続を中止します。');
    }
    console.log(`相手: ${hello.app?.name} ${hello.app?.version}（確認済み）`);

    if (values['drop-before-submit']) {
      console.log('名乗りの直後に切断しました。写しは作られないはずです。');
      return;
    }

    socket.write(encodeMessage({
      type: 'submitTask',
      protocolVersion: bridgeProtocolVersion,
      requestId: randomUUID(),
      clientProof: proofFor(identity.token, hello.serverNonce),
      task: {
        id: randomUUID().replace(/-/g, ''),
        instruction: values.instruction,
        imagePath,
        workingDirectory,
        mode,
        source: 'akapen-sensei',
        createdAtUtc: new Date().toISOString(),
      },
    }));
    console.log(`送信: mode=${mode} cwd=${workingDirectory}`);

    const accepted = await nextMessage();
    if (accepted.type !== 'accepted') {
      fail(`受け取られませんでした: ${accepted.reason ?? JSON.stringify(accepted)}`);
    }
    console.log(`受領: taskId=${accepted.taskId}`);
    console.log(`写し: ${path.join(os.tmpdir(), 'pixel-codex-inbox', `${accepted.taskId}.png`)}`);

    if (values['drop-after-accept']) {
      console.log('受領後に切断します。Pixel Codex側の写しは残るはずです。');
      return;
    }
    if (!values.hold) {
      console.log('Pixel Codexの画面を確認してください。--hold を付けると完了まで待ちます。');
      return;
    }

    console.log('Pixel Codexの画面で送信するまで待ちます（Ctrl+Cで終了）…');
    for (;;) {
      const message = await nextMessage(0);
      if (message.type === 'status') {
        console.log(`状態: ${message.phase} — ${message.detail}`);
        continue;
      }
      if (message.type === 'completed') {
        console.log(`完了: ${message.summary ?? '(要約なし)'}`);
        return;
      }
      if (message.type === 'failed') {
        console.log(`失敗: ${message.reason}`);
        return;
      }
    }
  } finally {
    socket.destroy();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Abort ? `エラー: ${error.message}` : error);
  process.exitCode = 1;
}
