import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { app, safeStorage, shell } from 'electron';

import type { DriveStatus } from './RemoteProtocol';

/**
 * 撮った画面をGoogle Driveへ預けるための最小限の実装です。LAN外からも見返せる
 * ようにするためだけのもので、Driveの他のファイルには触れません。
 *
 * 権限は`drive.file`だけを求めます。これは**このアプリが作ったファイル**にしか
 * 届かない範囲で、利用者の既存のDriveは読めません。
 */
const driveScope = 'https://www.googleapis.com/auth/drive.file';
const authEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const filesEndpoint = 'https://www.googleapis.com/drive/v3/files';
const uploadEndpoint = 'https://www.googleapis.com/upload/drive/v3/files';
const folderMimeType = 'application/vnd.google-apps.folder';

/** 撮ったものはここへ集めます。利用者が中身を見て自分で消せるようにするためです。 */
export const previewFolderName = 'Pixel Codex Previews';

/** 同意画面から戻ってくるまでの猶予。開いたまま放置された窓を残さないための上限です。 */
const authorizationTimeoutMs = 5 * 60_000;
/** 期限ぎりぎりのアクセストークンで送り出さないための余裕。 */
const tokenRefreshMarginMs = 60_000;

interface StoredDriveSettings {
  clientId: string;
  /** safeStorageで暗号化したもの。復号できない環境では空にします。 */
  clientSecret?: string;
  refreshToken?: string;
  account?: string;
  folderId?: string;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'google-drive.json');
}

function encrypt(value: string): string {
  if (!value) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('このPCでは資格情報を安全に保存できません。');
  }
  return safeStorage.encryptString(value).toString('base64');
}

function decrypt(value: string | undefined): string {
  if (!value) return '';
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    // 別のPCやユーザーで作られた控え。作り直してもらいます。
    return '';
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 認可コードの横取りを防ぐPKCE。デスクトップアプリでは必須の扱いです。 */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what}の応答を解釈できませんでした（${response.status}）`);
  }
  const body = parsed as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error;
    const detail = typeof error === 'string'
      ? error
      : (error as Record<string, unknown> | undefined)?.message;
    throw new Error(`${what}に失敗しました（${detail ?? response.status}）`);
  }
  return body;
}

export class DriveUploader {
  private settings?: StoredDriveSettings;
  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private authorizing = false;

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(settingsPath(), 'utf8');
      this.settings = JSON.parse(raw) as StoredDriveSettings;
    } catch {
      this.settings = undefined;
    }
  }

  getStatus(): DriveStatus {
    return {
      configured: Boolean(this.settings?.clientId && decrypt(this.settings.clientSecret)),
      connected: Boolean(decrypt(this.settings?.refreshToken)),
      account: this.settings?.account ?? '',
      folderName: previewFolderName,
    };
  }

  /**
   * 利用者が自分のGoogle Cloudプロジェクトで作ったOAuthクライアントを預かります。
   * 開発者の資格情報を配布物へ埋め込まないので、鍵が流出しても他人に影響しません。
   */
  async configure(clientId: string, clientSecret: string): Promise<DriveStatus> {
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!id || !secret) throw new Error('クライアントIDとクライアントシークレットを入力してください。');
    // 資格情報を入れ替えたら、前の口で取った許可は使えません。
    this.settings = { clientId: id, clientSecret: encrypt(secret) };
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
    await this.save();
    return this.getStatus();
  }

  async disconnect(): Promise<DriveStatus> {
    if (this.settings) {
      this.settings = { clientId: this.settings.clientId, clientSecret: this.settings.clientSecret };
    }
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
    await this.save();
    return this.getStatus();
  }

  /** ブラウザで同意を取り、更新用トークンを受け取ります。 */
  async connect(): Promise<DriveStatus> {
    const clientId = this.settings?.clientId ?? '';
    const clientSecret = decrypt(this.settings?.clientSecret);
    if (!clientId || !clientSecret) {
      throw new Error('先にクライアントIDとクライアントシークレットを保存してください。');
    }
    if (this.authorizing) throw new Error('すでに認証中です。ブラウザの画面を確認してください。');

    this.authorizing = true;
    try {
      const { verifier, challenge } = createPkcePair();
      const { code, redirectUri } = await this.waitForAuthorizationCode(clientId, challenge);
      const body = await readJson(
        await fetch(tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
        }),
        'Googleの認証',
      );
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      if (!refreshToken) {
        throw new Error('更新用トークンを受け取れませんでした。Googleの画面でアクセスを許可してください。');
      }
      this.applyAccessToken(body);
      this.settings = {
        ...(this.settings as StoredDriveSettings),
        refreshToken: encrypt(refreshToken),
        account: await this.fetchAccountLabel(),
      };
      await this.save();
      return this.getStatus();
    } finally {
      this.authorizing = false;
    }
  }

  /**
   * 撮った画像を上げ、Driveで開けるURLを返します。共有設定は変えないので、
   * 端末側は同じGoogleアカウントでサインインしている必要があります。
   */
  async upload(filePath: string, mimeType: string, name: string): Promise<string> {
    const token = await this.currentAccessToken();
    const folderId = await this.ensureFolder(token);
    const boundary = `pixel-codex-${base64Url(randomBytes(12))}`;
    const metadata = JSON.stringify({ name, parents: [folderId] });
    const data = await fs.readFile(filePath);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, 'utf8'),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const body = await readJson(
      await fetch(`${uploadEndpoint}?uploadType=multipart&fields=id,webViewLink`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/related; boundary=${boundary}`,
        },
        body: payload,
      }),
      'Driveへのアップロード',
    );
    const link = typeof body.webViewLink === 'string' ? body.webViewLink : '';
    const id = typeof body.id === 'string' ? body.id : '';
    if (link) return link;
    if (id) return `https://drive.google.com/file/d/${id}/view`;
    throw new Error('アップロードしたファイルの場所を受け取れませんでした。');
  }

  private applyAccessToken(body: Record<string, unknown>): void {
    this.accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, expiresIn * 1_000 - tokenRefreshMarginMs);
  }

  private async currentAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) return this.accessToken;
    const clientId = this.settings?.clientId ?? '';
    const clientSecret = decrypt(this.settings?.clientSecret);
    const refreshToken = decrypt(this.settings?.refreshToken);
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('先に通信室でGoogle Driveと接続してください。');
    }
    const body = await readJson(
      await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      }),
      'Googleのトークン更新',
    );
    this.applyAccessToken(body);
    if (!this.accessToken) throw new Error('アクセストークンを受け取れませんでした。');
    return this.accessToken;
  }

  /**
   * 置き場をひとつに保ちます。`drive.file`ではこのアプリが作ったものしか一覧に
   * 出ないため、この検索が他のフォルダを覗くことはありません。
   */
  private async ensureFolder(token: string): Promise<string> {
    const known = this.settings?.folderId;
    if (known) return known;
    const query = new URLSearchParams({
      q: `mimeType='${folderMimeType}' and name='${previewFolderName}' and trashed=false`,
      fields: 'files(id,name)',
      spaces: 'drive',
      pageSize: '1',
    });
    const found = await readJson(
      await fetch(`${filesEndpoint}?${query}`, { headers: { authorization: `Bearer ${token}` } }),
      'Driveのフォルダ検索',
    );
    const files = Array.isArray(found.files) ? found.files as Array<Record<string, unknown>> : [];
    let folderId = typeof files[0]?.id === 'string' ? files[0].id : '';
    if (!folderId) {
      const created = await readJson(
        await fetch(`${filesEndpoint}?fields=id`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ name: previewFolderName, mimeType: folderMimeType }),
        }),
        'Driveのフォルダ作成',
      );
      folderId = typeof created.id === 'string' ? created.id : '';
    }
    if (!folderId) throw new Error('Driveに保存先フォルダを用意できませんでした。');
    this.settings = { ...(this.settings as StoredDriveSettings), folderId };
    await this.save();
    return folderId;
  }

  private async fetchAccountLabel(): Promise<string> {
    try {
      const body = await readJson(
        await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
          headers: { authorization: `Bearer ${this.accessToken}` },
        }),
        'Driveの利用者情報',
      );
      const user = body.user as Record<string, unknown> | undefined;
      return typeof user?.emailAddress === 'string' ? user.emailAddress : '接続済み';
    } catch {
      // 表示用の名前が取れないだけなので、接続そのものは成立しています。
      return '接続済み';
    }
  }

  /**
   * ループバックで同意の戻りを受けます。127.0.0.1で待つのはデスクトップアプリの
   * 標準的な受け取り方で、外から叩ける口を開けずに済みます。
   */
  private waitForAuthorizationCode(
    clientId: string,
    challenge: string,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const state = base64Url(randomBytes(16));
      let settled = false;
      const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/') {
          response.writeHead(404).end();
          return;
        }
        const reply = (message: string): void => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:32px">${message}</body>`);
        };
        if (url.searchParams.get('state') !== state) {
          reply('この画面はPixel Codexの認証には使えません。もう一度やり直してください。');
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code') ?? '';
        if (error || !code) {
          reply('Pixel Codexへの接続は取り消されました。この画面は閉じてかまいません。');
          finish(new Error(error ? `Googleの画面で拒否されました（${error}）` : '認可コードを受け取れませんでした'));
          return;
        }
        reply('Pixel Codexへ接続しました。この画面は閉じてかまいません。');
        finish(undefined, code);
      });

      const finish = (failure?: Error, code?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 応答を返しきってから閉じます。
        setTimeout(() => server.close(), 200);
        if (failure) reject(failure);
        else resolve({ code: code ?? '', redirectUri });
      };

      const timer = setTimeout(
        () => finish(new Error('Googleの認証が時間切れになりました。もう一度お試しください。')),
        authorizationTimeoutMs,
      );

      let redirectUri = '';
      server.on('error', (failure) => finish(failure instanceof Error ? failure : new Error(String(failure))));
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(new Error('認証の受け口を用意できませんでした。'));
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}`;
        const authUrl = new URL(authEndpoint);
        authUrl.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: driveScope,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state,
        }).toString();
        void shell.openExternal(authUrl.toString());
      });
    });
  }

  private async save(): Promise<void> {
    if (!this.settings) {
      await fs.rm(settingsPath(), { force: true }).catch(() => undefined);
      return;
    }
    await fs.writeFile(settingsPath(), JSON.stringify(this.settings), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
