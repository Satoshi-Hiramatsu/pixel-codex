import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { bridgeProtocolVersion } from './CaptureBridgeProtocol';

/**
 * 赤ペン先生との待ち合わせ場所と合言葉。
 *
 * 名前付きパイプにはNode.jsからACLを付けられないため、「既定で他ユーザーから
 * 見えないはず」という推測には頼りません。代わりに、待ち合わせ場所そのものを
 * 利用者のプロファイル配下（`app.getPath('userData')`）にしか書かない値にします。
 * ここはNTFSのACLで他の利用者から読めません。これはOSの保証です。
 *
 * なお、書き出しに付ける `mode: 0o600` はWindowsでは効きません。守っているのは
 * modeではなく置き場所のほうです。modeはそれ以外のOSのために付けてあります。
 *
 * 赤ペン先生は同じファイルを読んでパイプ名と合言葉を知ります。読めない利用者は
 * パイプ名すら分からないので、接続を試すこともできません。
 */
export interface BridgeIdentity {
  protocolVersion: number;
  /** `\\.\pipe\` に続く名前。中身は毎回の起動では変えず、一度決めたら使い回します。 */
  pipe: string;
  /** 合言葉。通信路には流さず、nonceのHMACとしてだけ使います。 */
  token: string;
}

const fileName = 'bridge.json';
const pipePrefix = 'pixel-codex-agent-inbox-v1-';

export function bridgeIdentityPath(userDataPath: string): string {
  return path.join(userDataPath, fileName);
}

/** `\\.\pipe\` を含む、Node.jsの `listen` へ渡せる形。 */
export function pipeAddress(identity: BridgeIdentity): string {
  return `\\\\.\\pipe\\${identity.pipe}`;
}

function isValidPipe(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(pipePrefix)
    && /^[a-z0-9-]{1,120}$/i.test(value);
}

function isValidToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

/**
 * 読めたらそれを使い、無ければ作ります。一度決めた宛先を保つことで、赤ペン先生の
 * 設定を作り直さずにPixel Codexを再起動できます。
 */
export async function loadBridgeIdentity(userDataPath: string): Promise<BridgeIdentity> {
  const target = bridgeIdentityPath(userDataPath);
  try {
    const stored = JSON.parse(await fs.readFile(target, 'utf8')) as Partial<BridgeIdentity>;
    if (stored.protocolVersion === bridgeProtocolVersion
      && isValidPipe(stored.pipe)
      && isValidToken(stored.token)) {
      return { protocolVersion: bridgeProtocolVersion, pipe: stored.pipe, token: stored.token };
    }
  } catch {
    // 初回起動、または壊れた控え。どちらも作り直せば済みます。
  }

  const identity: BridgeIdentity = {
    protocolVersion: bridgeProtocolVersion,
    pipe: `${pipePrefix}${randomBytes(8).toString('hex')}`,
    token: randomBytes(32).toString('hex'),
  };
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(target, JSON.stringify(identity), { encoding: 'utf8', mode: 0o600 });
  return identity;
}
