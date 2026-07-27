import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

import { findCodexExecutable, type CodexExecutable } from './findCodex';

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();
  private serverRequests = new Map<number | string, string>();

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  async start(preferredExecutable?: string): Promise<CodexExecutable> {
    if (this.running) throw new Error('Codex App Serverは既に起動しています。');

    const selected = await findCodexExecutable(preferredExecutable);
    const child = spawn(selected.executable, ['app-server'], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    readline
      .createInterface({ input: child.stdout })
      .on('line', (line) => {
        if (this.child === child) this.handleLine(line);
      });
    child.stderr.on('data', (chunk) => {
      if (this.child === child) this.emit('diagnostic', String(chunk));
    });
    child.on('error', (error) => this.handleExit(error, child));
    child.on('exit', (code) =>
      this.handleExit(
        new Error(`Codex App Serverが終了しました (code: ${String(code)})`),
        child,
      ),
    );

    await this.request('initialize', {
      clientInfo: {
        name: 'pixel_codex',
        title: 'Pixel Codex',
        version: '0.1.3',
      },
      capabilities: {},
    });
    this.notify('initialized', {});
    return selected;
  }

  async startThread(cwd: string): Promise<{ threadId: string }> {
    const result = (await this.request('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    })) as Record<string, unknown>;
    const thread = result?.thread as Record<string, unknown> | undefined;
    const threadId = String(thread?.id ?? result?.threadId ?? '');
    if (!threadId) throw new Error('CodexからthreadIdが返されませんでした。');
    return { threadId };
  }

  async sendTask(threadId: string, text: string): Promise<{ turnId?: string }> {
    const result = (await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
    })) as Record<string, unknown>;
    const turn = result?.turn as Record<string, unknown> | undefined;
    return { turnId: String(turn?.id ?? result?.turnId ?? '') || undefined };
  }

  async steerAgent(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text }],
    });
  }

  async interruptAgent(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  respondApproval(
    requestId: number | string,
    decision: 'accept' | 'decline' | 'cancel',
  ): void {
    if (!this.serverRequests.has(requestId)) {
      throw new Error('承認要求は既に処理済みです。');
    }
    this.write({ id: requestId, result: { decision } });
    this.serverRequests.delete(requestId);
  }

  respondUserInput(
    requestId: number | string,
    answers: Record<string, string[]>,
  ): void {
    const method = this.serverRequests.get(requestId);
    if (method !== 'item/tool/requestUserInput') {
      throw new Error('質問は既に回答済みです。');
    }
    const payload = Object.fromEntries(
      Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
    );
    this.write({ id: requestId, result: { answers: payload } });
    this.serverRequests.delete(requestId);
  }

  stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
    this.serverRequests.clear();
    this.rejectPending(new Error('Codex App Serverを停止しました。'));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} が30秒以内に応答しませんでした。`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) {
      throw new Error('Codex App Serverに接続されていません。');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.emit('diagnostic', `JSONとして解釈できない応答: ${line}`);
      return;
    }

    if (message.id !== undefined && !message.method) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex RPC error'));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.serverRequests.set(message.id, message.method);
      this.emit('event', {
        method: message.method,
        params: message.params,
        requestId: message.id,
      });
      return;
    }

    if (message.method) {
      this.emit('event', { method: message.method, params: message.params });
    }
  }

  private handleExit(error: Error, source: ChildProcessWithoutNullStreams): void {
    if (!this.child || this.child !== source) return;
    this.child = undefined;
    this.serverRequests.clear();
    this.rejectPending(error);
    this.emit('exit', error.message);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
