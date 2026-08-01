import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import started from 'electron-squirrel-startup';
import fs from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { CodexClient } from './codex/CodexClient';
import {
  describeAttachment,
  maxAttachmentCount,
  normalizeAttachments,
  saveAttachment,
} from './files/attachments';
import { createSave, getRepoStatus, initRepo, listSaves, loadSave } from './saves/gitSaves';
import { RemoteGateway } from './remote/RemoteGateway';
import { DevelopmentRelay } from './remote/DevelopmentRelay';
import {
  captureUrl,
  captureWindow,
  discardPreviews,
  listCapturableWindows,
  type CapturedPreview,
} from './remote/PreviewCapture';
import {
  normalizePreviewSources,
  summarizePreviewSources,
  type PreviewSource,
} from './remote/previewSources';
import {
  deleteSkill,
  listSkillShelves,
  readSkillBook,
  saveSkill,
  setEquippedSkills,
  setUserDataRoot,
} from './skills/skillStore';
import type {
  CodexProcessInfo,
  RemoteGatewayConfig,
  RemoteInstructionResult,
  RemotePreviewRequest,
  RemoteStateSnapshot,
  SaveMeta,
  SkillScope,
  ThreadOptions,
  UsbTestSession,
  WirelessPairingEvent,
  WirelessPairingSession,
  WirelessTestSession,
} from './types';

const execFileAsync = promisify(execFile);

/** 貼り付けた画像を置いておく場所。アプリを閉じるまでの一時的な置き場です。 */
function attachmentTempRoot(): string {
  return path.join(app.getPath('temp'), 'pixel-codex-attachments');
}

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (started) app.quit();
app.enableSandbox();

const codex = new CodexClient();
let remoteGateway: RemoteGateway | undefined;
const developmentRelay = new DevelopmentRelay();

/**
 * PCの身元とRelayトークン。どちらも保存しておくことで、一度ペアリングした
 * Android端末はPCを再起動しても同じ宛先へつなぎ直せます。
 */
interface RemoteIdentity {
  hostId: string;
  relayToken: string;
  /** 一度でもペアリングに成功したか。起動時にRelayを出すかどうかの判断に使います。 */
  paired?: boolean;
}

function remoteIdentityPath(): string {
  return path.join(app.getPath('userData'), 'remote-host.json');
}

async function markRemotePaired(): Promise<void> {
  if (!remoteIdentity || remoteIdentity.paired) return;
  remoteIdentity = { ...remoteIdentity, paired: true };
  await fs.writeFile(remoteIdentityPath(), JSON.stringify(remoteIdentity), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

let remoteIdentity: RemoteIdentity | undefined;

async function loadRemoteIdentity(): Promise<RemoteIdentity> {
  let hostId = '';
  let relayToken = '';
  let paired = false;
  try {
    const stored = JSON.parse(await fs.readFile(remoteIdentityPath(), 'utf8')) as {
      hostId?: unknown;
      relayToken?: unknown;
      paired?: unknown;
    };
    if (typeof stored.hostId === 'string' && /^[a-f0-9-]{36}$/i.test(stored.hostId)) {
      hostId = stored.hostId;
    }
    if (typeof stored.relayToken === 'string' && /^[a-f0-9]{64}$/i.test(stored.relayToken)) {
      relayToken = stored.relayToken;
    }
    paired = stored.paired === true;
  } catch {
    // The first launch has no remote identity yet.
  }
  const identity: RemoteIdentity = {
    hostId: hostId || randomUUID(),
    relayToken: relayToken || `${randomUUID()}${randomUUID()}`.replace(/-/g, ''),
    paired,
  };
  if (identity.hostId !== hostId || identity.relayToken !== relayToken) {
    await fs.writeFile(remoteIdentityPath(), JSON.stringify(identity), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
  return identity;
}

async function resolveWorkspaceItem(workspace: string, itemPath = ''): Promise<{
  root: string;
  target: string;
}> {
  if (!path.isAbsolute(workspace)) throw new Error('作業フォルダが正しくありません。');
  const root = await fs.realpath(workspace);
  const requested = path.isAbsolute(itemPath) ? itemPath : path.resolve(root, itemPath);
  const target = await fs.realpath(requested);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('作業フォルダ外のデータは開けません。');
  }
  return { root, target };
}

/** Splits one `tasklist /FO CSV` line into its quoted fields. */
function parseCsvLine(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

/**
 * Other Codex sessions (a terminal, the desktop app) hold the resources this
 * app needs, so they have to be found before the user can decide what to do.
 * Only `codex.exe` processes we did not spawn ourselves are reported.
 */
async function findOtherCodexProcesses(): Promise<CodexProcessInfo[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq codex.exe', '/FO', 'CSV', '/NH'],
      { timeout: 8_000, windowsHide: true },
    );
    const ownPid = codex.pid;
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"'))
      .flatMap((line) => {
        const fields = parseCsvLine(line);
        const pid = Number(fields[1]);
        if (!Number.isFinite(pid) || pid <= 0) return [];
        if (ownPid && pid === ownPid) return [];
        return [{ pid, name: fields[0] ?? 'codex.exe', memory: fields[4] ?? '' }];
      });
  } catch {
    // `tasklist` prints "INFO: No tasks" and exits non-zero when nothing matches.
    return [];
  }
}

async function adbExecutable(): Promise<string> {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
    .filter((value): value is string => Boolean(value));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  for (const root of roots) {
    const executable = path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    try {
      await fs.access(executable);
      return executable;
    } catch {
      // Try the next standard Android SDK location.
    }
  }
  throw new Error('Android SDKのadbが見つかりません。Android StudioでPlatform Toolsを導入してください。');
}

/** ファイアウォールの許可を1度で済ませるため、Relayはこのポートから順に空きを探します。 */
const defaultRelayPort = 57170;

function relayStartOptions(bindHost: string) {
  return {
    bindHost,
    token: remoteIdentity?.relayToken,
    preferredPort: defaultRelayPort,
    hostId: remoteIdentity?.hostId,
  };
}

async function startUsbRemoteTest(): Promise<UsbTestSession> {
  if (!remoteGateway) throw new Error('Remote Gatewayが初期化されていません。');
  const relay = await developmentRelay.start(relayStartOptions('127.0.0.1'));
  const adb = await adbExecutable();
  const { stdout } = await execFileAsync(adb, ['devices', '-l'], { timeout: 10_000, windowsHide: true });
  const devices = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\sdevice(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0]);
  if (!devices.length) {
    throw new Error('USBデバッグを許可したAndroid端末が見つかりません。');
  }
  if (devices.length > 1) {
    throw new Error('Android端末が複数あります。テストする端末だけをUSB接続してください。');
  }
  const deviceSerial = devices[0];
  await execFileAsync(adb, ['-s', deviceSerial, 'reverse', `tcp:${relay.port}`, `tcp:${relay.port}`], {
    timeout: 10_000,
    windowsHide: true,
  });
  remoteGateway.configure({ enabled: true, relayUrl: relay.relayUrl, autoReconnect: true });
  await execFileAsync(adb, ['-s', deviceSerial, 'shell', 'am', 'force-stop', 'jp.pixelcodex.companion'], {
    timeout: 10_000,
    windowsHide: true,
  });
  await execFileAsync(adb, [
    '-s', deviceSerial,
    'shell', 'am', 'start',
    '-n', 'jp.pixelcodex.companion/.MainActivity',
    '--es', 'relayUrl', relay.relayUrl,
    '--es', 'hostId', remoteGateway.hostId,
    '--ez', 'autoConnect', 'true',
  ], { timeout: 15_000, windowsHide: true });
  return { hostId: remoteGateway.hostId, relayUrl: relay.relayUrl, deviceSerial };
}

function privateLanAddress(): string {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).flatMap((address) => {
      if (address.internal || address.family !== 'IPv4') return [];
      const privateAddress = /^10\./.test(address.address)
        || /^192\.168\./.test(address.address)
        || (() => {
          const match = /^172\.(\d+)\./.exec(address.address);
          const second = Number(match?.[1]);
          return second >= 16 && second <= 31;
        })();
      if (!privateAddress) return [];
      const preferred = /wi-?fi|wlan|wireless/i.test(name) ? 0 : 1;
      return [{ address: address.address, preferred }];
    }),
  );
  candidates.sort((left, right) => left.preferred - right.preferred);
  const selected = candidates[0]?.address;
  if (!selected) {
    throw new Error('同一Wi-Fiで利用できるPCのプライベートIPv4アドレスを確認できませんでした');
  }
  return selected;
}

/** Wi-Fiが無い場所でも画面を開けるよう、見つからないときは空文字にします。 */
function lanAddressOrEmpty(): string {
  try {
    return privateLanAddress();
  } catch {
    return '';
  }
}

async function startWirelessRemoteTest(): Promise<WirelessTestSession> {
  if (!remoteGateway) throw new Error('Remote Gatewayが初期化されていません');
  const lanAddress = privateLanAddress();
  const relay = await developmentRelay.start(relayStartOptions('0.0.0.0'));
  const adb = await adbExecutable();
  const { stdout } = await execFileAsync(adb, ['devices', '-l'], { timeout: 10_000, windowsHide: true });
  const devices = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\sdevice(?:\s|$)/.test(line))
    .map((line) => line.split(/\s+/)[0]);
  if (!devices.length) {
    throw new Error('初回設定を渡すため、USBデバッグを許可したAndroid端末を接続してください');
  }
  if (devices.length > 1) {
    throw new Error('Android端末が複数あります。テストする端末だけをUSB接続してください');
  }
  const deviceSerial = devices[0];
  const androidRelayUrl = `ws://${lanAddress}:${relay.port}/relay?token=${relay.token}`;
  remoteGateway.configure({ enabled: true, relayUrl: relay.relayUrl, autoReconnect: true });
  await execFileAsync(adb, ['-s', deviceSerial, 'shell', 'am', 'force-stop', 'jp.pixelcodex.companion'], {
    timeout: 10_000,
    windowsHide: true,
  });
  await execFileAsync(adb, [
    '-s', deviceSerial,
    'shell', 'am', 'start',
    '-n', 'jp.pixelcodex.companion/.MainActivity',
    '--es', 'relayUrl', androidRelayUrl,
    '--es', 'hostId', remoteGateway.hostId,
    '--ez', 'autoConnect', 'true',
  ], { timeout: 15_000, windowsHide: true });
  return {
    hostId: remoteGateway.hostId,
    relayUrl: relay.relayUrl,
    androidRelayUrl,
    lanAddress,
    deviceSerial,
  };
}

/**
 * ケーブルを一切使わないペアリング。PCは待ち受けと6桁コードを用意するだけで、
 * 端末がそのコードを送ってきたらRelayトークンを渡します。
 */
async function startWirelessPairing(): Promise<WirelessPairingSession> {
  if (!remoteGateway) throw new Error('Remote Gatewayが初期化されていません');
  const lanAddress = privateLanAddress();
  const relay = await developmentRelay.start(relayStartOptions('0.0.0.0'));
  remoteGateway.configure({ enabled: true, relayUrl: relay.relayUrl, autoReconnect: true });
  const ticket = developmentRelay.openPairing(remoteGateway.hostId);
  return {
    hostId: remoteGateway.hostId,
    lanAddress,
    port: relay.port,
    code: ticket.code,
    expiresAt: ticket.expiresAt,
    relayUrl: relay.relayUrl,
  };
}

/**
 * 一度でもペアリング済みなら、起動時にRelayをLANへ出しておきます。これがないと
 * 端末はPCを再起動するたびにペアリングし直すことになります。
 */
async function resumeWirelessRelay(): Promise<void> {
  if (!remoteIdentity?.paired) return;
  try {
    privateLanAddress();
    await developmentRelay.start(relayStartOptions('0.0.0.0'));
  } catch {
    // Wi-Fiが無い場所での起動。画面からもう一度ペアリングすれば復帰できます。
  }
}

/**
 * 撮影対象の控え。通信室で登録したものを画面から預かっておき、端末からの要求は
 * このidとの照合だけで解決します。端末がURLやパスを名乗ることはありません。
 */
let registeredPreviewSources: PreviewSource[] = [];
let previewAllowed = false;

/** 端末が取りに来るまでの猶予。過ぎたら実ファイルごと消えます。 */
const previewTtlMs = 10 * 60_000;

async function respondWithPreviewSources(): Promise<void> {
  const gateway = remoteGateway;
  if (!gateway) return;
  if (!previewAllowed) {
    gateway.sendPreviewSources([]);
    return;
  }
  // ウィンドウは開いたり閉じたりするので、控えず要求のたびに数え直します。
  const windows = await listCapturableWindows().catch(() => []);
  gateway.sendPreviewSources([
    ...summarizePreviewSources(registeredPreviewSources),
    ...windows.map((window) => ({ id: window.id, kind: 'window' as const, label: window.label })),
  ]);
}

async function capturePreviewSource(request: RemotePreviewRequest): Promise<CapturedPreview> {
  const source = registeredPreviewSources.find((candidate) => candidate.id === request.sourceId);
  if (source?.kind === 'url' && source.url) {
    return captureUrl(source.url, request.viewport);
  }
  if (source?.kind === 'file' && source.workspace && source.relativePath) {
    const { target } = await resolveWorkspaceItem(source.workspace, source.relativePath);
    return captureUrl(pathToFileURL(target).toString(), request.viewport);
  }
  // 登録一覧に無いidはウィンドウ。開いているものとの照合はcaptureWindowが行います。
  return captureWindow(request.sourceId);
}

async function deliverPreview(request: RemotePreviewRequest): Promise<void> {
  const gateway = remoteGateway;
  if (!gateway) return;
  if (!previewAllowed) {
    gateway.sendPreviewFailed({
      messageId: request.messageId,
      reason: 'PCの通信室でプレビューの送信が許可されていません',
    });
    return;
  }
  try {
    const captured = await capturePreviewSource(request);
    const published = developmentRelay.publishPreview(
      captured.filePath,
      captured.mimeType,
      previewTtlMs,
    );
    gateway.sendPreviewReady({
      messageId: request.messageId,
      previewId: published.previewId,
      path: published.path,
      width: captured.width,
      height: captured.height,
      bytes: captured.bytes,
      expiresAt: published.expiresAt,
    });
  } catch (error) {
    gateway.sendPreviewFailed({
      messageId: request.messageId,
      reason: error instanceof Error ? error.message : '撮影できませんでした',
    });
  }
}

/** 画面から届いた置き場所の指定。知らない値はグローバル扱いにします。 */
function normalizeScope(value: unknown): SkillScope {
  return value === 'project' ? 'project' : 'global';
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, value);
  }
}

codex.on('event', (event) => broadcast('codex:event', event));
codex.on('diagnostic', (message) =>
  broadcast('codex:event', { method: 'pixel/diagnostic', params: { message } }),
);
codex.on('exit', (message) =>
  broadcast('codex:event', { method: 'pixel/disconnected', params: { message } }),
);

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({ cwd: process.cwd(), version: app.getVersion() }));
  ipcMain.handle('remote:host-info', () => ({
    hostId: remoteGateway?.hostId ?? '',
    status: remoteGateway?.getStatus() ?? { phase: 'disabled', label: '通信停止中' },
    lanAddress: lanAddressOrEmpty(),
  }));
  ipcMain.handle('remote:configure', (_event, config: RemoteGatewayConfig) =>
    remoteGateway?.configure({
      enabled: config?.enabled === true,
      relayUrl: typeof config?.relayUrl === 'string' ? config.relayUrl : '',
      autoReconnect: config?.autoReconnect !== false,
    }) ?? { phase: 'error', label: 'Gateway未初期化' },
  );
  ipcMain.handle('remote:start-usb-test', () => startUsbRemoteTest());
  ipcMain.handle('remote:start-wireless-test', () => startWirelessRemoteTest());
  ipcMain.handle('remote:start-pairing', () => startWirelessPairing());
  ipcMain.handle('remote:cancel-pairing', () => {
    developmentRelay.cancelPairing();
  });
  ipcMain.handle('remote:update-state', (_event, state: RemoteStateSnapshot) => {
    remoteGateway?.updateState(state);
  });
  ipcMain.handle('remote:acknowledge', (_event, result: RemoteInstructionResult) => {
    remoteGateway?.acknowledge(result);
  });
  /**
   * 撮影対象は端末へ配る`state.snapshot`には載せません。あれは返答が1文字進むたびに
   * 流れる経路なので、選択肢のような滅多に変わらないものを混ぜると通信量だけ増えます。
   */
  ipcMain.handle(
    'remote:set-preview-sources',
    (_event, payload: { enabled?: boolean; sources?: unknown }) => {
      previewAllowed = payload?.enabled === true;
      registeredPreviewSources = previewAllowed ? normalizePreviewSources(payload?.sources) : [];
    },
  );
  ipcMain.handle('app:choose-workspace', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('app:choose-codex', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Codex CLI', extensions: ['exe', 'cmd'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle(
    'workspace:list-directory',
    async (_event, workspace: string, relativePath = '') => {
      const { root, target } = await resolveWorkspaceItem(workspace, relativePath);
      const entries = await fs.readdir(target, { withFileTypes: true });
      const details = await Promise.all(entries.slice(0, 2000).map(async (entry) => {
        const absolutePath = path.join(target, entry.name);
        const stats = await fs.stat(absolutePath).catch(() => undefined);
        return {
          name: entry.name,
          relativePath: path.relative(root, absolutePath),
          kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
          size: stats?.size ?? 0,
          modifiedAt: stats?.mtimeMs ?? 0,
        };
      }));
      return details.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name, 'ja', { numeric: true });
      });
    },
  );
  ipcMain.handle(
    'workspace:open-item',
    async (_event, workspace: string, itemPath: string) => {
      const { target } = await resolveWorkspaceItem(workspace, itemPath);
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    },
  );
  ipcMain.handle('attachments:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: '指示に添えるファイルを選ぶ',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.slice(0, maxAttachmentCount).map((filePath) => describeAttachment(filePath)),
    );
  });
  ipcMain.handle('attachments:describe', async (_event, paths: string[]) => {
    const targets = (Array.isArray(paths) ? paths : [])
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry))
      .slice(0, maxAttachmentCount);
    return Promise.all(targets.map((filePath) => describeAttachment(filePath)));
  });
  ipcMain.handle('attachments:save', (_event, name: string, dataBase64: string) =>
    saveAttachment(attachmentTempRoot(), String(name ?? ''), String(dataBase64 ?? '')),
  );
  ipcMain.handle('skills:read-book', (_event, workspace: string) =>
    readSkillBook(typeof workspace === 'string' ? workspace : ''),
  );
  ipcMain.handle(
    'skills:save',
    (_event, scope: SkillScope, workspace: string, draft: unknown) =>
      saveSkill(normalizeScope(scope), String(workspace ?? ''), draft),
  );
  ipcMain.handle('skills:delete', (_event, scope: SkillScope, workspace: string, id: string) =>
    deleteSkill(normalizeScope(scope), String(workspace ?? ''), String(id ?? '')),
  );
  ipcMain.handle(
    'skills:set-equipped',
    (_event, scope: SkillScope, workspace: string, ids: unknown) =>
      setEquippedSkills(normalizeScope(scope), String(workspace ?? ''), ids),
  );
  ipcMain.handle('skills:list-shelves', (_event, workspaces: unknown) =>
    listSkillShelves(workspaces),
  );
  ipcMain.handle(
    'codex:ask',
    (_event, cwd: string, prompt: string, options?: ThreadOptions) => {
      if (!path.isAbsolute(cwd)) throw new Error('作業フォルダは絶対パスで指定してください。');
      const text = String(prompt ?? '').trim();
      if (!text || text.length > 20_000) throw new Error('相談内容が不正です。');
      const model = typeof options?.model === 'string' ? options.model.trim().slice(0, 120) : '';
      const effort = typeof options?.effort === 'string' ? options.effort.trim().slice(0, 32) : '';
      return codex.askOnce(cwd, text, {
        model: model || undefined,
        effort: effort || undefined,
      });
    },
  );
  ipcMain.handle('saves:status', (_event, workspace: string) => getRepoStatus(workspace));
  ipcMain.handle('saves:init', (_event, workspace: string) => initRepo(workspace));
  ipcMain.handle('saves:list', (_event, workspace: string) => listSaves(workspace));
  ipcMain.handle(
    'saves:create',
    (_event, workspace: string, label: string, meta: SaveMeta) =>
      createSave(workspace, String(label ?? '').slice(0, 200), meta ?? ({} as SaveMeta)),
  );
  ipcMain.handle('saves:load', (_event, workspace: string, commit: string) =>
    loadSave(workspace, String(commit ?? '')),
  );
  ipcMain.handle('codex:list-processes', () => findOtherCodexProcesses());
  ipcMain.handle('codex:terminate-processes', async (_event, pids: number[]) => {
    const ownPid = codex.pid;
    const stopped: number[] = [];
    const failed: number[] = [];
    const targets = (Array.isArray(pids) ? pids : [])
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== ownPid && pid !== process.pid);
    // Only PIDs that tasklist just reported as codex.exe may be killed, so a
    // stale or crafted id can never take down an unrelated program.
    const allowed = new Set((await findOtherCodexProcesses()).map((entry) => entry.pid));
    for (const pid of targets) {
      if (!allowed.has(pid)) {
        failed.push(pid);
        continue;
      }
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          timeout: 8_000,
          windowsHide: true,
        });
        stopped.push(pid);
      } catch {
        failed.push(pid);
      }
    }
    return { stopped, failed };
  });
  ipcMain.handle('codex:start', (_event, executable?: string) => codex.start(executable));
  ipcMain.handle('codex:stop', () => codex.stop());
  ipcMain.handle('codex:start-thread', (_event, cwd: string, options?: ThreadOptions) => {
    if (!path.isAbsolute(cwd)) throw new Error('作業フォルダは絶対パスで指定してください。');
    const model = typeof options?.model === 'string' ? options.model.trim().slice(0, 120) : '';
    const effort = typeof options?.effort === 'string' ? options.effort.trim().slice(0, 32) : '';
    return codex.startThread(cwd, {
      model: model || undefined,
      effort: effort || undefined,
    });
  });
  ipcMain.handle(
    'codex:send-task',
    (_event, threadId: string, text: string, attachments?: unknown) => {
      if (!text.trim() || text.length > 20_000) throw new Error('指示内容が不正です。');
      return codex.sendTask(threadId, text.trim(), normalizeAttachments(attachments));
    },
  );
  ipcMain.handle(
    'codex:steer',
    (_event, threadId: string, turnId: string, text: string, attachments?: unknown) => {
      if (!text.trim() || text.length > 20_000) throw new Error('追加指示が不正です。');
      return codex.steerAgent(threadId, turnId, text.trim(), normalizeAttachments(attachments));
    },
  );
  // 使用量の枠を返さないCodexもあるので、失敗は「取得できなかった」として扱います。
  ipcMain.handle('codex:rate-limits', () => codex.readRateLimits().catch(() => undefined));
  ipcMain.handle('codex:interrupt', (_event, threadId: string, turnId: string) =>
    codex.interruptAgent(threadId, turnId),
  );
  ipcMain.handle(
    'codex:respond-approval',
    (_event, requestId: number | string, decision: 'accept' | 'decline' | 'cancel') =>
      codex.respondApproval(requestId, decision),
  );
  ipcMain.handle(
    'codex:respond-user-input',
    (_event, requestId: number | string, answers: Record<string, string[]>) => {
      const normalized = Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [
          id,
          values.filter((value) => typeof value === 'string').map((value) => value.slice(0, 20_000)),
        ]),
      );
      return codex.respondUserInput(requestId, normalized);
    },
  );
}

function createWindow(): void {
  const windowIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'pixel-codex-icon.png')
    : path.join(app.getAppPath(), 'assets', 'branding', 'pixel-codex-icon.png');
  const mainWindow = new BrowserWindow({
    height: 820,
    width: 1440,
    minHeight: 680,
    icon: windowIcon,
    // レイアウトが必要とする幅（index.css の min-width）と揃えます。これより狭くすると
    // 右カラムが画面の外へ出てしまい、タブにも会議パネルにも手が届きません。
    minWidth: 1240,
    backgroundColor: '#14191d',
    title: 'Pixel Codex',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
}

app.whenReady().then(async () => {
  setUserDataRoot(app.getPath('userData'));
  remoteIdentity = await loadRemoteIdentity();
  remoteGateway = new RemoteGateway(remoteIdentity.hostId);
  remoteGateway.on('status', (status) => broadcast('remote:status', status));
  remoteGateway.on('instruction', (instruction) => broadcast('remote:instruction', instruction));
  remoteGateway.on('approval', (response) => broadcast('remote:approval', response));
  remoteGateway.on('question', (response) => broadcast('remote:question', response));
  remoteGateway.on('previewSources', () => void respondWithPreviewSources());
  remoteGateway.on('preview', (request: RemotePreviewRequest) => void deliverPreview(request));
  developmentRelay.on('pairing', (event: WirelessPairingEvent) => {
    if (event.phase === 'paired') void markRemotePaired();
    broadcast('remote:pairing', event);
  });
  registerIpc();
  await resumeWirelessRelay();
  createWindow();
});
app.on('before-quit', () => {
  remoteGateway?.stop();
  developmentRelay.stop();
  codex.stop();
  // 貼り付けた画像の置き場は、そのセッションのあいだだけ残しておけば十分です。
  void fs.rm(attachmentTempRoot(), { recursive: true, force: true }).catch(() => undefined);
  void discardPreviews();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
