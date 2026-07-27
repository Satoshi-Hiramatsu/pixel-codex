import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import started from 'electron-squirrel-startup';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CodexClient } from './codex/CodexClient';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (started) app.quit();
app.enableSandbox();

const codex = new CodexClient();

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
  ipcMain.handle('codex:start', (_event, executable?: string) => codex.start(executable));
  ipcMain.handle('codex:stop', () => codex.stop());
  ipcMain.handle('codex:start-thread', (_event, cwd: string) => {
    if (!path.isAbsolute(cwd)) throw new Error('作業フォルダは絶対パスで指定してください。');
    return codex.startThread(cwd);
  });
  ipcMain.handle('codex:send-task', (_event, threadId: string, text: string) => {
    if (!text.trim() || text.length > 20_000) throw new Error('指示内容が不正です。');
    return codex.sendTask(threadId, text.trim());
  });
  ipcMain.handle(
    'codex:steer',
    (_event, threadId: string, turnId: string, text: string) => {
      if (!text.trim() || text.length > 20_000) throw new Error('追加指示が不正です。');
      return codex.steerAgent(threadId, turnId, text.trim());
    },
  );
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
    minWidth: 1100,
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

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});
app.on('before-quit', () => codex.stop());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
