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

/** 添付のうち、Codexへ実際に送る最小限の情報。 */
export interface TurnAttachment {
  path: string;
  kind: 'image' | 'file';
}

/**
 * 古いCodexは知らない入力の種類を拒むので、そのときは文章だけで送り直します。
 * サブエージェントへの直接入力を断られた場合はやり直しても同じなので除きます。
 */
function isUnsupportedInput(error: Error): boolean {
  if (/sub-?agent|multi-?agent|direct app-server input/i.test(error.message)) return false;
  return /unknown|unrecognized|invalid|unexpected|variant|input|localImage/i.test(error.message);
}

export class CodexClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, PendingRequest>();
  private serverRequests = new Map<number | string, string>();

  get running(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  /** The app-server we spawned ourselves, so it is never offered up for killing. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(preferredExecutable?: string): Promise<CodexExecutable> {
    // 接続はサーバー起動とスレッド作成の2段階なので、後半で失敗すると
    // 子プロセスだけが残ります。それを理由に再接続を拒むと復帰できなく
    // なるため、残っていれば黙って片付けてから起動しなおします。
    if (this.child) this.stop();

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
        version: '0.1.4',
      },
      capabilities: {},
    });
    this.notify('initialized', {});
    return selected;
  }

  /**
   * Older Codex builds reject unknown `thread/start` parameters, so the model
   * and reasoning-effort settings are dropped one at a time rather than failing
   * the whole connection.
   */
  async startThread(
    cwd: string,
    options: { model?: string; effort?: string } = {},
  ): Promise<{ threadId: string }> {
    const base: Record<string, unknown> = {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    };
    const attempts: Array<Record<string, unknown>> = [];
    if (options.model && options.effort) {
      attempts.push({ ...base, model: options.model, effort: options.effort });
    }
    if (options.model) attempts.push({ ...base, model: options.model });
    attempts.push(base);

    let lastError: Error | undefined;
    for (const params of attempts) {
      try {
        const result = (await this.request('thread/start', params)) as Record<string, unknown>;
        const thread = result?.thread as Record<string, unknown> | undefined;
        const threadId = String(thread?.id ?? result?.threadId ?? '');
        if (!threadId) throw new Error('CodexからthreadIdが返されませんでした。');
        return { threadId };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!this.running) break;
        // Only a rejected parameter is worth retrying with a smaller payload;
        // a bad cwd or a crashed server would just fail three times over.
        const retryable = /unknown|unrecognized|invalid|unexpected|param|field|model|effort/i;
        if (!retryable.test(lastError.message)) break;
      }
    }
    throw lastError ?? new Error('スレッドを開始できませんでした。');
  }

  async sendTask(
    threadId: string,
    text: string,
    attachments: TurnAttachment[] = [],
  ): Promise<{ turnId?: string }> {
    const result = (await this.sendInput(
      'turn/start',
      { threadId },
      text,
      attachments,
    )) as Record<string, unknown>;
    const turn = result?.turn as Record<string, unknown> | undefined;
    return { turnId: String(turn?.id ?? result?.turnId ?? '') || undefined };
  }

  /**
   * 使用量の枠（残り何％使えるか）。対応していないCodexでは失敗するので、
   * 呼び出し側で undefined として扱えるようにしています。
   */
  async readRateLimits(): Promise<unknown> {
    return this.request('account/rateLimits/read', {});
  }

  async steerAgent(
    threadId: string,
    turnId: string,
    text: string,
    attachments: TurnAttachment[] = [],
  ): Promise<void> {
    try {
      await this.sendInput(
        'turn/steer',
        { threadId, expectedTurnId: turnId },
        text,
        attachments,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Codex refuses direct input to sub-agent threads. The renderer catches
      // this marker and relays the instruction through the root thread instead.
      if (/sub-?agent|multi-?agent|direct app-server input/i.test(message)) {
        throw new Error(
          'SUBAGENT_DIRECT_INPUT_BLOCKED: このエージェントには直接指示を送れません。',
        );
      }
      throw error;
    }
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

  /**
   * 文章と添付をまとめて送ります。画像はモデルが直接見られるように画像として
   * 添え、それ以外のファイルは本文にパスが書いてあるのでCodex側が開きます。
   * 画像入力に対応していないCodexだった場合は、文章だけで送り直します。
   */
  private async sendInput(
    method: string,
    base: Record<string, unknown>,
    text: string,
    attachments: TurnAttachment[],
  ): Promise<unknown> {
    const images = attachments
      .filter((attachment) => attachment.kind === 'image')
      .map((attachment) => ({ type: 'localImage', path: attachment.path }));
    if (images.length) {
      try {
        return await this.request(method, {
          ...base,
          input: [{ type: 'text', text }, ...images],
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!this.running || !isUnsupportedInput(failure)) throw failure;
        this.emit(
          'diagnostic',
          'このCodexは画像の添付に対応していないため、ファイルの場所だけを伝えました。',
        );
      }
    }
    return this.request(method, { ...base, input: [{ type: 'text', text }] });
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
