import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  findPlan,
  formatTokens,
  jpyCost,
  planPrices,
  pricingPlans,
  splitYen,
  totalTokens,
} from './costs';
import { PhaserCanvas } from './game/PhaserCanvas';
import { useAgentStore } from './stores/agentStore';
import type { AgentProfile, AgentState, WorkspaceEntry } from './types';

const agentColors = [0xf0bd55, 0x65b7d8, 0xe1775b, 0x78b56c, 0xb58bd4, 0xe09cb2];
const recentWorkspacesKey = 'pixel-codex-recent-workspaces';
const recentWorkspaceLimit = 8;

const statusLabels: Record<AgentState['status'], string> = {
  idle: '待機中',
  planning: '計画中',
  researching: '調査中',
  coding: '実装中',
  running: '実行中',
  approval: '承認待ち',
  done: '完了',
  error: 'エラー',
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '予期しないエラーが発生しました。';
}

function shortId(value?: string): string {
  if (!value) return '未接続';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function fileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Rolls the displayed yen towards the real total so the counter feels like a scoreboard. */
function useCountUp(target: number, duration = 900): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  displayRef.current = display;

  useEffect(() => {
    const from = displayRef.current;
    if (Math.abs(target - from) < 0.0005) {
      setDisplay(target);
      return undefined;
    }
    const startedAt = performance.now();
    let frame = 0;
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplay(from + (target - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return display;
}

function hexColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function loadRecentWorkspaces(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(recentWorkspacesKey) ?? '[]');
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, recentWorkspaceLimit)
      : [];
  } catch {
    return [];
  }
}

export function App(): React.JSX.Element {
  const {
    agents,
    selectedAgentId,
    connection,
    connectionLabel,
    workspace,
    rootThreadId,
    logs,
    messages,
    deliverables,
    approval,
    questionRequest,
    agentProfiles,
    usage,
    usageByThread,
    usageUpdatedAt,
    costSettings,
    setCostSettings,
    resetUsage,
    selectAgent,
    setWorkspace,
    setConnection,
    setRootThread,
    addLog,
    addMessage,
    handleCodexEvent,
    clearApproval,
    clearQuestion,
    resetWorkspaceSession,
    hireAgentProfile,
    dismissAgentProfile,
    createAgentProfile,
    removeAgentProfile,
  } = useAgentStore();
  const [task, setTask] = useState('調査、実装、テストを別々のサブエージェントに担当させてください。');
  const [steerText, setSteerText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [workspaceHistoryOpen, setWorkspaceHistoryOpen] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [codexExecutable, setCodexExecutable] = useState('');
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [blackboardOpen, setBlackboardOpen] = useState(false);
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryPath, setLibraryPath] = useState('');
  const [libraryEntries, setLibraryEntries] = useState<WorkspaceEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentDraft, setAgentDraft] = useState<
    Pick<AgentProfile, 'name' | 'job' | 'specialty' | 'personality' | 'color'>
  >({
    name: '',
    job: '',
    specialty: '',
    personality: '',
    color: agentColors[1],
  });
  const conversationRef = useRef<HTMLDivElement>(null);
  const autoOpenedReportId = useRef('');
  const initialWorkspace = useRef(recentWorkspaces[0]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );
  const finalReports = useMemo(
    () => messages.filter((message) => message.role === 'assistant' && message.phase === 'final_answer'),
    [messages],
  );
  const latestReport = finalReports[finalReports.length - 1];
  const latestReportAgent = useMemo(
    () => latestReport
      ? agents.find(
          (agent) => agent.id === latestReport.agentId || agent.threadId === latestReport.agentId,
        )
      : undefined,
    [agents, latestReport],
  );
  const hiredProfiles = useMemo(
    () => agentProfiles.filter((profile) => profile.hired),
    [agentProfiles],
  );
  const totalYen = useMemo(() => jpyCost(usage, costSettings), [usage, costSettings]);
  const animatedYen = useCountUp(totalYen);
  const yenDigits = splitYen(animatedYen);
  const prices = useMemo(() => planPrices(costSettings), [costSettings]);
  const activePlan = findPlan(costSettings.planId);
  const usedTokens = totalTokens(usage);
  const freshInput = Math.max(0, usage.input - Math.min(usage.cachedInput, usage.input));
  // The gauge fills towards the next round 100 yen, which keeps it lively even
  // when the amounts are tiny.
  const milestone = Math.max(100, Math.ceil((totalYen + 1) / 100) * 100);
  const milestoneRatio = Math.min(1, totalYen / milestone);
  const earningsByAgent = useMemo(
    () =>
      Object.entries(usageByThread)
        .map(([threadId, entry]) => {
          const agent = agents.find(
            (candidate) => candidate.id === threadId || candidate.threadId === threadId,
          );
          return {
            threadId,
            name: agent?.name ?? '退勤したスタッフ',
            role: agent?.role ?? '過去のスレッド',
            color: agent?.color ?? 0x94a0a0,
            usage: entry.usage,
            yen: jpyCost(entry.usage, costSettings),
          };
        })
        .sort((left, right) => right.yen - left.yen),
    [usageByThread, agents, costSettings],
  );
  const approvalAgent = useMemo(
    () =>
      approval
        ? agents.find(
            (agent) => agent.id === approval.agentId || agent.threadId === approval.agentId,
          )
        : undefined,
    [agents, approval],
  );
  const libraryCrumbs = useMemo(() => {
    const parts = libraryPath.split(/[\\/]/).filter(Boolean);
    return [
      { name: '図書館', path: '' },
      ...parts.map((part, index) => ({ name: part, path: parts.slice(0, index + 1).join('/') })),
    ];
  }, [libraryPath]);

  useEffect(() => {
    window.pixelCodex
      .getAppInfo()
      .then((info) => {
        setWorkspace(initialWorkspace.current ?? info.cwd);
        setAppVersion(info.version);
      })
      .catch((error) => setNotice(errorMessage(error)));
    return window.pixelCodex.onEvent(handleCodexEvent);
  }, [handleCodexEvent, setWorkspace]);

  useEffect(() => {
    const element = conversationRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, questionRequest]);

  useEffect(() => {
    setQuestionAnswers({});
  }, [questionRequest?.requestId]);

  useEffect(() => {
    if (latestReport && autoOpenedReportId.current !== latestReport.id) {
      autoOpenedReportId.current = latestReport.id;
      setBlackboardOpen(true);
    }
  }, [latestReport]);

  async function connect(executable?: string, targetWorkspace = workspace): Promise<void> {
    if (!targetWorkspace) {
      setNotice('先に作業フォルダを選択してください。');
      return;
    }
    setBusy(true);
    setNotice('');
    setConnection('connecting', '接続中');
    try {
      const result = await window.pixelCodex.startCodex(executable);
      setCodexExecutable(result.executable);
      setConnection('connected', 'Codex接続済み');
      addLog(
        `Codex App Serverに接続しました: ${result.version} (${result.executable})`,
        'success',
      );
      const thread = await window.pixelCodex.startThread(targetWorkspace);
      setRootThread(thread.threadId);
      rememberWorkspace(targetWorkspace);
      addLog('統括エージェントのスレッドを作成しました', 'success', thread.threadId);
    } catch (error) {
      const message = errorMessage(error);
      setConnection('error', '接続エラー');
      setNotice(message);
      addLog(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function chooseExecutable(): Promise<void> {
    const selectedPath = await window.pixelCodex.chooseCodexExecutable();
    if (selectedPath) await connect(selectedPath);
  }

  async function chooseWorkspace(): Promise<void> {
    const selectedPath = await window.pixelCodex.chooseWorkspace();
    if (!selectedPath) return;
    setWorkspaceHistoryOpen(false);
    await switchWorkspace(selectedPath);
  }

  async function switchWorkspace(selectedPath: string): Promise<void> {
    if (selectedPath === workspace) return;
    const shouldReconnect = connection === 'connected' || connection === 'connecting';
    setBusy(true);
    setNotice('');
    try {
      if (shouldReconnect) {
        setConnection('connecting', 'フォルダ切替中');
        await window.pixelCodex.stopCodex();
        resetWorkspaceSession();
      }
      setWorkspace(selectedPath);
      addLog(`作業フォルダを変更しました: ${selectedPath}`);
      if (shouldReconnect) {
        await connect(codexExecutable || undefined, selectedPath);
      }
    } catch (error) {
      const message = errorMessage(error);
      setConnection('error', '再接続エラー');
      setNotice(message);
      addLog(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function rememberWorkspace(targetWorkspace: string): void {
    setRecentWorkspaces((current) => {
      const normalized = targetWorkspace.toLocaleLowerCase();
      const next = [
        targetWorkspace,
        ...current.filter((entry) => entry.toLocaleLowerCase() !== normalized),
      ].slice(0, recentWorkspaceLimit);
      window.localStorage.setItem(recentWorkspacesKey, JSON.stringify(next));
      return next;
    });
  }

  function forgetWorkspace(targetWorkspace: string): void {
    setRecentWorkspaces((current) => {
      const normalized = targetWorkspace.toLocaleLowerCase();
      const next = current.filter((entry) => entry.toLocaleLowerCase() !== normalized);
      window.localStorage.setItem(recentWorkspacesKey, JSON.stringify(next));
      return next;
    });
  }

  async function browseLibrary(relativePath = ''): Promise<void> {
    if (!workspace) {
      setNotice('先に作業フォルダを選択してください。');
      return;
    }
    setLibraryLoading(true);
    setLibraryError('');
    try {
      const entries = await window.pixelCodex.listWorkspaceDirectory(workspace, relativePath);
      setLibraryEntries(entries);
      setLibraryPath(relativePath);
    } catch (error) {
      setLibraryError(errorMessage(error));
    } finally {
      setLibraryLoading(false);
    }
  }

  async function showLibrary(): Promise<void> {
    setLibraryOpen(true);
    await browseLibrary('');
  }

  async function openWorkspaceItem(itemPath: string): Promise<void> {
    try {
      await window.pixelCodex.openWorkspaceItem(workspace, itemPath);
      addLog(`データを開きました: ${itemPath}`, 'success');
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      addLog(message, 'error');
    }
  }

  function openLibraryEntry(entry: WorkspaceEntry): void {
    if (entry.kind === 'directory') {
      void browseLibrary(entry.relativePath);
      return;
    }
    void openWorkspaceItem(entry.relativePath);
  }

  async function submitTask(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!task.trim() || busy) return;
    if (connection !== 'connected') {
      setNotice('先にCodexへ接続してください。現在は画面確認用のデモ表示です。');
      return;
    }
    setBusy(true);
    try {
      let threadId = rootThreadId;
      if (!threadId) {
        const result = await window.pixelCodex.startThread(workspace);
        threadId = result.threadId;
        setRootThread(threadId);
      }
      const availableTeam = hiredProfiles.filter((profile) => profile.id !== 'manager-profile');
      const staffingInstruction = availableTeam.length
        ? [
            '',
            '[Pixel Codexの雇用チーム]',
            '必要な担当だけをサブエージェントとして起動してください。起動時の依頼には社員名と役割を明記してください。',
            ...availableTeam.map(
              (profile) =>
                `- ${profile.name} / ${profile.job}: 得意=${profile.specialty}; 人柄=${profile.personality}`,
            ),
          ].join('\n')
        : '';
      await window.pixelCodex.sendTask(threadId, `${task.trim()}${staffingInstruction}`);
      addMessage({ agentId: threadId, role: 'user', text: task.trim() });
      const managerName = agents.find(
        (agent) => agent.id === threadId || agent.threadId === threadId,
      )?.name ?? '企画一郎';
      addLog(`${managerName}へ新しいタスクを送りました`, 'success', threadId);
      setTask('');
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      addLog(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function steerSelected(): Promise<void> {
    if (!selected?.threadId || !selected.turnId || !steerText.trim()) return;
    setBusy(true);
    try {
      await window.pixelCodex.steerAgent(selected.threadId, selected.turnId, steerText.trim());
      addMessage({ agentId: selected.id, role: 'user', text: steerText.trim() });
      addLog('追加指示を送りました', 'success', selected.id);
      setSteerText('');
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      addLog(message, 'error', selected.id);
    } finally {
      setBusy(false);
    }
  }

  async function interruptSelected(): Promise<void> {
    if (!selected?.threadId || !selected.turnId) return;
    try {
      await window.pixelCodex.interruptAgent(selected.threadId, selected.turnId);
      addLog('停止要求を送りました', 'warning', selected.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function respondApproval(decision: 'accept' | 'decline'): Promise<void> {
    if (!approval) return;
    try {
      await window.pixelCodex.respondApproval(approval.requestId, decision);
      addLog(decision === 'accept' ? '操作を承認しました' : '操作を拒否しました', decision === 'accept' ? 'success' : 'warning', approval.agentId);
      clearApproval();
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function respondToQuestion(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!questionRequest) return;
    const unanswered = questionRequest.questions.some(
      (question) => !questionAnswers[question.id]?.trim(),
    );
    if (unanswered) {
      setNotice('すべての質問に回答してください。');
      return;
    }
    setBusy(true);
    try {
      const answers = Object.fromEntries(
        questionRequest.questions.map((question) => [
          question.id,
          [questionAnswers[question.id].trim()],
        ]),
      );
      await window.pixelCodex.respondUserInput(questionRequest.requestId, answers);
      addMessage({
        agentId: questionRequest.agentId,
        role: 'user',
        text: questionRequest.questions
          .map((question) => `${question.header}: ${questionAnswers[question.id].trim()}`)
          .join('\n'),
      });
      addLog('AIの質問に回答しました', 'success', questionRequest.agentId);
      clearQuestion();
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      addLog(message, 'error', questionRequest.agentId);
    } finally {
      setBusy(false);
    }
  }

  function submitNewAgent(event: React.FormEvent): void {
    event.preventDefault();
    if (
      !agentDraft.name.trim() ||
      !agentDraft.job.trim() ||
      !agentDraft.specialty.trim() ||
      !agentDraft.personality.trim()
    ) {
      setNotice('新しいエージェントの項目をすべて入力してください。');
      return;
    }
    createAgentProfile({
      ...agentDraft,
      name: agentDraft.name.trim(),
      job: agentDraft.job.trim(),
      specialty: agentDraft.specialty.trim(),
      personality: agentDraft.personality.trim(),
    });
    addLog(`${agentDraft.name.trim()}を新しく雇用しました`, 'success');
    setAgentDraft({
      name: '',
      job: '',
      specialty: '',
      personality: '',
      color: agentColors[Math.floor(Math.random() * agentColors.length)],
    });
    setCreatingAgent(false);
  }

  const activeCount = agents.filter((agent) =>
    ['planning', 'researching', 'coding', 'running'].includes(agent.status),
  ).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><i /><i /><i /><i /></span>
          <div>
            <h1>PIXEL CODEX STUDIO</h1>
            <p>AGENT DEVELOPMENT COMPANY</p>
          </div>
        </div>
        <div className="workspace-switcher">
          <button
            className="workspace-button"
            type="button"
            onClick={() => setWorkspaceHistoryOpen((value) => !value)}
            disabled={busy}
          >
            <span>WORKSPACE <i>{workspaceHistoryOpen ? '▲' : '▼'}</i></span>
            <strong title={workspace}>{workspace || 'フォルダを選択'}</strong>
          </button>
          {workspaceHistoryOpen && (
            <section className="workspace-history" aria-label="最近接続したフォルダ">
              <header><strong>最近接続したフォルダ</strong><small>{recentWorkspaces.length}件</small></header>
              <div className="workspace-history-list">
                {recentWorkspaces.map((entry) => (
                  <div className={entry === workspace ? 'current' : ''} key={entry}>
                    <button
                      type="button"
                      title={entry}
                      onClick={() => {
                        setWorkspaceHistoryOpen(false);
                        void switchWorkspace(entry);
                      }}
                    >
                      <span>{fileName(entry)}</span>
                      <small>{entry}</small>
                    </button>
                    <button
                      className="forget-workspace"
                      type="button"
                      title="履歴から削除"
                      aria-label={`${entry}を履歴から削除`}
                      onClick={() => forgetWorkspace(entry)}
                    >×</button>
                  </div>
                ))}
                {recentWorkspaces.length === 0 && <p>接続履歴はまだありません。</p>}
              </div>
              <button className="choose-new-workspace" type="button" onClick={() => void chooseWorkspace()}>
                ＋ 別のフォルダを選択
              </button>
            </section>
          )}
        </div>
        <div className="game-menu-buttons">
          <button className="library-button" type="button" onClick={() => void showLibrary()}>
            <span>図書館</span>
            <strong>本</strong>
          </button>
          <button className="staff-button" type="button" onClick={() => setStaffOpen(true)}>
            <span>社員名簿</span>
            <strong>{hiredProfiles.length}</strong>
          </button>
          <button
            className={`blackboard-button ${deliverables.length ? 'has-results' : ''}`}
            type="button"
            onClick={() => setBlackboardOpen(true)}
          >
            <span>成果物</span>
            <strong>{deliverables.length}</strong>
          </button>
        </div>
        <div className="connection-box">
          <span className={`connection-dot ${connection}`} />
          <div><small>APP SERVER</small><strong>{connectionLabel}</strong></div>
          <button type="button" onClick={() => connect()} disabled={busy || connection === 'connected'}>
            {connection === 'connected' ? '接続済み' : '接続'}
          </button>
          <button className="icon-button" type="button" title="Codex実行ファイルを選択" onClick={chooseExecutable}>…</button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="alert">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')}>×</button>
        </div>
      )}

      <section className="payroll-bar" aria-label="発生報酬額メーター">
        <span className="payroll-coin" key={usageUpdatedAt} aria-hidden="true">￥</span>
        <div className="payroll-readout">
          <span className="payroll-caption">ただいまの発生報酬額</span>
          <strong className="payroll-amount" aria-live="polite">
            <i>￥</i>
            <span className="payroll-digits">{yenDigits.main}</span>
            <em>.{yenDigits.fraction}</em>
            <b>円</b>
          </strong>
        </div>
        <div className="payroll-gauge">
          <div className="payroll-gauge-track">
            <div className="payroll-gauge-fill" style={{ width: `${milestoneRatio * 100}%` }} />
          </div>
          <small>
            つぎの目盛りまで あと ￥{Math.max(0, milestone - totalYen).toFixed(2)}
            <span>（{milestone.toLocaleString('ja-JP')}円）</span>
          </small>
        </div>
        <dl className="payroll-tokens">
          <div><dt>入力</dt><dd>{formatTokens(usage.input)}</dd></div>
          <div><dt>出力</dt><dd>{formatTokens(usage.output)}</dd></div>
          <div><dt>合計</dt><dd>{formatTokens(usedTokens)}</dd></div>
        </dl>
        <button className="payroll-open" type="button" onClick={() => setPayrollOpen(true)}>
          明細をひらく →
        </button>
      </section>

      <section className="dashboard">
        <div className="office-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">DEV STUDIO</span><h2>開発フロア</h2></div>
            <div className="office-stats">
              <span><b>{agents.length}</b> 出勤</span>
              <span><b>{activeCount}</b> 稼働中</span>
              <span><b>{agents.filter((agent) => agent.status === 'approval').length}</b> 承認待ち</span>
            </div>
          </div>
          <div className="office-stage">
            <PhaserCanvas />
            <section className="floor-roster" aria-label="出勤名簿">
              <header>
                <div><span>ATTENDANCE</span><h3>出勤名簿</h3></div>
                <strong>{agents.length}名</strong>
              </header>
              <div className="floor-roster-list">
                {agents.map((agent, index) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={`floor-roster-row ${agent.id === selected?.id ? 'selected' : ''}`}
                    onClick={() => selectAgent(agent.id)}
                  >
                    <span className="roster-number">{String(index + 1).padStart(2, '0')}</span>
                    <span className="avatar" style={{ '--agent-color': `#${agent.color.toString(16).padStart(6, '0')}` } as React.CSSProperties}><i /></span>
                    <span className="agent-copy"><strong>{agent.name}</strong><small>{agent.role}</small></span>
                    <span className={`status-dot ${agent.status}`} title={statusLabels[agent.status]} />
                  </button>
                ))}
              </div>
              <footer><span>● 稼働状況</span><strong>{activeCount}/{agents.length}</strong></footer>
            </section>
          </div>
          <form className="task-composer" onSubmit={submitTask}>
            <div className="composer-label"><span>NEW PROJECT</span><small>新しい開発を始める</small></div>
            <textarea value={task} onChange={(event) => setTask(event.target.value)} rows={2} placeholder="実現したいことを入力…" />
            <button className="primary-button" type="submit" disabled={busy || !task.trim()}>
              {busy ? '送信中…' : '開始 →'}
            </button>
          </form>
        </div>

        <aside className="sidebar">
          {selected && (
            <section className="panel detail-panel">
              <div className="detail-title"><div><span className="eyebrow">STAFF PROFILE</span><h2>{selected.name}</h2></div><span className={`status-pill ${selected.status}`}>{statusLabels[selected.status]}</span></div>
              <dl>
                <div><dt>担当</dt><dd>{selected.role}</dd></div>
                <div><dt>現在の仕事</dt><dd>{selected.task}</dd></div>
                <div><dt>動作</dt><dd>{selected.activity}</dd></div>
                <div><dt>THREAD</dt><dd className="mono" title={selected.threadId}>{shortId(selected.threadId)}</dd></div>
              </dl>
              <textarea value={steerText} onChange={(event) => setSteerText(event.target.value)} rows={3} placeholder="このエージェントへ追加指示…" disabled={!selected.threadId || !selected.turnId} />
              <div className="detail-actions">
                <button className="secondary-button" type="button" disabled={busy || !selected.threadId || !selected.turnId || !steerText.trim()} onClick={steerSelected}>追加指示</button>
                <button className="danger-button" type="button" disabled={!selected.threadId || !selected.turnId} onClick={interruptSelected}>停止</button>
              </div>
            </section>
          )}

          <section className="panel conversation-panel">
            <div className="panel-heading compact">
              <div><span className="eyebrow">TEAM MEETING</span><h2>会議・回答</h2></div>
              <span className="conversation-count">{messages.length}</span>
            </div>
            <div className="conversation-list" ref={conversationRef} aria-live="polite">
              {messages.length === 0 && (
                <p className="conversation-empty">AIからのメッセージはまだありません。</p>
              )}
              {messages.map((message) => {
                const agent = agents.find((entry) => entry.id === message.agentId || entry.threadId === message.agentId);
                const label = message.role === 'user'
                  ? 'あなた'
                  : message.role === 'question'
                    ? `${agent?.name ?? 'AI'}からの質問`
                    : agent?.name ?? 'AI';
                return (
                  <article className={`conversation-message ${message.role}`} key={message.id}>
                    <header>
                      <strong>{label}</strong>
                      {message.phase === 'final_answer' && <span>最終回答</span>}
                      <time>{new Date(message.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time>
                    </header>
                    <p>{message.text}</p>
                  </article>
                );
              })}
            </div>
            {questionRequest && (
              <form className="question-form" onSubmit={respondToQuestion}>
                {questionRequest.questions.map((question) => (
                  <fieldset key={question.id}>
                    <legend>{question.header}</legend>
                    <p>{question.question}</p>
                    {question.options && (
                      <div className="question-options">
                        {question.options.map((option) => (
                          <button
                            className={questionAnswers[question.id] === option.label ? 'selected' : ''}
                            key={option.label}
                            type="button"
                            title={option.description}
                            onClick={() => setQuestionAnswers((current) => ({ ...current, [question.id]: option.label }))}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <input
                      type={question.isSecret ? 'password' : 'text'}
                      value={questionAnswers[question.id] ?? ''}
                      onChange={(event) => setQuestionAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      placeholder="回答を入力…"
                    />
                  </fieldset>
                ))}
                <button className="primary-button" type="submit" disabled={busy}>回答を送信</button>
              </form>
            )}
          </section>

          <section className="panel log-panel">
            <div className="panel-heading compact"><div><span className="eyebrow">OFFICE LOG</span><h2>社内ログ</h2></div></div>
            <div className="log-list">
              {logs.slice(0, 12).map((log) => (
                <div className={`log-entry ${log.level}`} key={log.id}>
                  <time>{new Date(log.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  <p>{log.message}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      <footer><span>PIXEL CODEX STUDIO v{appVersion}</span><span>社員を雇用して、開発チームを育てよう</span></footer>

      {staffOpen && (
        <div
          className="staff-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setStaffOpen(false);
          }}
        >
          <section className="staff-window" role="dialog" aria-modal="true" aria-labelledby="staff-title">
            <header className="game-window-titlebar">
              <div className="title-icon">社</div>
              <div>
                <span>AGENT MANAGEMENT</span>
                <h2 id="staff-title">社員名簿・人材センター</h2>
              </div>
              <button type="button" aria-label="社員名簿を閉じる" onClick={() => setStaffOpen(false)}>×</button>
            </header>
            <div className="staff-stats">
              <span><b>{hiredProfiles.length}</b> 雇用中</span>
              <span><b>{agentProfiles.filter((profile) => !profile.hired).length}</b> 候補者</span>
              <span><b>{agentProfiles.filter((profile) => profile.custom).length}</b> オリジナル</span>
              <button type="button" onClick={() => setCreatingAgent((value) => !value)}>
                {creatingAgent ? '作成を閉じる' : '＋ 新規エージェント作成'}
              </button>
            </div>
            <div className="staff-content">
              <section className="staff-column hired-column">
                <div className="game-section-title"><span>01</span><h3>使えるエージェント</h3></div>
                <div className="staff-card-list">
                  {hiredProfiles.map((profile) => (
                    <article className="staff-card hired" key={profile.id}>
                      <span
                        className="staff-pixel-avatar"
                        style={{ '--staff-color': `#${profile.color.toString(16).padStart(6, '0')}` } as React.CSSProperties}
                      ><i /></span>
                      <div className="staff-card-copy">
                        <header><strong>{profile.name}</strong><span>出勤OK</span></header>
                        <h4>{profile.job}</h4>
                        <p>{profile.specialty}</p>
                        <small>{profile.personality}</small>
                      </div>
                      {profile.id !== 'manager-profile' && (
                        <div className="staff-card-actions">
                          <button
                            type="button"
                            onClick={() => {
                              dismissAgentProfile(profile.id);
                              addLog(`${profile.name}との契約を解除しました`, 'warning');
                            }}
                          >契約解除</button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              <section className="staff-column candidate-column">
                <div className="game-section-title"><span>02</span><h3>おすすめ人材</h3></div>
                {creatingAgent && (
                  <form className="agent-create-form" onSubmit={submitNewAgent}>
                    <div className="form-banner">オリジナル社員を作成して、そのまま雇用します</div>
                    <label>名前<input value={agentDraft.name} onChange={(event) => setAgentDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="例: Planner" /></label>
                    <label>職種<input value={agentDraft.job} onChange={(event) => setAgentDraft((draft) => ({ ...draft, job: event.target.value }))} placeholder="例: 設計担当" /></label>
                    <label>得意な仕事<textarea rows={2} value={agentDraft.specialty} onChange={(event) => setAgentDraft((draft) => ({ ...draft, specialty: event.target.value }))} placeholder="要件整理、設計、ドキュメント作成" /></label>
                    <label>性格<textarea rows={2} value={agentDraft.personality} onChange={(event) => setAgentDraft((draft) => ({ ...draft, personality: event.target.value }))} placeholder="丁寧で、先回りして考える" /></label>
                    <fieldset className="agent-color-picker">
                      <legend>服の色</legend>
                      {agentColors.map((color) => (
                        <button
                          className={agentDraft.color === color ? 'selected' : ''}
                          key={color}
                          type="button"
                          style={{ '--swatch': `#${color.toString(16).padStart(6, '0')}` } as React.CSSProperties}
                          onClick={() => setAgentDraft((draft) => ({ ...draft, color }))}
                          aria-label={`色 ${color.toString(16)}`}
                        />
                      ))}
                    </fieldset>
                    <button className="game-primary-button" type="submit">この人材を作成・雇用</button>
                  </form>
                )}
                <div className="staff-card-list">
                  {agentProfiles.filter((profile) => !profile.hired).map((profile) => (
                    <article className="staff-card candidate" key={profile.id}>
                      <span
                        className="staff-pixel-avatar"
                        style={{ '--staff-color': `#${profile.color.toString(16).padStart(6, '0')}` } as React.CSSProperties}
                      ><i /></span>
                      <div className="staff-card-copy">
                        <header><strong>{profile.name}</strong><span>{profile.recommended ? 'おすすめ' : '登録済み'}</span></header>
                        <h4>{profile.job}</h4>
                        <p>{profile.specialty}</p>
                        <small>{profile.personality}</small>
                      </div>
                      <div className="staff-card-actions">
                        <button
                          className="hire-button"
                          type="button"
                          onClick={() => {
                            hireAgentProfile(profile.id);
                            addLog(`${profile.name}を雇用しました`, 'success');
                          }}
                        >雇用する</button>
                        {profile.custom && (
                          <button type="button" onClick={() => removeAgentProfile(profile.id)}>登録削除</button>
                        )}
                      </div>
                    </article>
                  ))}
                  {agentProfiles.every((profile) => profile.hired) && (
                    <p className="staff-empty">候補者は全員雇用済みです。</p>
                  )}
                </div>
              </section>
            </div>
          </section>
        </div>
      )}

      {libraryOpen && (
        <div
          className="library-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLibraryOpen(false);
          }}
        >
          <section className="library-window" role="dialog" aria-modal="true" aria-labelledby="library-title">
            <header className="game-window-titlebar library-titlebar">
              <div className="title-icon">本</div>
              <div>
                <span>WORKSPACE LIBRARY</span>
                <h2 id="library-title">プロジェクト図書館</h2>
              </div>
              <button type="button" aria-label="図書館を閉じる" onClick={() => setLibraryOpen(false)}>×</button>
            </header>
            <div className="library-toolbar">
              <button
                type="button"
                disabled={!libraryPath || libraryLoading}
                onClick={() => {
                  const parts = libraryPath.split(/[\\/]/).filter(Boolean);
                  void browseLibrary(parts.slice(0, -1).join('/'));
                }}
              >← 戻る</button>
              <nav aria-label="現在のフォルダ">
                {libraryCrumbs.map((crumb, index) => (
                  <React.Fragment key={crumb.path || 'root'}>
                    {index > 0 && <span>›</span>}
                    <button type="button" onClick={() => void browseLibrary(crumb.path)}>{crumb.name}</button>
                  </React.Fragment>
                ))}
              </nav>
              <button type="button" disabled={libraryLoading} onClick={() => void browseLibrary(libraryPath)}>更新</button>
              <button type="button" onClick={() => void openWorkspaceItem(libraryPath)}>フォルダを開く</button>
            </div>
            <div className="library-shelf">
              {libraryLoading ? (
                <p className="library-message">本棚を整理しています…</p>
              ) : libraryError ? (
                <p className="library-message error">{libraryError}</p>
              ) : libraryEntries.length === 0 ? (
                <p className="library-message">この棚にはまだデータがありません。</p>
              ) : (
                <div className="library-entry-list">
                  {libraryEntries.map((entry) => (
                    <button
                      className={`library-entry ${entry.kind}`}
                      key={entry.relativePath}
                      type="button"
                      title={entry.relativePath}
                      onClick={() => openLibraryEntry(entry)}
                    >
                      <span className="library-entry-icon">{entry.kind === 'directory' ? '▣' : '▤'}</span>
                      <span className="library-entry-name">{entry.name}</span>
                      <span className="library-entry-meta">
                        {entry.kind === 'directory' ? 'フォルダ' : fileSize(entry.size)}
                      </span>
                      <time>{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleDateString('ja-JP') : '―'}</time>
                      <span className="library-entry-action">{entry.kind === 'directory' ? '棚を見る →' : '開く ↗'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <footer className="library-footer">
              <span>{libraryEntries.length} 件</span>
              <span title={workspace}>{workspace}</span>
            </footer>
          </section>
        </div>
      )}

      {blackboardOpen && (
        <div
          className="blackboard-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setBlackboardOpen(false);
          }}
        >
          <section className="blackboard-window" role="dialog" aria-modal="true" aria-labelledby="blackboard-title">
            <header className="blackboard-titlebar">
              <div>
                <span>DELIVERABLES</span>
                <h2 id="blackboard-title">今回の成果物</h2>
              </div>
              <button type="button" aria-label="成果物ボードを閉じる" onClick={() => setBlackboardOpen(false)}>×</button>
            </header>
            <div className="chalkboard">
              <div className="chalkboard-summary">
                <span><b>{deliverables.length}</b> ファイル</span>
                <span><b>{finalReports.length}</b> 完了報告</span>
              </div>
              <div className="chalkboard-grid">
                <section className="chalk-section">
                  <h3>できあがったもの</h3>
                  {deliverables.length === 0 ? (
                    <p className="chalk-empty">作業が完了すると、ここに成果物が並びます。</p>
                  ) : (
                    <ul className="deliverable-list">
                      {[...deliverables].reverse().map((deliverable) => (
                        <li key={deliverable.id}>
                          <span className={`chalk-check ${deliverable.kind}`}>✓</span>
                          <div>
                            <strong>{fileName(deliverable.path)}</strong>
                            <small title={deliverable.path}>{deliverable.path}</small>
                          </div>
                          <em>
                            {deliverable.kind === 'created'
                              ? '新しく作成'
                              : deliverable.kind === 'deleted'
                                ? '削除'
                                : '更新'}
                          </em>
                          <button
                            className="deliverable-open-button"
                            type="button"
                            disabled={deliverable.kind === 'deleted'}
                            onClick={() => void openWorkspaceItem(deliverable.path)}
                          >{deliverable.kind === 'deleted' ? '削除済み' : '開く'}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="chalk-section report-section">
                  <h3>{latestReportAgent?.name ?? '担当エージェント'}からの完了報告</h3>
                  {latestReport ? (
                    <p className="chalk-report">{latestReport.text}</p>
                  ) : (
                    <p className="chalk-empty">まだ完了報告はありません。みんなで作業中です。</p>
                  )}
                </section>
              </div>
            </div>
            <div className="chalk-tray"><i /><i /><i /><span>PIXEL CODEX CLASSROOM</span></div>
          </section>
        </div>
      )}

      {payrollOpen && (
        <div
          className="payroll-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPayrollOpen(false);
          }}
        >
          <section className="payroll-window" role="dialog" aria-modal="true" aria-labelledby="payroll-title">
            <header className="game-window-titlebar payroll-titlebar">
              <div className="title-icon">￥</div>
              <div>
                <span>TOKEN PAYROLL</span>
                <h2 id="payroll-title">給与明細・トークン使用量</h2>
              </div>
              <button type="button" aria-label="明細を閉じる" onClick={() => setPayrollOpen(false)}>×</button>
            </header>

            <div className="payroll-hero">
              <span className="payroll-hero-caption">ただいまの発生報酬額</span>
              <strong className="payroll-hero-amount">
                <i>￥</i>{yenDigits.main}<em>.{yenDigits.fraction}</em><b>円</b>
              </strong>
              <p className="payroll-hero-note">
                {activePlan.id === 'chatgpt-plan'
                  ? '定額プランなので、使っても追加のお金はかかりません。'
                  : `${formatTokens(usedTokens)} トークン働きました（1ドル ${costSettings.jpyPerUsd} 円で換算）`}
              </p>
            </div>

            <div className="payroll-content">
              <section className="payroll-panel">
                <div className="game-section-title"><span>01</span><h3>お金の内訳</h3></div>
                <table className="payroll-table">
                  <thead>
                    <tr><th>種類</th><th>トークン</th><th>単価(100万あたり)</th><th>金額</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>入力（新しく読んだ分）</td>
                      <td>{freshInput.toLocaleString('ja-JP')}</td>
                      <td>${prices.input}</td>
                      <td>￥{((freshInput / 1_000_000) * prices.input * costSettings.jpyPerUsd).toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td>入力（使い回した分）</td>
                      <td>{Math.min(usage.cachedInput, usage.input).toLocaleString('ja-JP')}</td>
                      <td>${prices.cachedInput}</td>
                      <td>￥{((Math.min(usage.cachedInput, usage.input) / 1_000_000) * prices.cachedInput * costSettings.jpyPerUsd).toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td>出力（書いた分）</td>
                      <td>{usage.output.toLocaleString('ja-JP')}</td>
                      <td>${prices.output}</td>
                      <td>￥{((usage.output / 1_000_000) * prices.output * costSettings.jpyPerUsd).toFixed(2)}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr><td>合計</td><td>{usedTokens.toLocaleString('ja-JP')}</td><td>―</td><td>￥{totalYen.toFixed(2)}</td></tr>
                  </tfoot>
                </table>
                <p className="payroll-caution">
                  ※ 表示は目安です。実際の請求額は契約しているプランや割引によって変わります。
                </p>
              </section>

              <section className="payroll-panel">
                <div className="game-section-title"><span>02</span><h3>社員ごとのはたらき</h3></div>
                <div className="payroll-agent-list">
                  {earningsByAgent.length === 0 && (
                    <p className="payroll-empty">まだ誰も働いていません。仕事を依頼すると記録されます。</p>
                  )}
                  {earningsByAgent.map((entry) => (
                    <div className="payroll-agent" key={entry.threadId}>
                      <span className="payroll-agent-chip" style={{ background: hexColor(entry.color) }} />
                      <div className="payroll-agent-copy">
                        <strong>{entry.name}</strong>
                        <small>{formatTokens(totalTokens(entry.usage))} トークン</small>
                      </div>
                      <div className="payroll-agent-bar">
                        <i style={{ width: `${totalYen > 0 ? (entry.yen / totalYen) * 100 : 0}%` }} />
                      </div>
                      <b>￥{entry.yen.toFixed(2)}</b>
                    </div>
                  ))}
                </div>
              </section>

              <section className="payroll-panel">
                <div className="game-section-title"><span>03</span><h3>料金の設定</h3></div>
                <div className="payroll-settings">
                  <label>
                    使っているプラン
                    <select
                      value={costSettings.planId}
                      onChange={(event) => setCostSettings({ planId: event.target.value })}
                    >
                      {pricingPlans.map((plan) => (
                        <option key={plan.id} value={plan.id}>{plan.label}</option>
                      ))}
                    </select>
                  </label>
                  <p className="payroll-plan-note">{activePlan.note}</p>
                  <label>
                    1ドルは何円？
                    <input
                      type="number"
                      min={1}
                      step={0.5}
                      value={costSettings.jpyPerUsd}
                      onChange={(event) =>
                        setCostSettings({ jpyPerUsd: Number(event.target.value) || 0 })
                      }
                    />
                  </label>
                  {costSettings.planId === 'custom' && (
                    <div className="payroll-custom-prices">
                      <label>
                        入力（$/100万）
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={costSettings.customInputPerMTok}
                          onChange={(event) =>
                            setCostSettings({ customInputPerMTok: Number(event.target.value) || 0 })
                          }
                        />
                      </label>
                      <label>
                        使い回し（$/100万）
                        <input
                          type="number"
                          min={0}
                          step={0.001}
                          value={costSettings.customCachedPerMTok}
                          onChange={(event) =>
                            setCostSettings({ customCachedPerMTok: Number(event.target.value) || 0 })
                          }
                        />
                      </label>
                      <label>
                        出力（$/100万）
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={costSettings.customOutputPerMTok}
                          onChange={(event) =>
                            setCostSettings({ customOutputPerMTok: Number(event.target.value) || 0 })
                          }
                        />
                      </label>
                    </div>
                  )}
                  <button
                    className="payroll-reset"
                    type="button"
                    onClick={() => {
                      resetUsage();
                      addLog('報酬メーターを0円にリセットしました', 'info');
                    }}
                  >メーターを0円にもどす</button>
                </div>
              </section>
            </div>
          </section>
        </div>
      )}

      {approval && (
        <div className="modal-backdrop" role="presentation">
          <section
            className={`approval-modal risk-${approval.risk}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="approval-title"
          >
            <div className="approval-icon">!</div>
            <span className="eyebrow">しょうにん おねがい</span>
            <h2 id="approval-title">{approval.title}</h2>
            <p className="approval-who">
              {approvalAgent?.name ?? '担当エージェント'}が、これから次のことをしていいか聞いています。
            </p>
            <p className="approval-headline">{approval.headline}</p>
            <ul className="approval-bullets">
              {approval.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
            {approval.command && (
              <div className="approval-command">
                <span>実際に打ち込まれる命令文</span>
                <code>{approval.command}</code>
              </div>
            )}
            {approval.files.length > 0 && (
              <div className="approval-command">
                <span>書き換わるファイル</span>
                <code>{approval.files.map((file) => file.path).join('\n')}</code>
              </div>
            )}
            <p className={`approval-risk ${approval.risk}`}>{approval.riskLabel}</p>
            <p className="approval-guide">
              進めてよければ「承認する」、やめてほしければ「拒否する」を押してください。
              拒否してもアプリは止まらず、エージェントが別の方法を考えます。
            </p>
            <details className="approval-raw">
              <summary>技術的な詳細を見る（開発者向け）</summary>
              <pre>{approval.raw}</pre>
            </details>
            <div className="modal-actions">
              <button type="button" className="danger-button" onClick={() => respondApproval('decline')}>
                拒否する（実行しない）
              </button>
              <button type="button" className="primary-button" onClick={() => respondApproval('accept')}>
                承認する（実行を許可）
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
