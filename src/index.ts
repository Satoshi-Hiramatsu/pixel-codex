import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import started from 'electron-squirrel-startup';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  RemoteStateSnapshot,
  SaveMeta,
  SkillScope,
  ThreadOptions,
  UsbTestSession,
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

async function loadRemoteHostId(): Promise<string> {
  const identityPath = path.join(app.getPath('userData'), 'remote-host.json');
  try {
    const stored = JSON.parse(await fs.readFile(identityPath, 'utf8')) as { hostId?: unknown };
    if (typeof stored.hostId === 'string' && /^[a-f0-9-]{36}$/i.test(stored.hostId)) {
      return stored.hostId;
    }
  } catch {
    // The first launch has no remote identity yet.
  }
  const hostId = randomUUID();
  await fs.writeFile(identityPath, JSON.stringify({ hostId }), { encoding: 'utf8', mode: 0o600 });
  return hostId;
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

async function startUsbRemoteTest(): Promise<UsbTestSession> {
  if (!remoteGateway) throw new Error('Remote Gatewayが初期化されていません。');
  const relay = await developmentRelay.start();
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
  }));
  ipcMain.handle('remote:configure', (_event, config: RemoteGatewayConfig) =>
    remoteGateway?.configure({
      enabled: config?.enabled === true,
      relayUrl: typeof config?.relayUrl === 'string' ? config.relayUrl : '',
      autoReconnect: config?.autoReconnect !== false,
    }) ?? { phase: 'error', label: 'Gateway未初期化' },
  );
  ipcMain.handle('remote:start-usb-test', () => startUsbRemoteTest());
  ipcMain.handle('remote:update-state', (_event, state: RemoteStateSnapshot) => {
    remoteGateway?.updateState(state);
  });
  ipcMain.handle('remote:acknowledge', (_event, result: RemoteInstructionResult) => {
    remoteGateway?.acknowledge(result);
  });
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
  const mainWindow = new BrowserWindow({
    height: 820,
    width: 1440,
    minHeight: 680,
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
  remoteGateway = new RemoteGateway(await loadRemoteHostId());
  remoteGateway.on('status', (status) => broadcast('remote:status', status));
  remoteGateway.on('instruction', (instruction) => broadcast('remote:instruction', instruction));
  registerIpc();
  createWindow();
});
app.on('before-quit', () => {
  remoteGateway?.stop();
  developmentRelay.stop();
  codex.stop();
  // 貼り付けた画像の置き場は、そのセッションのあいだだけ残しておけば十分です。
  void fs.rm(attachmentTempRoot(), { recursive: true, force: true }).catch(() => undefined);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
