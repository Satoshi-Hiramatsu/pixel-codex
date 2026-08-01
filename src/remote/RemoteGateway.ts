import { EventEmitter } from 'node:events';

import { RemoteCommandGuard } from './RemoteCommandGuard';
import {
  remoteEnvelope,
  type RemoteApprovalResponse,
  type RemoteGatewayConfig,
  type RemoteGatewayStatus,
  type RemoteInstruction,
  type RemoteInstructionResult,
  type RemoteQuestionResponse,
  type RemoteStateSnapshot,
} from './RemoteProtocol';

const reconnectDelayMs = 3_000;

function websocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Relay URLはwss://またはhttps://で指定してください（開発時のみlocalhostのws://可）');
  }
  return url.toString();
}

export class RemoteGateway extends EventEmitter {
  private config: RemoteGatewayConfig = { enabled: false, relayUrl: '', autoReconnect: true };
  private status: RemoteGatewayStatus = { phase: 'disabled', label: '通信停止中' };
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private state?: RemoteStateSnapshot;
  private readonly guard = new RemoteCommandGuard();

  constructor(readonly hostId: string) {
    super();
  }

  getStatus(): RemoteGatewayStatus {
    return { ...this.status };
  }

  configure(config: RemoteGatewayConfig): RemoteGatewayStatus {
    this.config = {
      enabled: config.enabled === true,
      relayUrl: typeof config.relayUrl === 'string' ? config.relayUrl.trim() : '',
      autoReconnect: config.autoReconnect !== false,
    };
    this.disconnect(false);
    if (!this.config.enabled) {
      this.setStatus({ phase: 'disabled', label: '通信停止中' });
      return this.getStatus();
    }
    if (!this.config.relayUrl) {
      this.setStatus({ phase: 'disconnected', label: 'Relay URL未設定' });
      return this.getStatus();
    }
    this.connect();
    return this.getStatus();
  }

  updateState(state: RemoteStateSnapshot): void {
    this.state = { ...state, updatedAt: Date.now() };
    this.send('state.snapshot', this.state);
  }

  acknowledge(result: RemoteInstructionResult): void {
    this.send('command.acknowledged', result, result.messageId);
  }

  stop(): void {
    this.config = { ...this.config, enabled: false };
    this.disconnect(false);
    this.setStatus({ phase: 'disabled', label: '通信停止中' });
  }

  private connect(): void {
    let url: string;
    try {
      url = websocketUrl(this.config.relayUrl);
    } catch (error) {
      this.setStatus({
        phase: 'error',
        label: '設定エラー',
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.setStatus({ phase: 'connecting', label: 'Relay接続中' });
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      const connectedAt = Date.now();
      this.setStatus({ phase: 'connected', label: 'Android通信接続済み', lastConnectedAt: connectedAt });
      this.send('host.hello', { platform: process.platform, connectedAt });
      if (this.state) this.send('state.snapshot', this.state);
    });
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.receive(event.data);
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.setStatus({ phase: 'error', label: 'Relay接続エラー', error: 'Relayへ接続できませんでした' });
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.config.enabled) return;
      this.setStatus({ phase: 'disconnected', label: 'Relay切断' });
      if (this.config.autoReconnect) {
        this.reconnectTimer = setTimeout(() => this.connect(), reconnectDelayMs);
      }
    });
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.send('command.acknowledged', { outcome: 'rejected', detail: 'JSONテキストだけを受け付けます' });
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.send('command.acknowledged', { outcome: 'rejected', detail: 'JSON形式が不正です' });
      return;
    }

    const envelope = message && typeof message === 'object'
      ? message as Record<string, unknown>
      : undefined;
    if (envelope?.type === 'state.snapshot.request'
      && envelope.version === 1
      && envelope.hostId === this.hostId) {
      if (this.state) this.send('state.snapshot', this.state);
      return;
    }

    const result = this.guard.validate(message, this.hostId);
    if (!result.command) {
      this.send('command.acknowledged', {
        messageId: typeof envelope?.messageId === 'string' ? envelope.messageId : '',
        outcome: 'rejected',
        detail: result.error ?? '指示を受け付けられませんでした',
        time: Date.now(),
      });
      return;
    }
    const { command } = result;
    if (command.kind === 'instruction') {
      this.emit('instruction', command.instruction satisfies RemoteInstruction);
      return;
    }
    if (command.kind === 'approval') {
      this.emit('approval', command.approval satisfies RemoteApprovalResponse);
      return;
    }
    this.emit('question', command.question satisfies RemoteQuestionResponse);
  }

  private send(type: string, payload: unknown, messageId?: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(remoteEnvelope(this.hostId, type, payload, messageId)));
  }

  private disconnect(scheduleReconnect: boolean): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'configuration changed');
    if (scheduleReconnect && this.config.enabled && this.config.autoReconnect) {
      this.reconnectTimer = setTimeout(() => this.connect(), reconnectDelayMs);
    }
  }

  private setStatus(status: RemoteGatewayStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }
}
