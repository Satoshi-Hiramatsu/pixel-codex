import fs from 'node:fs/promises';
import path from 'node:path';

import { bridgeIdentityPath, loadBridgeIdentity } from '../src/bridge/bridgeIdentity.ts';
import { CaptureBridgeServer } from '../src/bridge/CaptureBridgeServer.ts';

/**
 * 赤ペン先生側のテストから使う、本物の受け取り口。
 *
 * C#のクライアントとTypeScriptのサーバーが本当に噛み合うかは、どちらか一方だけを
 * 見ていても分かりません。合言葉の計算、JSONの形、行の区切りのどれか一つでも
 * ずれていれば、ここで繋がらなくなります。
 *
 * 使い方: node --import ./tools/ts-extension-hooks.mjs tools/bridge-server-harness.mjs <作業用フォルダ>
 * 最初の1行に待ち合わせ場所の控えの位置を出し、以後は届いた赤入れを1行ずつ報告します。
 */
const root = process.argv[2];
if (!root) {
  console.error('usage: bridge-server-harness.mjs <root>');
  process.exit(2);
}

const identityRoot = path.join(root, 'userData');
const inboxRoot = path.join(root, 'inbox');
const identity = await loadBridgeIdentity(identityRoot);
const server = new CaptureBridgeServer(identity, '0.0.0-harness', inboxRoot);

server.on('task', (task) => {
  // 届いた内容をそのまま返し、呼び出し側が写しの位置まで確かめられるようにします。
  console.log(JSON.stringify({ event: 'task', task }));
  // 人が確認する工程は本物のPixel Codexが持つので、ここでは自動で進めます。
  server.sendStatus(task.taskId, 'started', 'harnessが受け取りました');
  server.sendCompleted(task.taskId, 'harnessが完了として返しました');
});

await server.start();
console.log(JSON.stringify({ event: 'ready', bridgeFile: bridgeIdentityPath(identityRoot) }));

async function shutdown() {
  server.stop();
  await server.releaseAll();
  process.exit(0);
}

// 呼び出し側が標準入力を閉じたら畳みます。取り残されたプロセスを残さないためです。
process.stdin.on('end', () => void shutdown());
process.stdin.resume();
process.on('SIGTERM', () => void shutdown());
await fs.mkdir(inboxRoot, { recursive: true });
