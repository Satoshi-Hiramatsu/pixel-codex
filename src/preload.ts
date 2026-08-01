import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type {
  CodexEvent,
  PixelCodexApi,
  RemoteGatewayStatus,
  RemoteApprovalResponse,
  RemoteInstruction,
  RemoteQuestionResponse,
  WirelessPairingEvent,
} from './types';

const api: PixelCodexApi = {
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getRemoteHostInfo: () => ipcRenderer.invoke('remote:host-info'),
  configureRemoteGateway: (config) => ipcRenderer.invoke('remote:configure', config),
  startUsbRemoteTest: () => ipcRenderer.invoke('remote:start-usb-test'),
  startWirelessRemoteTest: () => ipcRenderer.invoke('remote:start-wireless-test'),
  startWirelessPairing: () => ipcRenderer.invoke('remote:start-pairing'),
  cancelWirelessPairing: () => ipcRenderer.invoke('remote:cancel-pairing'),
  onRemotePairing: (callback) => {
    const listener = (_event: IpcRendererEvent, value: WirelessPairingEvent) => callback(value);
    ipcRenderer.on('remote:pairing', listener);
    return () => ipcRenderer.removeListener('remote:pairing', listener);
  },
  updateRemoteState: (state) => ipcRenderer.invoke('remote:update-state', state),
  acknowledgeRemoteInstruction: (result) => ipcRenderer.invoke('remote:acknowledge', result),
  setRemotePreviewSources: (enabled, sources) =>
    ipcRenderer.invoke('remote:set-preview-sources', { enabled, sources }),
  setRemoteDetail: (detail) => ipcRenderer.invoke('remote:set-detail', detail),
  getDriveStatus: () => ipcRenderer.invoke('drive:status'),
  configureDrive: (clientId, clientSecret) =>
    ipcRenderer.invoke('drive:configure', clientId, clientSecret),
  connectDrive: () => ipcRenderer.invoke('drive:connect'),
  disconnectDrive: () => ipcRenderer.invoke('drive:disconnect'),
  onRemoteStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, value: RemoteGatewayStatus) => callback(value);
    ipcRenderer.on('remote:status', listener);
    return () => ipcRenderer.removeListener('remote:status', listener);
  },
  onRemoteInstruction: (callback) => {
    const listener = (_event: IpcRendererEvent, value: RemoteInstruction) => callback(value);
    ipcRenderer.on('remote:instruction', listener);
    return () => ipcRenderer.removeListener('remote:instruction', listener);
  },
  onRemoteApproval: (callback) => {
    const listener = (_event: IpcRendererEvent, value: RemoteApprovalResponse) => callback(value);
    ipcRenderer.on('remote:approval', listener);
    return () => ipcRenderer.removeListener('remote:approval', listener);
  },
  onRemoteQuestion: (callback) => {
    const listener = (_event: IpcRendererEvent, value: RemoteQuestionResponse) => callback(value);
    ipcRenderer.on('remote:question', listener);
    return () => ipcRenderer.removeListener('remote:question', listener);
  },
  chooseWorkspace: () => ipcRenderer.invoke('app:choose-workspace'),
  chooseCodexExecutable: () => ipcRenderer.invoke('app:choose-codex'),
  listWorkspaceDirectory: (workspace, relativePath = '') =>
    ipcRenderer.invoke('workspace:list-directory', workspace, relativePath),
  openWorkspaceItem: (workspace, itemPath) =>
    ipcRenderer.invoke('workspace:open-item', workspace, itemPath),
  chooseAttachments: () => ipcRenderer.invoke('attachments:choose'),
  describeAttachments: (paths) => ipcRenderer.invoke('attachments:describe', paths),
  saveAttachment: (name, dataBase64) =>
    ipcRenderer.invoke('attachments:save', name, dataBase64),
  // ドロップされたファイルの元の場所。取れないときは中身を読んで保存する道に回します。
  getPathForFile: (file) => {
    try {
      return webUtils?.getPathForFile(file) ?? '';
    } catch {
      return '';
    }
  },
  readSkillBook: (workspace) => ipcRenderer.invoke('skills:read-book', workspace),
  saveSkill: (scope, workspace, draft) =>
    ipcRenderer.invoke('skills:save', scope, workspace, draft),
  deleteSkill: (scope, workspace, id) =>
    ipcRenderer.invoke('skills:delete', scope, workspace, id),
  setEquippedSkills: (scope, workspace, ids) =>
    ipcRenderer.invoke('skills:set-equipped', scope, workspace, ids),
  listSkillShelves: (workspaces) => ipcRenderer.invoke('skills:list-shelves', workspaces),
  askCodex: (cwd, prompt, options) => ipcRenderer.invoke('codex:ask', cwd, prompt, options),
  getRepoStatus: (workspace) => ipcRenderer.invoke('saves:status', workspace),
  initRepo: (workspace) => ipcRenderer.invoke('saves:init', workspace),
  listSaves: (workspace) => ipcRenderer.invoke('saves:list', workspace),
  createSave: (workspace, label, meta) =>
    ipcRenderer.invoke('saves:create', workspace, label, meta),
  loadSave: (workspace, commit) => ipcRenderer.invoke('saves:load', workspace, commit),
  listCodexProcesses: () => ipcRenderer.invoke('codex:list-processes'),
  terminateCodexProcesses: (pids) => ipcRenderer.invoke('codex:terminate-processes', pids),
  startCodex: (executable) => ipcRenderer.invoke('codex:start', executable),
  stopCodex: () => ipcRenderer.invoke('codex:stop'),
  startThread: (cwd, options) => ipcRenderer.invoke('codex:start-thread', cwd, options),
  sendTask: (threadId, text, attachments) =>
    ipcRenderer.invoke('codex:send-task', threadId, text, attachments),
  steerAgent: (threadId, turnId, text, attachments) =>
    ipcRenderer.invoke('codex:steer', threadId, turnId, text, attachments),
  getRateLimits: () => ipcRenderer.invoke('codex:rate-limits'),
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
