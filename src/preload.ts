import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CodexEvent, PixelCodexApi } from './types';

const api: PixelCodexApi = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  chooseWorkspace: () => ipcRenderer.invoke('app:choose-workspace'),
  chooseCodexExecutable: () => ipcRenderer.invoke('app:choose-codex'),
  listWorkspaceDirectory: (workspace, relativePath = '') =>
    ipcRenderer.invoke('workspace:list-directory', workspace, relativePath),
  openWorkspaceItem: (workspace, itemPath) =>
    ipcRenderer.invoke('workspace:open-item', workspace, itemPath),
  startCodex: (executable) => ipcRenderer.invoke('codex:start', executable),
  stopCodex: () => ipcRenderer.invoke('codex:stop'),
  startThread: (cwd) => ipcRenderer.invoke('codex:start-thread', cwd),
  sendTask: (threadId, text) => ipcRenderer.invoke('codex:send-task', threadId, text),
  steerAgent: (threadId, turnId, text) =>
    ipcRenderer.invoke('codex:steer', threadId, turnId, text),
  interruptAgent: (threadId, turnId) =>
    ipcRenderer.invoke('codex:interrupt', threadId, turnId),
  respondApproval: (requestId, decision) =>
    ipcRenderer.invoke('codex:respond-approval', requestId, decision),
  respondUserInput: (requestId, answers) =>
    ipcRenderer.invoke('codex:respond-user-input', requestId, answers),
  onEvent: (callback) => {
    const listener = (_event: IpcRendererEvent, value: CodexEvent) => callback(value);
    ipcRenderer.on('codex:event', listener);
    return () => ipcRenderer.removeListener('codex:event', listener);
  },
};

contextBridge.exposeInMainWorld('pixelCodex', api);
