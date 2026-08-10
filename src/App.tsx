import QRCode from 'qrcode';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  AttachmentTray,
  attachmentNote,
  attachmentSummary,
  useAttachments,
} from './AttachmentTray';
import {
  estimateAllPlans,
  findPlan,
  formatTokens,
  jpyCost,
  planPrices,
  pricingPlans,
  splitYen,
  totalTokens,
} from './costs';
import {
  characterPortrait,
  getSheetVersion,
  PORTRAIT_SIZE,
  subscribeSheetVersion,
} from './game/characterSheet';
import { roomNameFor } from './game/officeLayout';
import { PhaserCanvas } from './game/PhaserCanvas';
import { effortOptions, modelLabel, modelOptions, resolveModelId } from './models';
import {
  formatCommunicationMessage,
  formatRemoteApproval,
  formatRemoteQuestion,
  loadCommunicationPolicy,
  mergeCommunicationPolicy,
  saveCommunicationPolicy,
} from './remote/communicationPolicy';
import type { CommunicationPolicyPatch } from './remote/communicationPolicy';
import { isPreviewableFile, maxPreviewUrls, normalizePreviewUrl } from './remote/previewSources';
import type { PreviewSource } from './remote/previewSources';
import { lanPairingQr, reachableRelayUrl, urlPairingQr } from './remote/RemoteProtocol';
import { SkillBook, useSkillBook } from './SkillBook';
import { skillBriefing } from './skills/skillFile';
import {
  communicatorAgentId,
  threadDisplayColor,
  threadDisplayName,
  threadDisplayRole,
  useAgentStore,
} from './stores/agentStore';
import type {
  AgentProfile,
  AgentState,
  Attachment,
  BridgeInboxTask,
  BridgeServerStatus,
  CodexProcessInfo,
  DriveStatus,
  RateLimitWindow,
  RemoteApprovalResponse,
  RemoteGatewayStatus,
  RemoteInstruction,
  RemoteQuestionResponse,
  RepoStatus,
  RoadmapStep,
  SaveMeta,
  SaveSlot,
  WirelessPairingSession,
  WorkspaceEntry,
} from './types';

const agentColors = [0xf0bd55, 0x65b7d8, 0xe1775b, 0x78b56c, 0xb58bd4, 0xe09cb2];

/**
 * 同じフォルダを指しているかどうか。Windowsは大文字小文字を区別せず、区切りも
 * 両方通るので、見た目の違いだけで「別のフォルダだ」と言わないようにします。
 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  return normalize(left) === normalize(right);
}
const recentWorkspacesKey = 'pixel-codex-recent-workspaces';
const recentWorkspaceLimit = 8;

/** 規格が定める静穏帯。4マス分より狭いと読み取り率が落ちます。 */
const qrMargin = 4;
/** QRを出したい幅の目安。実際の幅はマスの数で割り切れる値へ丸めます。 */
const qrTargetWidth = 390;

/**
 * 1マスあたりのピクセル数。マスの数で割り切れる整数にすることで、どのマスも
 * 同じ大きさになり、拡大時もにじみません。
 */
function qrScale(value: string, errorCorrectionLevel: 'L' | 'M'): number {
  const modules = QRCode.create(value, { errorCorrectionLevel }).modules.size + qrMargin * 2;
  return Math.max(3, Math.floor(qrTargetWidth / modules));
}

/** 接続情報をQRにして見せます。端末のカメラで読めば入力なしでつながります。 */
function PairingQr({ value, caption }: { value: string; caption: string }): React.JSX.Element {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    // 外部Relay用は170文字前後あってマス目が細かくなります。画面に出すだけで
    // 汚れも折れも無いため、誤り訂正を下げてマスを大きく取ります。
    const errorCorrectionLevel = value.length > 100 ? 'L' : 'M';
    QRCode.toDataURL(value, {
      errorCorrectionLevel,
      // 規格が求める余白。ここを削るとカメラが枠を掴めなくなります。
      margin: qrMargin,
      /**
       * 全体の幅ではなく「1マスあたりのピクセル数」で指定します。幅で指定すると
       * マスの数で割り切れないときに4pxと5pxのマスが混じり、`image-rendering:
       * pixelated`と相まって格子が歪んでカメラが読めなくなります。
       */
      scale: qrScale(value, errorCorrectionLevel),
      color: { dark: '#241a2e', light: '#f4ecdc' },
    })
      .then((url) => {
        if (!active) return;
        setImage(url);
        setError('');
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setImage('');
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [value]);

  if (error) return <p className="pairing-qr-error">QRを作れませんでした：{error}</p>;
  return (
    <figure className="pairing-qr">
      {image && <img src={image} alt="接続用QRコード" />}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

const statusLabels: Record<AgentState['status'], string> = {
  idle: '待機中',
  planning: '計画中',
  researching: '調査中',
  coding: '実装中',
  running: '実行中',
  accounting: '記帳中',
  approval: '承認待ち',
  done: '完了',
  error: 'エラー',
};

const dutyLabels: Record<AgentState['duty'], string> = {
  director: '統括本部',
  planner: '企画会議室',
  coder: '開発室',
  researcher: '資料室',
  tester: 'テストラボ',
  reviewer: '企画会議室',
  designer: '開発室',
  accountant: '経理室',
  communicator: '通信室',
  writer: '資料室',
  general: 'フロア',
};

/** セーブ一覧での見せ方。どれも同じようにロードできます。 */
const saveKindLabels: Record<SaveSlot['kind'], { tag: string; note: string }> = {
  save: { tag: 'SAVE', note: '手動でセーブしたデータです' },
  auto: { tag: 'AUTO', note: 'ロードの直前に自動で取った控えです。ロードをやり直せます' },
  load: { tag: 'LOAD', note: 'ロードした操作の記録です' },
  other: { tag: 'LOG', note: 'アプリ以外で作られた記録です' },
};

const roadmapStatusLabels = {
  pending: '未着手',
  active: '作業中',
  done: '完了',
} as const;

/**
 * 工程を左から右へ並べた進み具合の帯。「どこまで進んだか」が一目で分かるように、
 * 通り過ぎた区間は緑、作業中の区間は途中まで金色に塗ります。
 */
function RoadmapMilestones({
  steps,
  vertical = false,
}: {
  steps: RoadmapStep[];
  /** フロア図の右に立てる縦長の進行表かどうか。横に流す進行表ウィンドウとは並びだけが違います。 */
  vertical?: boolean;
}): React.JSX.Element {
  const visibleSteps = steps.length
    ? steps
    : [
        { id: 'placeholder-1', title: '受付', status: 'pending' as const },
        { id: 'placeholder-2', title: '計画', status: 'pending' as const },
        { id: 'placeholder-3', title: '完了', status: 'pending' as const },
      ];
  // 現在地は「作業中の工程」。まだ始まっていなければ、完了した数の次が現在地です。
  const activeIndex = visibleSteps.findIndex((step) => step.status === 'active');
  const currentIndex = activeIndex >= 0
    ? activeIndex
    : visibleSteps.filter((step) => step.status === 'done').length;
  return (
    <div
      className={`roadmap-milestones ${vertical ? 'vertical' : ''} ${steps.length ? '' : 'empty'}`}
      aria-label="工程マイルストーン"
    >
      {visibleSteps.map((step, index) => {
        // 工程と工程をつなぐ線。完了ぶんは塗りきり、作業中はその工程の半分まで塗ります。
        const linkFill = step.status === 'done' ? 100 : step.status === 'active' ? 50 : 0;
        const isCurrent = index === currentIndex && step.status !== 'done';
        const fill = vertical ? { height: `${linkFill}%` } : { width: `${linkFill}%` };
        return (
          <div
            className={`roadmap-milestone ${step.status} ${isCurrent ? 'current' : ''}`}
            key={step.id}
          >
            {index < visibleSteps.length - 1 && (
              <span className={`roadmap-link ${step.status}`} aria-hidden="true">
                <b style={fill} />
              </span>
            )}
            <i aria-hidden="true">{step.status === 'done' ? '✓' : index + 1}</i>
            <small title={step.title}>{step.title}</small>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 看板に大きく出す「〇〇中」。エージェントの活動文はもともと 「App.tsx を編集中」
 * のように終わるので、そのまま使えるときは使い、そうでないときだけ状態名に
 * 置き換えます。看板の文字はすべて「中」で終わる形にそろえます。
 */
const signHeadlines: Record<AgentState['status'], string> = {
  idle: '次の指示を待機中',
  planning: '進め方を検討中',
  researching: '資料を調査中',
  coding: 'コードを実装中',
  running: 'コマンドを実行中',
  accounting: '使用量を記帳中',
  approval: 'あなたの返事を待機中',
  done: 'ひと息ついて休憩中',
  error: 'エラーを確認中',
};

interface SignEntry {
  id: string;
  name: string;
  role: string;
  room: string;
  color: number;
  headline: string;
  tone: 'attention' | 'work';
}

/** 右カラムのタブ。フロア図を広く取るため、4つの情報を1枚ずつ切り替えます。 */
type SideTab = 'roster' | 'profile' | 'meeting' | 'log';

const sideTabs: { id: SideTab; label: string; eyebrow: string }[] = [
  { id: 'roster', label: '名簿', eyebrow: 'ATTENDANCE' },
  { id: 'profile', label: 'プロフィール', eyebrow: 'STAFF PROFILE' },
  { id: 'meeting', label: '会議・回答', eyebrow: 'TEAM MEETING' },
  { id: 'log', label: 'ログ', eyebrow: 'OFFICE LOG' },
];

function signHeadline(agent: AgentState): string {
  const activity = agent.activity.replace(/\s+/g, ' ').trim();
  if (/中$/.test(activity)) return activity;
  return signHeadlines[agent.status];
}

function formatElapsed(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '1分未満';
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

/** 使用量の枠がひとまわりする長さを「5時間」「1週間」のように言い換えます。 */
function formatWindow(minutes?: number): string {
  if (!minutes) return '';
  if (minutes < 60) return `${minutes}分`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}時間`;
  const days = Math.round(minutes / 1440);
  return days % 7 === 0 ? `${days / 7}週間` : `${days}日`;
}

/** 「あと◯時間で回復」。もう過ぎているときは、そのまま回復済みと伝えます。 */
function formatReset(resetsAt?: number): string {
  if (!resetsAt) return '';
  const remaining = resetsAt - Date.now();
  if (remaining <= 0) return 'まもなく回復';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `あと${minutes}分で回復`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `あと${hours}時間で回復`;
  return `あと${Math.round(hours / 24)}日で回復`;
}

/** 残量メーター1本ぶんの表示内容。 */
function usageRow(
  key: string,
  fallbackLabel: string,
  window?: RateLimitWindow,
): { key: string; label: string; remaining: number; tone: string; reset: string } | undefined {
  if (!window) return undefined;
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  return {
    key,
    label: window.windowDurationMins ? `${formatWindow(window.windowDurationMins)}枠` : fallbackLabel,
    remaining,
    tone: remaining <= 10 ? 'critical' : remaining <= 30 ? 'low' : 'ok',
    reset: formatReset(window.resetsAt),
  };
}

/** IPCへ渡すのはパスと種類だけ。プレビュー画像まで送ると無駄に重くなります。 */
function sendableAttachments(
  attachments: Attachment[],
): Array<Pick<Attachment, 'path' | 'kind'>> {
  return attachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind }));
}

/**
 * Ctrl+Enter（macは⌘+Enter）で送信します。日本語変換の確定Enterと
 * 区別するため、変換中は何もしません。
 */
function submitOnHotkey(event: React.KeyboardEvent, send: () => void): void {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
  if (event.nativeEvent.isComposing) return;
  event.preventDefault();
  send();
}

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
  // ドット絵シートは仮キャラで始まり、本物の絵が読み込めた時点で差し替わります。
  // そのタイミングで名簿のアイコンも描き直すための購読です。
  useSyncExternalStore(subscribeSheetVersion, getSheetVersion);
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
    configWarning,
    clearConfigWarning,
    roadmap,
    projectStartedAt,
    accountingReport,
    accountingReports,
    usage,
    usageByThread,
    usageUpdatedAt,
    rateLimits,
    applyRateLimits,
    costSettings,
    modelSettings,
    setCostSettings,
    setModelSettings,
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
    startProject,
    narrateProgress,
    reviewAttendance,
    buildAccountingReport,
    openAccountingReport,
    applyLoadedSave,
  } = useAgentStore();
  const [task, setTask] = useState('調査、実装、テストを別々のサブエージェントに担当させてください。');
  const [steerText, setSteerText] = useState('');
  const taskAttachments = useAttachments();
  const steerAttachments = useAttachments();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [workspaceHistoryOpen, setWorkspaceHistoryOpen] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(loadRecentWorkspaces);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [codexExecutable, setCodexExecutable] = useState('');
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});
  const [blackboardOpen, setBlackboardOpen] = useState(false);
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [communicationOpen, setCommunicationOpen] = useState(false);
  const [communicationPolicy, setCommunicationPolicy] = useState(loadCommunicationPolicy);
  const [communicationNotice, setCommunicationNotice] = useState('');
  const [previewUrlDraft, setPreviewUrlDraft] = useState('');
  const [driveStatus, setDriveStatus] = useState<DriveStatus>({
    configured: false,
    connected: false,
    account: '',
    folderName: 'Pixel Codex Previews',
  });
  const [driveClientId, setDriveClientId] = useState('');
  const [driveClientSecret, setDriveClientSecret] = useState('');
  const [driveBusy, setDriveBusy] = useState(false);
  const [usbTestBusy, setUsbTestBusy] = useState(false);
  const [wirelessTestBusy, setWirelessTestBusy] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingSession, setPairingSession] = useState<WirelessPairingSession | null>(null);
  const [pairingRemaining, setPairingRemaining] = useState(0);
  const [urlQrOpen, setUrlQrOpen] = useState(false);
  const [remoteHostId, setRemoteHostId] = useState('');
  const [remoteLanAddress, setRemoteLanAddress] = useState('');
  const [remoteStatus, setRemoteStatus] = useState<RemoteGatewayStatus>({
    phase: 'disabled',
    label: '通信停止中',
  });
  const [remoteQueue, setRemoteQueue] = useState<RemoteInstruction[]>([]);
  /**
   * 赤ペン先生から届き、まだ送っていない赤入れ。受け取っただけでは動かさないので、
   * ここに置いたまま利用者が送信するのを待ちます。
   */
  const [bridgeTasks, setBridgeTasks] = useState<BridgeInboxTask[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeServerStatus>({
    phase: 'stopped',
    label: '受け取り停止中',
    connected: false,
  });
  const [roadmapOpen, setRoadmapOpen] = useState(false);
  // 右カラムは4枚のタブを1枚ずつ出します。縦積みをやめたぶんフロア図に高さを回せます。
  const [sideTab, setSideTab] = useState<SideTab>('roster');
  const [savesOpen, setSavesOpen] = useState(false);
  const [saves, setSaves] = useState<SaveSlot[]>([]);
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null);
  const [saveLabel, setSaveLabel] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [pendingLoad, setPendingLoad] = useState<SaveSlot | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [conflict, setConflict] = useState<{
    processes: CodexProcessInfo[];
    executable?: string;
    workspace: string;
  } | null>(null);
  const [staffOpen, setStaffOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillBox = useSkillBook(workspace);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryPath, setLibraryPath] = useState('');
  const [libraryEntries, setLibraryEntries] = useState<WorkspaceEntry[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [agentDraft, setAgentDraft] = useState<
    Pick<AgentProfile, 'name' | 'job' | 'duty' | 'specialty' | 'personality' | 'color'>
  >({
    name: '',
    job: '',
    duty: 'coder',
    specialty: '',
    personality: '',
    color: agentColors[1],
  });
  const conversationRef = useRef<HTMLDivElement>(null);
  const autoOpenedReportId = useRef('');
  const autoOpenedAccountingId = useRef('');
  const initialWorkspace = useRef(recentWorkspaces[0]);
  const remoteInstructionRunning = useRef(false);
  const remoteQueueObservedWork = useRef(false);
  /** 送信済みの赤入れ。終わったことを赤ペン先生へ伝えるまで覚えておきます。 */
  const bridgeStartedTaskId = useRef('');
  const bridgeObservedWork = useRef(false);
  /** 指示欄へ添えた赤入れ画像。同じものを二度添えないための目印です。 */
  const bridgeAdoptedPath = useRef('');

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? agents[0],
    [agents, selectedAgentId],
  );
  // 担当者あての指示はすべて統括責任者ごしに伝えるので、その人の状態を引いておきます。
  const rootAgent = useMemo(
    () => agents.find((agent) => agent.id === rootThreadId || agent.threadId === rootThreadId),
    [agents, rootThreadId],
  );
  /** いま確認を待っている赤入れ。1件ずつ片付けてもらいます。 */
  const pendingBridgeTask = bridgeTasks[0];
  const bridgeWorkspaceDiffers = Boolean(
    pendingBridgeTask && workspace && !samePath(pendingBridgeTask.workingDirectory, workspace),
  );
  /**
   * 送れない理由。受け取り自体は断らず、理由を出して待ちます。断ってしまうと、
   * 接続し直しただけの人がもう一度赤入れを描くことになるためです。
   */
  const bridgeBlockedReason = !pendingBridgeTask
    ? ''
    : connection !== 'connected'
      ? 'Codexに接続すると送れるようになります。'
      : !workspace
        ? 'PCで作業フォルダを選ぶと送れるようになります。'
        : '';
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
            name: threadDisplayName(threadId, agent?.name),
            role: threadDisplayRole(threadId, agent?.role),
            color: threadDisplayColor(threadId, agent?.color),
            usage: entry.usage,
            yen: jpyCost(entry.usage, costSettings),
          };
        })
        .sort((left, right) => right.yen - left.yen),
    [usageByThread, agents, costSettings],
  );
  const planEstimates = useMemo(
    () => estimateAllPlans(usage, costSettings),
    [usage, costSettings],
  );
  const roadmapProgress = useMemo(() => {
    const steps = roadmap.steps;
    if (!steps.length) return { percent: 0, done: 0, active: undefined as string | undefined };
    const done = steps.filter((step) => step.status === 'done').length;
    const running = steps.filter((step) => step.status === 'active').length;
    return {
      percent: Math.round(((done + running * 0.5) / steps.length) * 100),
      done,
      active: steps.find((step) => step.status === 'active')?.title,
    };
  }, [roadmap]);
  // 通し番号は手動セーブにだけ振ります（自動セーブやロード記録で番号が飛ぶと
  // 「何番目のセーブか」が分からなくなるため）。
  const slotNumbers = useMemo(() => {
    const numbers = new Map<string, string>();
    const manual = saves.filter((slot) => slot.kind === 'save');
    manual.forEach((slot, index) => {
      numbers.set(slot.commit, String(manual.length - index).padStart(2, '0'));
    });
    return numbers;
  }, [saves]);
  const directorAgent = useMemo(
    () => agents.find((agent) => agent.duty === 'director'),
    [agents],
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
  const usageRows = useMemo(
    () =>
      [
        usageRow('primary', '短期の枠', rateLimits?.primary),
        usageRow('secondary', '長期の枠', rateLimits?.secondary),
      ].filter((row): row is NonNullable<typeof row> => Boolean(row)),
    [rateLimits],
  );
  // HPバーには短期の枠を出します。長期の枠はその下に細く添えます。
  const hpMain = usageRows[0];
  const hpSub = usageRows[1];
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

  // 質問が来たら会議タブへ自動で切り替えます。タブの裏で回答待ちが埋もれると詰むためです。
  useEffect(() => {
    if (questionRequest) setSideTab('meeting');
  }, [questionRequest?.requestId]);

  // フロア図の社員をクリックしたときも、右カラムにその人のプロフィールを出します。
  // 初回表示のぶんは切り替えません（起動直後にタブが動くと落ち着かないためです）。
  const lastSelectedId = useRef<string | null>(null);
  useEffect(() => {
    const id = selectedAgentId;
    if (lastSelectedId.current === null) {
      lastSelectedId.current = id;
      return;
    }
    if (id && id !== lastSelectedId.current) setSideTab('profile');
    lastSelectedId.current = id;
  }, [selectedAgentId]);

  useEffect(() => {
    if (latestReport && autoOpenedReportId.current !== latestReport.id) {
      autoOpenedReportId.current = latestReport.id;
      setBlackboardOpen(true);
    }
  }, [latestReport]);

  // 会計報告は、経理担当が経理室まで歩いてから開くほうが分かりやすいので少し待ちます。
  useEffect(() => {
    if (!accountingReport || autoOpenedAccountingId.current === accountingReport.id) return;
    autoOpenedAccountingId.current = accountingReport.id;
    const timer = window.setTimeout(() => setReportOpen(true), 2200);
    return () => window.clearTimeout(timer);
  }, [accountingReport]);

  /**
   * 使用量の枠は、接続直後と1分おきに聞きに行きます。作業中は Codex 側からも
   * 通知が届くので、これはその補完（開いたまま放置したときの更新）です。
   */
  useEffect(() => {
    if (connection !== 'connected') return undefined;
    const refresh = (): void => {
      window.pixelCodex
        .getRateLimits()
        .then((payload) => applyRateLimits(payload))
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [connection, applyRateLimits]);

  /**
   * 指示欄の外にファイルを落としたときに、Electronが画面ごとそのファイルを
   * 開いてしまうのを防ぎます。
   */
  useEffect(() => {
    const swallow = (event: DragEvent): void => event.preventDefault();
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  // 統括責任者は手が空いているあいだ、進捗と完了予想をつぶやきます。
  useEffect(() => {
    if (connection !== 'connected') return undefined;
    const timer = window.setInterval(() => narrateProgress(), 12_000);
    return () => window.clearInterval(timer);
  }, [connection, narrateProgress]);

  // 休憩が長引いた担当は「お先に～」と退勤します。
  useEffect(() => {
    const timer = window.setInterval(() => reviewAttendance(), 5_000);
    return () => window.clearInterval(timer);
  }, [reviewAttendance]);

  /**
   * 他のCodexが動いていると App Server につなげないので、先に確認します。
   * 見つかったときは接続せず、ユーザーに切断するかどうかを尋ねます。
   */
  async function connect(
    executable?: string,
    targetWorkspace = workspace,
    skipConflictCheck = false,
  ): Promise<void> {
    if (!targetWorkspace) {
      setNotice('先に作業フォルダを選択してください。');
      return;
    }
    if (!skipConflictCheck) {
      const running = await window.pixelCodex.listCodexProcesses().catch(() => []);
      if (running.length > 0) {
        setConflict({ processes: running, executable, workspace: targetWorkspace });
        return;
      }
    }
    setBusy(true);
    setNotice('');
    setConnection('connecting', '接続中');
    // 接続は2段階あるので、どちらで失敗したかを言えるようにしておきます。
    let step = 'Codexの起動';
    try {
      const result = await window.pixelCodex.startCodex(executable);
      setCodexExecutable(result.executable);
      setConnection('connected', 'Codex接続済み');
      addLog(
        `Codex App Serverに接続しました: ${result.version} (${result.executable})`,
        'success',
      );
      step = '作業スレッドの作成';
      const thread = await window.pixelCodex.startThread(targetWorkspace, {
        model: resolveModelId(modelSettings),
        effort: modelSettings.effort,
      });
      setRootThread(thread.threadId);
      rememberWorkspace(targetWorkspace);
      addLog(
        `統括責任者のスレッドを作成しました（モデル: ${modelLabel(modelSettings)}）`,
        'success',
        thread.threadId,
      );
    } catch (error) {
      const message = errorMessage(error);
      // 途中まで起動していると次の接続がぶつかるので、必ず後片付けします。
      await window.pixelCodex.stopCodex().catch(() => undefined);
      setConnection('error', '接続エラー');
      setNotice(`${step}に失敗しました：${message}`);
      addLog(`${step}に失敗しました：${message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 確認画面で「他を切断して接続」を選んだときの処理。 */
  async function disconnectOthersAndConnect(): Promise<void> {
    if (!conflict) return;
    const target = conflict;
    setConflict(null);
    setBusy(true);
    try {
      const result = await window.pixelCodex.terminateCodexProcesses(
        target.processes.map((entry) => entry.pid),
      );
      addLog(
        `他のCodexを${result.stopped.length}件切断しました${
          result.failed.length ? `（${result.failed.length}件は切断できませんでした）` : ''
        }`,
        result.failed.length ? 'warning' : 'success',
      );
    } catch (error) {
      addLog(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
    await connect(target.executable, target.workspace, true);
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
        // 自分のCodexは今止めたばかりなので、重複確認はやり直しません。
        await connect(codexExecutable || undefined, selectedPath, true);
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

  /** いまの状況をセーブデータに書き込むための「そのときの情報」。 */
  function currentSaveMeta(label: string): SaveMeta {
    return {
      label,
      createdAt: Date.now(),
      roadmapTitle: roadmap.title || undefined,
      roadmapDone: roadmap.steps.filter((step) => step.status === 'done').length,
      roadmapTotal: roadmap.steps.length,
      deliverables: deliverables.length,
      tokens: usedTokens,
      yen: Number(totalYen.toFixed(2)),
      model: modelLabel(modelSettings),
      staff: agents.map((agent) => agent.name),
    };
  }

  async function refreshSaves(): Promise<void> {
    if (!workspace) return;
    setSaveBusy(true);
    setSaveError('');
    try {
      const status = await window.pixelCodex.getRepoStatus(workspace);
      setRepoStatus(status);
      setSaves(status.isRepo && status.hasCommits ? await window.pixelCodex.listSaves(workspace) : []);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaveBusy(false);
    }
  }

  async function openSaves(): Promise<void> {
    if (!workspace) {
      setNotice('先に作業フォルダを選択してください。');
      return;
    }
    setSavesOpen(true);
    await refreshSaves();
  }

  async function prepareSaves(): Promise<void> {
    setSaveBusy(true);
    setSaveError('');
    try {
      const status = await window.pixelCodex.initRepo(workspace);
      setRepoStatus(status);
      setSaves(await window.pixelCodex.listSaves(workspace));
      addLog('セーブの準備ができました', 'success');
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaveBusy(false);
    }
  }

  async function createSave(): Promise<void> {
    const label = saveLabel.trim() || `セーブ ${new Date().toLocaleString('ja-JP')}`;
    setSaveBusy(true);
    setSaveError('');
    try {
      const next = await window.pixelCodex.createSave(workspace, label, currentSaveMeta(label));
      setSaves(next);
      setRepoStatus(await window.pixelCodex.getRepoStatus(workspace));
      setSaveLabel('');
      addLog(`セーブしました：${label}`, 'success');
    } catch (error) {
      const message = errorMessage(error);
      setSaveError(message);
      addLog(message, 'error');
    } finally {
      setSaveBusy(false);
    }
  }

  async function confirmLoad(): Promise<void> {
    if (!pendingLoad) return;
    const target = pendingLoad;
    setPendingLoad(null);
    setSaveBusy(true);
    setSaveError('');
    try {
      const result = await window.pixelCodex.loadSave(workspace, target.commit);
      setRepoStatus(result.status);
      setSaves(await window.pixelCodex.listSaves(workspace));
      if (result.meta) applyLoadedSave(result.meta);
      else addLog(`「${target.subject}」の状態に戻しました`, 'success');
      setNotice(
        `「${target.subject}」の状態に戻しました。直前の状態は「ロード前の自動セーブ」として残してあります。`,
      );
    } catch (error) {
      const message = errorMessage(error);
      setSaveError(message);
      addLog(message, 'error');
    } finally {
      setSaveBusy(false);
    }
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

  function updateCommunicationPolicy(patch: CommunicationPolicyPatch): void {
    setCommunicationPolicy((current) => {
      const next = mergeCommunicationPolicy(current, patch);
      saveCommunicationPolicy(next);
      return next;
    });
    setCommunicationNotice('設定をこのPCに保存しました');
  }

  function addPreviewUrl(): void {
    const url = normalizePreviewUrl(previewUrlDraft);
    if (!url) {
      setCommunicationNotice('http:// または https:// で始まるURLを入力してください');
      return;
    }
    if (communicationPolicy.previewUrls.includes(url)) {
      setCommunicationNotice('そのURLはすでに登録されています');
      return;
    }
    if (communicationPolicy.previewUrls.length >= maxPreviewUrls) {
      setCommunicationNotice(`登録できるURLは${maxPreviewUrls}件までです`);
      return;
    }
    setPreviewUrlDraft('');
    updateCommunicationPolicy({ previewUrls: [...communicationPolicy.previewUrls, url] });
  }

  function removePreviewUrl(url: string): void {
    updateCommunicationPolicy({
      previewUrls: communicationPolicy.previewUrls.filter((entry) => entry !== url),
    });
  }

  async function runDriveAction(
    action: () => Promise<DriveStatus>,
    success: string,
  ): Promise<void> {
    setDriveBusy(true);
    try {
      setDriveStatus(await action());
      setCommunicationNotice(success);
    } catch (error) {
      setCommunicationNotice(error instanceof Error ? error.message : 'Driveの操作に失敗しました');
    } finally {
      setDriveBusy(false);
    }
  }

  function saveDriveCredentials(): void {
    void runDriveAction(
      async () => {
        const status = await window.pixelCodex.configureDrive(driveClientId, driveClientSecret);
        // 画面に残しておく必要はないので、預けたら消します。
        setDriveClientId('');
        setDriveClientSecret('');
        return status;
      },
      '認証情報をこのPCに保存しました。続けて「Googleと接続」を押してください',
    );
  }

  function validateCommunicationRelay(): void {
    if (!communicationPolicy.relayUrl) {
      setCommunicationNotice('Relay URLを入力してください');
      return;
    }

    try {
      const relayUrl = new URL(communicationPolicy.relayUrl);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(relayUrl.hostname);
      if (relayUrl.protocol !== 'wss:'
        && relayUrl.protocol !== 'https:'
        && !(relayUrl.protocol === 'ws:' && loopback)) {
        throw new Error('unsupported protocol');
      }
      setCommunicationNotice('URL形式は正常です。通信をONにするとRelayへ接続します');
    } catch {
      setCommunicationNotice('wss:// または https:// のRelay URLを指定してください');
    }
  }

  async function startUsbRemoteTest(): Promise<void> {
    setUsbTestBusy(true);
    setCommunicationNotice('Pixel 9とのUSB通信を準備しています…');
    try {
      const session = await window.pixelCodex.startUsbRemoteTest();
      updateCommunicationPolicy({
        enabled: true,
        relayUrl: session.relayUrl,
        autoReconnect: true,
      });
      setCommunicationNotice(`USB接続済み：${session.deviceSerial}（Androidアプリを起動しました）`);
    } catch (error) {
      setCommunicationNotice(errorMessage(error));
    } finally {
      setUsbTestBusy(false);
    }
  }

  async function startWirelessRemoteTest(): Promise<void> {
    setWirelessTestBusy(true);
    setCommunicationNotice('同一Wi-Fi用Relayを準備し、Pixel 9へ初回設定を渡しています…');
    try {
      const session = await window.pixelCodex.startWirelessRemoteTest();
      updateCommunicationPolicy({
        enabled: true,
        relayUrl: session.relayUrl,
        autoReconnect: true,
      });
      setCommunicationNotice(
        `Wi-Fi接続を開始：${session.lanAddress}。Androidが「PC接続中」になったらUSBケーブルを抜いてください`,
      );
    } catch (error) {
      setCommunicationNotice(errorMessage(error));
    } finally {
      setWirelessTestBusy(false);
    }
  }

  /** ケーブルを使わないペアリング。PCは待ち受けと6桁コードを出すだけです。 */
  async function beginWirelessPairing(): Promise<void> {
    setPairingBusy(true);
    setCommunicationNotice('ペアリングの受付を準備しています…');
    try {
      const session = await window.pixelCodex.startWirelessPairing();
      setPairingSession(session);
      setRemoteLanAddress(session.lanAddress);
      setPairingRemaining(Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000)));
      // 次回起動時にこのRelayへ自動でつなぎ直せるよう、通信設定にも残します。
      updateCommunicationPolicy({ enabled: true, relayUrl: session.relayUrl, autoReconnect: true });
      setCommunicationNotice('Androidアプリにアドレスとコードを入力してください');
    } catch (error) {
      setPairingSession(null);
      setCommunicationNotice(errorMessage(error));
    } finally {
      setPairingBusy(false);
    }
  }

  /**
   * QRに載せてよいRelay URL。PC自身の設定はループバックを指すことがあるので、
   * 端末から届くアドレスへ直したうえで使います。直せないときは空になります。
   */
  const scannableRelayUrl = reachableRelayUrl(communicationPolicy.relayUrl, remoteLanAddress);

  function cancelWirelessPairing(): void {
    void window.pixelCodex.cancelWirelessPairing();
    setPairingSession(null);
    setCommunicationNotice('ペアリングの受付を終了しました');
  }

  /**
   * 統括責任者への指示書。自分で手を動かさず、ロードマップを引いて
   * 担当者へ割り振るように、毎回のお願いに添えて送ります。
   */
  function directorBriefing(): string {
    const director = hiredProfiles.find((profile) => profile.duty === 'director');
    const team = hiredProfiles.filter(
      (profile) => profile.duty !== 'director'
        && profile.duty !== 'accountant'
        && profile.duty !== 'communicator',
    );
    const lines = [
      '',
      '[Pixel Codex 社内ルール]',
      `あなたはプロジェクト統括責任者「${director?.name ?? '東葛大五郎'}」です。`,
      '1. まず作業全体のロードマップを作り、番号付きの箇条書きで「ロードマップ」として提示してください。各行の先頭に担当者名を書いてください。',
      '2. ロードマップは計画ツール（todo/plan）があればそちらにも登録してください。進行表として画面に掲示されます。',
      '3. 自分では実装せず、下記の担当者をサブエージェントとして起動し、適切に作業を割り振ってください。起動時の依頼文には必ず社員名と役割を明記してください。',
      '4. 各担当が終わるたびに進捗を短く報告し、最後に全体の完了報告をまとめてください。',
      // 「どうしますか？」だけ返されると、社長は画面を見ても何を答えればいいのか分かりません。
      '5. ユーザー（社長）に判断や意見を求めるときは、必ず次の3点をその場に具体的に書いてください。'
        + '(a) 何について決めてほしいのか（対象のファイル名・機能名まで書く）、'
        + '(b) 選択肢と、それぞれを選んだ場合にどうなるか、'
        + '(c) あなたの推奨と、その理由。',
      '6. 「どうしますか？」「どちらがいいですか？」のような、対象の分からない聞き方はしないでください。'
        + '質問の見出しは、それだけ読めば用件が分かる一文にしてください。',
      '7. 自分で調べれば分かることや、一般的な作法で決まることは質問せず、判断して進めてください。'
        + '質問するのは、ユーザーの好みや業務都合でしか決められないことだけです。',
    ];
    if (team.length) {
      lines.push('', '[割り振れる担当者]');
      lines.push(
        ...team.map(
          (profile) =>
            `- ${profile.name} / ${profile.job}: 得意=${profile.specialty}; 人柄=${profile.personality}`,
        ),
      );
    } else {
      lines.push('', '※ いま雇用中の担当者がいません。社員名簿から雇用するようユーザーに伝えてください。');
    }
    // 装備中のスキルは、社内ルールの続きとしてそのまま添えます。
    return `${lines.join('\n')}${skillBriefing(skillBox.equipped)}`;
  }

  async function submitTask(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    if (!task.trim() || busy) return;
    if (connection !== 'connected') {
      setNotice('先にCodexへ接続してください。現在は画面確認用のデモ表示です。');
      return;
    }
    setBusy(true);
    try {
      const attachments = taskAttachments.attachments;
      // いま指示欄に載っている赤入れ。これがあると、送信の結果を赤ペン先生へ返します。
      const carried = bridgeTasks.find(
        (entry) => attachments.some((attachment) => attachment.path === entry.imagePath),
      );
      let threadId = rootThreadId;
      if (!threadId) {
        const result = await window.pixelCodex.startThread(workspace, {
          model: resolveModelId(modelSettings),
          effort: modelSettings.effort,
          // 「提案のみ」で届いた赤入れは、書き換えられない部屋で始めます。
          sandbox: carried?.mode === 'Discuss' ? 'read-only' : undefined,
        });
        threadId = result.threadId;
        setRootThread(threadId);
      }
      const request = task.trim();
      startProject(request.split(/\r?\n/)[0].slice(0, 40));
      await window.pixelCodex.sendTask(
        threadId,
        `${request}${bridgeBriefing(carried)}${attachmentNote(attachments)}${directorBriefing()}`,
        attachments.map((attachment) => ({ path: attachment.path, kind: attachment.kind })),
      );
      addMessage({
        agentId: threadId,
        role: 'user',
        text: `${request}${attachmentSummary(attachments)}`,
      });
      const directorName = agents.find(
        (agent) => agent.id === threadId || agent.threadId === threadId,
      )?.name ?? '東葛大五郎';
      addLog(
        `${directorName}へ新しいタスクを送りました${
          attachments.length ? `（添付${attachments.length}件）` : ''
        }`,
        'success',
        threadId,
      );
      setTask('');
      taskAttachments.clear();
      if (carried) {
        bridgeStartedTaskId.current = carried.taskId;
        bridgeObservedWork.current = false;
        bridgeAdoptedPath.current = '';
        setBridgeTasks((current) => current.filter((entry) => entry.taskId !== carried.taskId));
        void window.pixelCodex.updateBridgeTask({
          taskId: carried.taskId,
          outcome: 'started',
          detail: 'Pixel Codexで作業を開始しました',
        });
        addLog('赤ペン先生から届いた赤入れをCodexへ渡しました', 'success', threadId);
      }
    } catch (error) {
      const message = errorMessage(error);
      setNotice(message);
      addLog(message, 'error');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 赤入れに添える短い前置き。「提案のみ」は新しいスレッドなら読み取り専用の部屋で
   * 始まりますが、既にある会話を続けるときは部屋の権限を変えられないため、
   * ここで言葉としても伝えます。
   *
   * 赤ペン先生が言ってきた対象フォルダはここへ書きません。実際に触れるのは
   * Pixel Codexの作業フォルダのほうで、食い違っていた場合に「触れない場所」を
   * 対象として伝えることになるためです。食い違いは到着帯で人が確かめます。
   */
  function bridgeBriefing(carried: BridgeInboxTask | undefined): string {
    if (!carried) return '';
    const lines = [
      '',
      '[赤ペン先生から届いた赤入れ]',
      '添付の画像には、画面へ直接書き込まれた指摘が含まれています。まず画像を見てください。',
    ];
    if (carried.mode === 'Discuss') {
      lines.push('この依頼は「提案のみ」です。ファイルは変更せず、調査と提案だけを行ってください。');
    }
    return lines.join('\n');
  }

  function acknowledgeRemote(
    messageId: string,
    outcome: 'started' | 'queued' | 'rejected' | 'failed',
    detail: string,
  ): void {
    void window.pixelCodex.acknowledgeRemoteInstruction({
      messageId,
      outcome,
      detail,
      time: Date.now(),
    });
  }

  function acknowledgeRemoteInstruction(
    instruction: RemoteInstruction,
    outcome: 'started' | 'queued' | 'rejected' | 'failed',
    detail: string,
  ): void {
    acknowledgeRemote(instruction.messageId, outcome, detail);
  }

  /** スマートフォンから返ってきた承認の可否。PCで出ている要求と一致したときだけ通します。 */
  async function receiveRemoteApproval(response: RemoteApprovalResponse): Promise<void> {
    if (!communicationPolicy.enabled || !communicationPolicy.allowRemoteApprovals) {
      acknowledgeRemote(response.messageId, 'rejected', 'PC側でスマートフォンからの承認が無効です');
      return;
    }
    if (!approval || String(approval.requestId) !== response.requestId) {
      acknowledgeRemote(response.messageId, 'rejected', 'その承認待ちはPCで処理済みです');
      return;
    }
    const accepted = response.decision === 'accept';
    try {
      await window.pixelCodex.respondApproval(approval.requestId, response.decision);
      addLog(
        accepted ? 'スマートフォンから操作を承認しました' : 'スマートフォンから操作を拒否しました',
        accepted ? 'success' : 'warning',
        approval.agentId,
      );
      setCommunicationNotice(accepted ? 'スマートフォンから承認されました' : 'スマートフォンから拒否されました');
      clearApproval();
      acknowledgeRemote(response.messageId, 'started', accepted ? '承認しました' : '拒否しました');
    } catch (error) {
      const detail = errorMessage(error);
      setCommunicationNotice(detail);
      acknowledgeRemote(response.messageId, 'failed', detail);
    }
  }

  async function receiveRemoteQuestion(response: RemoteQuestionResponse): Promise<void> {
    if (!communicationPolicy.enabled || !communicationPolicy.allowRemoteApprovals) {
      acknowledgeRemote(response.messageId, 'rejected', 'PC側でスマートフォンからの回答が無効です');
      return;
    }
    if (!questionRequest || String(questionRequest.requestId) !== response.requestId) {
      acknowledgeRemote(response.messageId, 'rejected', 'その質問はPCで回答済みです');
      return;
    }
    // 秘密の入力は端末へ送っていないので、回答も受け取りません。
    if (questionRequest.questions.some((question) => question.isSecret)) {
      acknowledgeRemote(response.messageId, 'rejected', '秘密の入力を含む質問はPCで回答してください');
      return;
    }
    const answered = questionRequest.questions.map((question) => ({
      question,
      text: response.answers[question.id]?.trim() ?? '',
    }));
    if (answered.some((entry) => !entry.text)) {
      acknowledgeRemote(response.messageId, 'rejected', 'すべての質問に回答してください');
      return;
    }
    try {
      await window.pixelCodex.respondUserInput(
        questionRequest.requestId,
        Object.fromEntries(answered.map((entry) => [entry.question.id, [entry.text]])),
      );
      addMessage({
        agentId: questionRequest.agentId,
        role: 'user',
        text: answered.map((entry) => `${entry.question.header}: ${entry.text}`).join('\n'),
      });
      addLog('スマートフォンからAIの質問に回答しました', 'success', questionRequest.agentId);
      setCommunicationNotice('スマートフォンからの回答をCodexへ送信しました');
      clearQuestion();
      acknowledgeRemote(response.messageId, 'started', '回答を送信しました');
    } catch (error) {
      const detail = errorMessage(error);
      setCommunicationNotice(detail);
      acknowledgeRemote(response.messageId, 'failed', detail);
    }
  }

  async function executeRemoteInstruction(instruction: RemoteInstruction): Promise<void> {
    if (remoteInstructionRunning.current) return;
    remoteInstructionRunning.current = true;
    try {
      if (!communicationPolicy.enabled || !communicationPolicy.allowRemoteInstructions) {
        acknowledgeRemoteInstruction(instruction, 'rejected', 'PC側でスマートフォンからの指示が無効です');
        return;
      }
      if (connection !== 'connected') {
        acknowledgeRemoteInstruction(instruction, 'rejected', 'Codexが接続されていません');
        return;
      }
      if (!workspace) {
        acknowledgeRemoteInstruction(instruction, 'rejected', 'PCで作業フォルダを選択してください');
        return;
      }

      let threadId = rootThreadId;
      if (!threadId) {
        const result = await window.pixelCodex.startThread(workspace, {
          model: resolveModelId(modelSettings),
          effort: modelSettings.effort,
        });
        threadId = result.threadId;
        setRootThread(threadId);
      }

      const request = instruction.text.trim();
      startProject(request.split(/\r?\n/)[0].slice(0, 40));
      await window.pixelCodex.sendTask(threadId, `${request}${directorBriefing()}`);
      addMessage({ agentId: threadId, role: 'user', text: request });
      addLog('通信担当がAndroidからの指示を統括責任者へ渡しました', 'success', threadId);
      setCommunicationNotice('Androidからの指示をCodexへ送信しました');
      acknowledgeRemoteInstruction(instruction, 'started', 'Codexが指示を受け付けました');
    } catch (error) {
      const detail = errorMessage(error);
      addLog(`Androidからの指示を送信できませんでした：${detail}`, 'error');
      setCommunicationNotice(detail);
      acknowledgeRemoteInstruction(instruction, 'failed', detail);
    } finally {
      remoteInstructionRunning.current = false;
    }
  }

  function receiveRemoteInstruction(instruction: RemoteInstruction): void {
    if (!communicationPolicy.enabled || !communicationPolicy.allowRemoteInstructions) {
      acknowledgeRemoteInstruction(instruction, 'rejected', 'PC側でスマートフォンからの指示が無効です');
      return;
    }
    if (connection !== 'connected' || !workspace) {
      const detail = connection !== 'connected'
        ? 'Codexが接続されていません'
        : 'PCで作業フォルダを選択してください';
      acknowledgeRemoteInstruction(instruction, 'rejected', detail);
      return;
    }

    const rootIsWorking = rootAgent
      ? !['idle', 'done', 'error'].includes(rootAgent.status)
      : false;
    if (rootIsWorking || remoteInstructionRunning.current) {
      if (remoteQueue.length >= 20) {
        acknowledgeRemoteInstruction(instruction, 'rejected', '遠隔指示の待ち行列が上限に達しています');
        return;
      }
      remoteQueueObservedWork.current = rootIsWorking;
      setRemoteQueue((current) => [...current, instruction]);
      addLog('Androidからの追加指示を待ち行列へ登録しました', 'info', rootThreadId);
      setCommunicationNotice('Androidからの追加指示を待ち行列へ登録しました');
      acknowledgeRemoteInstruction(instruction, 'queued', '現在の作業が終わり次第実行します');
      return;
    }
    void executeRemoteInstruction(instruction);
  }

  /**
   * 赤ペン先生から届いた赤入れの引き取り。合図を受けてから取りに行く形にしているのは、
   * 画面が立ち上がる前に届いたぶんを取りこぼさないためです。
   */
  async function drainBridgeTasks(): Promise<void> {
    try {
      const arrived = await window.pixelCodex.drainBridgeTasks();
      if (!arrived.length) return;
      setBridgeTasks((current) => [...current, ...arrived]);
      addLog(
        `赤ペン先生から赤入れが${arrived.length}件届きました。内容を確かめて送ってください`,
        'info',
        communicatorAgentId,
      );
    } catch {
      // 受け取り口が閉じている起動もあります。次の合図で取りに行けば足ります。
    }
  }

  function forgetBridgeTask(taskId: string): void {
    // 添付を外すのは状態の更新なので、更新の途中ではなくここで済ませます。
    const target = bridgeTasks.find((entry) => entry.taskId === taskId);
    if (target) {
      taskAttachments.removeByPath(target.imagePath);
      if (bridgeAdoptedPath.current === target.imagePath) bridgeAdoptedPath.current = '';
    }
    setBridgeTasks((current) => current.filter((entry) => entry.taskId !== taskId));
  }

  /** 届いた赤入れの対象フォルダへ移ります。黙って移らないのは、進行中の会話が壊れるためです。 */
  function adoptBridgeWorkspace(target: string): void {
    void switchWorkspace(target);
  }

  /** 利用者が取り下げたとき。赤ペン先生へ理由を返し、預かった画像も片付けます。 */
  function declineBridgeTask(taskId: string): void {
    void window.pixelCodex.updateBridgeTask({
      taskId,
      outcome: 'declined',
      detail: 'Pixel Codexで取り下げられました',
    });
    forgetBridgeTask(taskId);
    addLog('赤ペン先生から届いた赤入れを取り下げました', 'warning', communicatorAgentId);
  }

  useEffect(() => {
    void drainBridgeTasks();
    return window.pixelCodex.onBridgeTaskAvailable(() => void drainBridgeTasks());
  }, []);

  useEffect(() => {
    void window.pixelCodex.getBridgeStatus().then(setBridgeStatus).catch(() => undefined);
    return window.pixelCodex.onBridgeStatus(setBridgeStatus);
  }, []);

  // 取り下げでは預かった一覧を引き当てるので、一覧が変わるたびに登録し直します。
  useEffect(() => window.pixelCodex.onBridgeCancel((taskId) => {
    forgetBridgeTask(taskId);
    addLog('赤ペン先生が赤入れを取り下げました', 'info', communicatorAgentId);
  }), [bridgeTasks]);

  /**
   * 届いた赤入れを指示欄へ下ろします。書きかけの文章は上書きしません。捨てられると
   * 困るからで、そのときは帯の「指示を差し替える」で置き換えられます。
   */
  useEffect(() => {
    const pending = bridgeTasks[0];
    if (!pending || bridgeAdoptedPath.current === pending.imagePath) return;
    bridgeAdoptedPath.current = pending.imagePath;
    setTask((current) => (current.trim() ? current : pending.instruction));
    void taskAttachments.adoptPaths([pending.imagePath]);
  }, [bridgeTasks]);

  /**
   * 送った赤入れが終わったかどうか。送った直後はまだ手が空いたままなので、
   * 一度は働いている状態を見てから、空いたところで終わったと判断します。
   */
  useEffect(() => {
    const taskId = bridgeStartedTaskId.current;
    if (!taskId || !rootAgent) return;
    const working = !['idle', 'done', 'error'].includes(rootAgent.status);
    if (working) {
      bridgeObservedWork.current = true;
      return;
    }
    if (!bridgeObservedWork.current) return;
    bridgeObservedWork.current = false;
    bridgeStartedTaskId.current = '';
    void window.pixelCodex.updateBridgeTask({
      taskId,
      outcome: rootAgent.status === 'error' ? 'failed' : 'completed',
      detail: rootAgent.status === 'error' ? 'Codexが作業を完了できませんでした' : '作業が終わりました',
    });
  }, [rootAgent?.status]);

  useEffect(() => window.pixelCodex.onRemoteStatus(setRemoteStatus), []);

  useEffect(() => window.pixelCodex.onRemotePairing((event) => {
    if (event.phase === 'open') return;
    setPairingSession(null);
    if (event.phase === 'paired') {
      setCommunicationNotice(`${event.deviceName ?? 'Android端末'}とペアリングしました。ケーブルなしで接続できます`);
      return;
    }
    const reasons: Record<string, string> = {
      expired: 'ペアリングの有効期限が切れました。もう一度開始してください',
      cancelled: 'ペアリングの受付を終了しました',
      failed: 'ペアリングを中止しました',
    };
    setCommunicationNotice(event.detail ?? reasons[event.phase] ?? 'ペアリングを終了しました');
  }), []);

  // 残り時間の表示。0になった時点でメイン側も自動的に受付を閉じます。
  useEffect(() => {
    if (!pairingSession) return undefined;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.round((pairingSession.expiresAt - Date.now()) / 1000));
      setPairingRemaining(remaining);
      if (remaining === 0) setPairingSession(null);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [pairingSession]);

  useEffect(() => {
    window.pixelCodex
      .getRemoteHostInfo()
      .then((info) => {
        setRemoteHostId(info.hostId);
        setRemoteStatus(info.status);
        setRemoteLanAddress(info.lanAddress);
      })
      .catch((error) => setCommunicationNotice(errorMessage(error)));
    window.pixelCodex.getDriveStatus().then(setDriveStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.pixelCodex.configureRemoteGateway({
        enabled: communicationPolicy.enabled,
        relayUrl: communicationPolicy.relayUrl,
        autoReconnect: communicationPolicy.autoReconnect,
      }).then(setRemoteStatus).catch((error) => {
        setRemoteStatus({ phase: 'error', label: 'Gateway設定エラー', error: errorMessage(error) });
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    communicationPolicy.enabled,
    communicationPolicy.relayUrl,
    communicationPolicy.autoReconnect,
  ]);

  useEffect(
    () => window.pixelCodex.onRemoteInstruction(receiveRemoteInstruction),
    [
      communicationPolicy.enabled,
      communicationPolicy.allowRemoteInstructions,
      connection,
      workspace,
      rootThreadId,
      rootAgent?.status,
      remoteQueue.length,
      modelSettings.modelId,
      modelSettings.customModelId,
      modelSettings.effort,
    ],
  );

  useEffect(
    () => window.pixelCodex.onRemoteApproval((response) => void receiveRemoteApproval(response)),
    [communicationPolicy.enabled, communicationPolicy.allowRemoteApprovals, approval],
  );

  useEffect(
    () => window.pixelCodex.onRemoteQuestion((response) => void receiveRemoteQuestion(response)),
    [communicationPolicy.enabled, communicationPolicy.allowRemoteApprovals, questionRequest],
  );

  useEffect(() => {
    const latestMessage = formatCommunicationMessage(
      messages[messages.length - 1]?.text,
      communicationPolicy,
    );
    void window.pixelCodex.updateRemoteState({
      workspace,
      connection,
      connectionLabel,
      rootThreadId,
      // 端末には日本語のまま出したいので、内部の状態名ではなく表示用の言い方を送ります。
      rootStatus: rootAgent ? statusLabels[rootAgent.status] : undefined,
      rootName: rootAgent?.name,
      busy: Boolean(rootAgent && !['idle', 'done', 'error'].includes(rootAgent.status)),
      pendingInstructions: remoteQueue.length,
      approvalPending: Boolean(approval),
      questionPending: Boolean(questionRequest),
      approval: formatRemoteApproval(approval, communicationPolicy),
      question: formatRemoteQuestion(questionRequest, communicationPolicy),
      latestMessage,
      updatedAt: Date.now(),
    });
  }, [
    workspace,
    connection,
    connectionLabel,
    rootThreadId,
    rootAgent?.status,
    rootAgent?.name,
    remoteQueue.length,
    approval,
    questionRequest,
    messages,
    communicationPolicy,
  ]);

  /**
   * 端末が選べる撮影対象。`state.snapshot`には載せず、変わったときだけメインへ預けます。
   * あれは返事が1文字進むたびに端末へ流れる経路なので、滅多に変わらない選択肢を
   * 混ぜても通信量が増えるだけだからです。
   */
  const previewSources = useMemo<PreviewSource[]>(() => {
    const urls: PreviewSource[] = communicationPolicy.previewUrls.map((url) => ({
      id: `url:${url}`,
      kind: 'url',
      label: url,
      url,
    }));
    if (!workspace) return urls;
    const files: PreviewSource[] = deliverables
      .filter((deliverable) => deliverable.kind !== 'deleted' && isPreviewableFile(deliverable.path))
      .slice(-8)
      .map((deliverable) => ({
        id: `file:${deliverable.path}`,
        kind: 'file',
        label: fileName(deliverable.path),
        workspace,
        relativePath: deliverable.path,
      }));
    return [...urls, ...files];
  }, [communicationPolicy.previewUrls, deliverables, workspace]);

  /**
   * 報告の全文と進行表。`state.snapshot`には載せず、変わったときだけメインへ預けます。
   * 端末はこれを見たいときに取りに来るので、要約が途中で切れていても全文を読めます。
   */
  useEffect(() => {
    const steps = roadmap.steps.slice(0, 40).map((step) => ({
      title: step.title.slice(0, 120),
      owner: step.owner?.slice(0, 40),
      statusLabel: roadmapStatusLabels[step.status],
      done: step.status === 'done',
      active: step.status === 'active',
    }));
    void window.pixelCodex.setRemoteDetail({
      report: messages[messages.length - 1]?.text ?? '',
      roadmap: {
        messageId: '',
        title: roadmap.title,
        steps,
        doneCount: steps.filter((step) => step.done).length,
      },
    });
  }, [messages, roadmap]);

  useEffect(() => {
    void window.pixelCodex.setRemotePreviewSources(
      communicationPolicy.enabled && communicationPolicy.allowRemotePreview,
      previewSources,
    );
  }, [communicationPolicy.enabled, communicationPolicy.allowRemotePreview, previewSources]);

  useEffect(() => {
    if (!remoteQueue.length || remoteInstructionRunning.current) return;
    const rootIsWorking = rootAgent
      ? !['idle', 'done', 'error'].includes(rootAgent.status)
      : false;
    if (rootIsWorking) {
      remoteQueueObservedWork.current = true;
      return;
    }
    // A queued instruction must observe the current turn running and then becoming idle.
    // This prevents two commands arriving together from starting two turns at once.
    if (!remoteQueueObservedWork.current) return;
    remoteQueueObservedWork.current = false;
    const next = remoteQueue[0];
    setRemoteQueue((current) => current.slice(1));
    void executeRemoteInstruction(next);
  }, [remoteQueue, rootAgent?.status, connection, workspace]);

  /**
   * ひとつのスレッドへ文章を届けます。作業中なら割り込み（steer）、手が空いていれば
   * 新しい依頼（turn/start）になります。ターン番号はイベントの届き方で実際より
   * 古くなることがあるので、割り込みを断られたら新しい依頼として送り直します。
   */
  async function deliverToThread(
    threadId: string,
    turnId: string | undefined,
    text: string,
    attachments: Attachment[],
  ): Promise<void> {
    const files = sendableAttachments(attachments);
    if (turnId) {
      try {
        await window.pixelCodex.steerAgent(threadId, turnId, text, files);
        return;
      } catch (error) {
        // サブエージェントへの直接入力は送り直しても通らないので、呼び出し元へ返します。
        if (errorMessage(error).includes('SUBAGENT_DIRECT_INPUT_BLOCKED')) throw error;
      }
    }
    await window.pixelCodex.sendTask(threadId, text, files);
  }

  /**
   * 追加指示。Codexはサブエージェントのスレッドへの直接入力を拒否するので
   * （"direct app-server input is not allowed for multi-agent v2 sub-agents"）、
   * 相手が担当者のときは統括責任者あての伝言に切り替えて中継します。
   */
  async function relayInstruction(threadId: string, text: string): Promise<void> {
    const attachments = steerAttachments.attachments;
    const message = `【${selected?.name ?? '担当者'}への追加指示】${text}${attachmentNote(attachments)}\nこの内容を担当者へ伝えて、作業に反映させてください。`;
    await deliverToThread(threadId, rootAgent?.turnId, message, attachments);
  }

  async function steerSelected(): Promise<void> {
    const text = steerText.trim();
    if (!selected || !text) return;
    if (connection !== 'connected') {
      setNotice('先にCodexへ接続してください。現在は画面確認用のデモ表示です。');
      return;
    }
    setBusy(true);
    const attachments = steerAttachments.attachments;
    const withFiles = `${text}${attachmentNote(attachments)}`;
    const logged = `${text}${attachmentSummary(attachments)}`;
    try {
      const isRootThread = Boolean(selected.threadId) && selected.threadId === rootThreadId;
      if (selected.virtual) {
        // 経理担当はCodexのスレッドを持たないので、統括責任者へ回します。
        if (!rootThreadId) throw new Error('統括責任者のスレッドがまだありません。');
        await relayInstruction(rootThreadId, text);
        addLog('経理担当あての指示を統括責任者に伝えました', 'success', selected.id);
      } else if (isRootThread) {
        // 作業中なら割り込み、手が空いていれば新しい依頼として届きます。
        await deliverToThread(
          selected.threadId as string,
          selected.turnId,
          withFiles,
          attachments,
        );
        addLog(
          selected.turnId ? '追加指示を送りました' : '新しい指示として送りました',
          'success',
          selected.id,
        );
      } else {
        if (!rootThreadId) throw new Error('統括責任者のスレッドがまだありません。');
        await relayInstruction(rootThreadId, text);
        addLog(
          `${selected.name}への指示を統括責任者に中継しました`,
          'success',
          selected.id,
        );
      }
      addMessage({ agentId: selected.id, role: 'user', text: logged });
      setSteerText('');
      steerAttachments.clear();
    } catch (error) {
      const message = errorMessage(error);
      // 直接入力を拒否された場合も、統括責任者ごしにもう一度試します。
      if (message.includes('SUBAGENT_DIRECT_INPUT_BLOCKED') && rootThreadId) {
        try {
          await relayInstruction(rootThreadId, text);
          addMessage({ agentId: selected.id, role: 'user', text: logged });
          addLog('直接指示できないため、統括責任者ごしに伝えました', 'warning', selected.id);
          setSteerText('');
          steerAttachments.clear();
          return;
        } catch (retryError) {
          setNotice(errorMessage(retryError));
          addLog(errorMessage(retryError), 'error', selected.id);
          return;
        }
      }
      setNotice(message);
      addLog(message, 'error', selected.id);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 「ただいまの発生経費」を0円に戻します。数え直すのはこれから先のぶんだけで、
   * 保存済みの会計報告はそのまま残ります。
   */
  function resetPayroll(): void {
    if (
      totalYen > 0 &&
      !window.confirm(
        'ただいまの発生経費を0円に戻します。\n保存済みの会計報告は消えません。よろしいですか？',
      )
    ) {
      return;
    }
    resetUsage();
    addLog('発生経費を0円にリセットしました（保存済みの会計報告はそのままです）', 'info');
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
      duty: 'coder',
      specialty: '',
      personality: '',
      color: agentColors[Math.floor(Math.random() * agentColors.length)],
    });
    setCreatingAgent(false);
  }

  const activeCount = agents.filter((agent) =>
    ['planning', 'researching', 'coding', 'running'].includes(agent.status),
  ).length;

  /**
   * 看板の中身。承認・回答待ちを先頭に、あとは名簿の並びのままにします。
   * 並び順を変えないのは、カードが動き回ると読みづらくなるためです。
   */
  const signboard = useMemo(() => {
    const waitingId = approval?.agentId ?? questionRequest?.agentId;
    // 何も待っていないときの waitingId は undefined です。threadId を持たない経理担当と
    // うっかり一致してしまい、ずっと「返事待ち」に見えていたので、必ず値の有無で守ります。
    const isWaitingFor = (agent: AgentState): boolean =>
      Boolean(waitingId) && (agent.id === waitingId || agent.threadId === waitingId);
    // 何を聞かれているのかを、名簿の一行目にそのまま出します。「返事を待機中」だけでは
    // 社長が画面を開き直さないと用件が分からないためです。
    const waitingSubject = ((): string => {
      if (approval) return approval.headline || approval.title;
      const question = questionRequest?.questions[0];
      if (!question) return '';
      const extra = (questionRequest?.questions.length ?? 0) - 1;
      const text = question.header || question.question;
      return extra > 0 ? `${text}（ほか${extra}件）` : text;
    })();
    const working: SignEntry[] = [];
    const attention: SignEntry[] = [];
    let resting = 0;
    let left = 0;

    for (const agent of agents) {
      const presence = agent.presence ?? 'working';
      if (presence === 'left') {
        left += 1;
        continue;
      }
      if (presence === 'lounge') {
        resting += 1;
        continue;
      }
      const waiting = agent.status === 'approval' || isWaitingFor(agent);
      // 経理担当はプロジェクトの作業ではないので、返事待ちのときだけ載せます。
      if (!waiting && (agent.virtual || !['planning', 'researching', 'coding', 'running', 'error'].includes(agent.status))) {
        continue;
      }
      const entry: SignEntry = {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        room: roomNameFor(agent.status, agent.duty, presence),
        color: agent.color,
        headline: waiting
          ? waitingSubject || 'あなたの返事を待機中'
          : signHeadline(agent),
        tone: waiting ? 'attention' : 'work',
      };
      if (waiting) attention.push(entry);
      else working.push(entry);
    }

    const ordered = [...attention, ...working];
    return {
      // 名簿の各行に「いまの作業」を出すための引き当て表。作業看板を名簿に統合したので、
      // 看板が持っていた見出しはここから配ります。
      byId: new Map(ordered.map((entry) => [entry.id, entry])),
      workingCount: ordered.length,
      attentionCount: attention.length,
      resting,
      left,
    };
  }, [agents, approval, questionRequest]);

  // 名簿の並び：返事待ち → 作業中 → 待機 → 休憩 → 退勤。上から見れば手番が分かります。
  const rosterAgents = useMemo(() => {
    const rank = (agent: AgentState): number => {
      const presence = agent.presence ?? 'working';
      if (presence === 'left') return 4;
      if (presence === 'lounge') return 3;
      const entry = signboard.byId.get(agent.id);
      if (entry?.tone === 'attention') return 0;
      if (entry) return 1;
      return 2;
    };
    return agents
      .map((agent, index) => ({ agent, index }))
      .sort((a, b) => rank(a.agent) - rank(b.agent) || a.index - b.index);
  }, [agents, signboard]);

  const signboardIdleNote =
    connection !== 'connected'
      ? 'Codexへの接続を待っています'
      : signboard.resting > 0
        ? `作業はすべて終わりました。${signboard.resting}名が休憩スペースにいます`
        : '手を動かしている人はいません。指示をどうぞ';
  const progressWaiting = approval
    ? { tone: 'attention', text: 'あなたの承認を待っています' }
    : questionRequest
      ? { tone: 'attention', text: 'あなたの回答を待っています' }
      : roadmapProgress.active
        ? { tone: 'working', text: `作業中：「${roadmapProgress.active}」の完了を待っています` }
        : activeCount > 0
          ? { tone: 'working', text: `${activeCount}名が作業を続けています` }
          : roadmap.steps.length > 0 && roadmapProgress.done === roadmap.steps.length
            ? { tone: 'done', text: 'すべての工程が完了しました' }
            : { tone: 'idle', text: connection === 'connected' ? '次の作業開始を待っています' : 'Codexへの接続を待っています' };

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
        {/*
          幅が足りないとき、この帯はラベルを外してアイコンだけになります。どのボタンも
          消さないので、狭い画面でも押せる場所が変わりません。`title` は畳んだときの
          手がかりになるため、すべてのボタンに付けてあります。
        */}
        <div className="game-menu-buttons">
          <button className="save-button" type="button" title="セーブ／ロード" onClick={() => void openSaves()}>
            <i className="menu-icon" aria-hidden="true">▣</i>
            <span>セーブ</span>
            <strong className="menu-glyph">▣</strong>
          </button>
          <button className="library-button" type="button" title="図書館（作業フォルダの中身を見る）" onClick={() => void showLibrary()}>
            <i className="menu-icon" aria-hidden="true">本</i>
            <span>図書館</span>
            <strong className="menu-glyph">本</strong>
          </button>
          <button className="staff-button" type="button" title="社員名簿（担当者の雇用と解雇）" onClick={() => setStaffOpen(true)}>
            <i className="menu-icon" aria-hidden="true">人</i>
            <span>社員名簿</span>
            <strong>{hiredProfiles.length}</strong>
          </button>
          <button
            className={`skill-button ${skillBox.equipped.length ? 'has-results' : ''}`}
            type="button"
            title="スキルブック（装備したルールが次の指示から効きます）"
            onClick={() => setSkillsOpen(true)}
          >
            <i className="menu-icon" aria-hidden="true">技</i>
            <span>スキル</span>
            <strong>{skillBox.equipped.length || '技'}</strong>
          </button>
          <button
            className={`blackboard-button ${deliverables.length ? 'has-results' : ''}`}
            type="button"
            title="成果物ボード（できあがったものの一覧）"
            onClick={() => setBlackboardOpen(true)}
          >
            <i className="menu-icon" aria-hidden="true">品</i>
            <span>成果物</span>
            <strong>{deliverables.length}</strong>
          </button>
          <button
            className={`communication-button ${communicationPolicy.enabled ? 'enabled' : ''}`}
            type="button"
            title="Android連携の通信・通知設定"
            onClick={() => setCommunicationOpen(true)}
          >
            <i className="menu-icon" aria-hidden="true">信</i>
            <span>通信室</span>
            <strong>{remoteStatus.phase === 'connected' ? 'LIVE' : communicationPolicy.enabled ? 'ON' : 'OFF'}</strong>
          </button>
          <button
            className={`report-button ${accountingReports.length ? 'has-results' : ''}`}
            type="button"
            title={`経理担当の会計報告（保存済み ${accountingReports.length}件）`}
            onClick={() => {
              if (!accountingReport && accountingReports[0]) openAccountingReport(accountingReports[0].id);
              else if (!accountingReport) buildAccountingReport('途中経過の確認');
              setReportOpen(true);
            }}
          >
            <i className="menu-icon" aria-hidden="true">計</i>
            <span>会計報告</span>
            <strong>{accountingReports.length || '￥'}</strong>
          </button>
        </div>
        <div className="connection-box">
          <span className={`connection-dot ${connection}`} />
          <div><small>APP SERVER</small><strong>{connectionLabel}</strong></div>
          <div className="model-switcher">
            <button
              className="model-button"
              type="button"
              onClick={() => setModelPanelOpen((value) => !value)}
              title="AIモデルを変更"
            >
              <small>AIモデル</small>
              <strong>{modelLabel(modelSettings)}</strong>
            </button>
            {modelPanelOpen && (
              <section className="model-panel" aria-label="AIモデルの設定">
                <header>
                  <strong>AIモデルの設定</strong>
                  <button type="button" aria-label="閉じる" onClick={() => setModelPanelOpen(false)}>×</button>
                </header>
                <label>
                  つかうモデル
                  <select
                    value={modelSettings.modelId}
                    onChange={(event) => setModelSettings({ modelId: event.target.value })}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.id || 'default'} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <p className="model-note">
                  {modelSettings.customModelId.trim()
                    ? '下の手入力が優先されます。'
                    : modelOptions.find((option) => option.id === modelSettings.modelId)?.note}
                </p>
                <label>
                  考える深さ
                  <select
                    value={modelSettings.effort}
                    onChange={(event) => setModelSettings({ effort: event.target.value })}
                  >
                    {effortOptions.map((option) => (
                      <option key={option.id || 'default'} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  モデル名を直接入力（上級者向け）
                  <input
                    value={modelSettings.customModelId}
                    onChange={(event) => setModelSettings({ customModelId: event.target.value })}
                    placeholder="例: gpt-5-codex"
                  />
                </label>
                <p className="model-note">
                  変更は<strong>次に接続したとき</strong>、または新しい作業フォルダに切り替えたときから有効になります。
                  料金メーターの単価も自動で合わせます。
                </p>
              </section>
            )}
          </div>
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

      {configWarning && (
        <div className="config-warning" role="alert">
          <strong>Codexの設定ファイルに問題があります</strong>
          <span>
            この状態だと作業スレッドを作れず、接続できません。
            下の場所を直してから、もう一度「接続」を押してください。
          </span>
          <code>{configWarning}</code>
          <button type="button" onClick={clearConfigWarning}>×</button>
        </div>
      )}

      {/*
        経費・HP・進行表をひとつの細いHUDにまとめます。3本の帯が積み上がると
        開発フロア図の高さを食うので、ここは要点だけを出し、詳しい数字は
        「明細」と「進行表」のウィンドウに任せます。
      */}
      <section className="hud-bar" aria-label="ステータスHUD">
        <button
          className="hud-cell hud-payroll"
          type="button"
          onClick={() => setPayrollOpen(true)}
          title={`ただいまの発生経費 ￥${totalYen.toFixed(2)}／入力 ${formatTokens(usage.input)}・出力 ${formatTokens(usage.output)}・合計 ${formatTokens(usedTokens)}トークン。押すと明細をひらきます`}
        >
          <span className="hud-coin" key={usageUpdatedAt} aria-hidden="true">￥</span>
          <span className="hud-payroll-body">
            <strong className="hud-yen" aria-live="polite">
              <i>￥</i>
              <span className="hud-digits">{yenDigits.main}</span>
              <em>.{yenDigits.fraction}</em>
            </strong>
            <span className="hud-gauge" aria-hidden="true">
              <i style={{ width: `${milestoneRatio * 100}%` }} />
            </span>
          </span>
          <span
            className={`hud-live ${usageUpdatedAt ? 'active' : 'waiting'}`}
            title={usageUpdatedAt
              ? `最終更新 ${new Date(usageUpdatedAt).toLocaleTimeString('ja-JP')}`
              : '最初のモデル応答後に自動で更新されます'}
          ><i />{usageUpdatedAt ? 'LIVE' : '待機'}</span>
        </button>

        {/* AIの使用残量はゲームのHPとして見せます。Codexが枠を教えてくれるときだけ本物の数字が出ます。 */}
        <div
          className={`hud-cell hud-hp ${hpMain ? hpMain.tone : 'unknown'}`}
          aria-label="HP（AI使用残量）"
          title={hpMain
            ? `${hpMain.label}／${hpMain.reset || '回復時刻は未提供'}`
            : connection === 'connected'
              ? 'このプランでは残量が取得できません'
              : '接続すると表示されます'}
        >
          <span className="hud-hp-label">HP</span>
          <span className="hp-bar">
            <i style={{ width: `${hpMain?.remaining ?? 0}%` }} />
            <span className="hp-notches" aria-hidden="true" />
          </span>
          <strong className="hud-hp-value" aria-live="polite">
            {hpMain ? Math.round(hpMain.remaining) : '??'}
            <em>/100</em>
          </strong>
          {hpSub && (
            <span className="hud-hp-sub" title={`${hpSub.label}の残量 ${Math.round(hpSub.remaining)}%`}>
              <small>{hpSub.label}</small>
              <span className="hp-sub-bar">
                <i className={hpSub.tone} style={{ width: `${hpSub.remaining}%` }} />
              </span>
            </span>
          )}
        </div>

        <div className="hud-cell hud-status">
          <span className={`roadmap-waiting ${progressWaiting.tone}`}>
            <i />{progressWaiting.text}
          </span>
        </div>
      </section>

      <section className="dashboard">
        <div className="office-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">DEV STUDIO</span><h2>開発フロア</h2></div>
            <div className="office-stats">
              <span><b>{agents.length - signboard.left}</b> 出勤</span>
              <span><b>{activeCount}</b> 稼働中</span>
              <span><b>{signboard.resting}</b> 休憩</span>
              <span><b>{signboard.left}</b> 退勤</span>
            </div>
          </div>
          <div className="office-stage">
            <PhaserCanvas />
          </div>
          {/*
            赤ペン先生から届いた赤入れ。受け取っただけでは動かさないので、内容を
            この帯で確かめてから、下の指示欄でいつもどおり送ってもらいます。
          */}
          {pendingBridgeTask && (
            <section className="bridge-arrival" aria-label="赤ペン先生から届いた赤入れ">
              <div className="bridge-arrival-head">
                <span className="eyebrow">赤ペン先生</span>
                <strong>赤入れが届きました</strong>
                <span className={`bridge-arrival-mode ${pendingBridgeTask.mode === 'Edit' ? 'edit' : 'discuss'}`}>
                  {pendingBridgeTask.mode === 'Edit' ? '修正する' : '提案のみ'}
                </span>
                {bridgeTasks.length > 1 && (
                  <span className="bridge-arrival-queue">他に {bridgeTasks.length - 1} 件</span>
                )}
              </div>
              <p className="bridge-arrival-path" title={pendingBridgeTask.workingDirectory}>
                対象フォルダ {pendingBridgeTask.workingDirectory}
              </p>
              {bridgeWorkspaceDiffers && (
                <p className="bridge-arrival-warn">
                  いま開いている作業フォルダと違います。切り替えるまで、この赤入れは今の
                  フォルダに対する依頼として送られます。
                  <button
                    type="button"
                    onClick={() => adoptBridgeWorkspace(pendingBridgeTask.workingDirectory)}
                  >
                    切り替える
                  </button>
                </p>
              )}
              {bridgeBlockedReason && <p className="bridge-arrival-warn">{bridgeBlockedReason}</p>}
              <div className="bridge-arrival-actions">
                <small>内容を確かめて、下の指示欄から送ってください</small>
                <button
                  type="button"
                  onClick={() => setTask(pendingBridgeTask.instruction)}
                  disabled={task.trim() === pendingBridgeTask.instruction.trim()}
                >
                  指示を差し替える
                </button>
                <button
                  type="button"
                  className="bridge-arrival-decline"
                  onClick={() => declineBridgeTask(pendingBridgeTask.taskId)}
                >
                  取り下げる
                </button>
              </div>
            </section>
          )}
          <form
            className={`task-composer ${taskAttachments.dragging ? 'dropping' : ''}`}
            onSubmit={submitTask}
            {...taskAttachments.dropHandlers}
          >
            <div className="composer-label">
              <span>NEW PROJECT</span>
              <small>新しい開発を始める</small>
              <em className="composer-hotkey">Ctrl + Enter で送信</em>
            </div>
            <div className="composer-input">
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                onKeyDown={(event) => submitOnHotkey(event, () => void submitTask())}
                onPaste={taskAttachments.handlePaste}
                rows={2}
                placeholder="実現したいことを入力…（Ctrl+Enterで送信）"
              />
              <AttachmentTray
                box={taskAttachments}
                hint="ファイルをドロップ、Ctrl+Vでスクショの貼り付けもできます"
              />
            </div>
            <button className="primary-button" type="submit" disabled={busy || !task.trim()}>
              {busy ? '送信中…' : '開始 →'}
            </button>
          </form>
        </div>

        {/*
          進行表：フロア図のすぐ右に、上から下へ流れる縦長の掲示板として立てます。
          横帯だとフロア図の高さを削るうえ、工程が増えると横に流れて読めなくなるためです。
        */}
        <section className="panel roadmap-column" aria-label="プロジェクト進行表">
          <div className="panel-heading compact">
            <div><span className="eyebrow">ROADMAP</span><h2>進行表</h2></div>
            <span className="roadmap-column-count">
              {roadmapProgress.done}/{roadmap.steps.length || '―'}
            </span>
          </div>
          <p className="roadmap-column-title" title={roadmap.title}>
            {roadmap.title || 'まだ進行表はありません'}
          </p>
          <div className="roadmap-column-body">
            <RoadmapMilestones steps={roadmap.steps} vertical />
          </div>
          <div className="roadmap-column-foot">
            <small className={`roadmap-waiting ${progressWaiting.tone}`}>
              <i />{progressWaiting.text}
            </small>
            <span>経過 {projectStartedAt ? formatElapsed(Date.now() - projectStartedAt) : '―'}</span>
            <span>{directorAgent?.name ?? '東葛大五郎'} が進行管理</span>
            <button className="roadmap-open" type="button" onClick={() => setRoadmapOpen(true)}>
              進行表をひらく →
            </button>
          </div>
        </section>

        <aside className="sidebar panel">
          <div className="side-tabs" role="tablist" aria-label="右カラムの表示切り替え">
            {sideTabs.map((tab) => {
              const badge = tab.id === 'roster'
                ? String(agents.length)
                : tab.id === 'meeting' && messages.length
                  ? String(messages.length)
                  : '';
              const attention =
                (tab.id === 'roster' && signboard.attentionCount > 0) ||
                (tab.id === 'meeting' && Boolean(questionRequest));
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={sideTab === tab.id}
                  className={`side-tab ${sideTab === tab.id ? 'active' : ''} ${attention ? 'attention' : ''}`}
                  onClick={() => setSideTab(tab.id)}
                  title={tab.eyebrow}
                >
                  <span>{tab.label}</span>
                  {badge && <b>{badge}</b>}
                </button>
              );
            })}
          </div>

          {/* 出勤名簿。作業看板をここへ畳んだので、行そのものが「いまの作業」を告げます。 */}
          {sideTab === 'roster' && (
            <section className="side-body floor-roster" aria-label="出勤名簿">
              {signboard.workingCount === 0 && (
                <p className="roster-idle">{signboardIdleNote}</p>
              )}
              <div className="floor-roster-list">
                {rosterAgents.map(({ agent, index }) => {
                  const presence = agent.presence ?? 'working';
                  const sign = signboard.byId.get(agent.id);
                  // 上段が担当名なので、下段はいまの動きを出します。手が空いている人だけ
                  // 「待機中」に落として、担当名を二度書きしないようにしています。
                  const line = sign
                    ? sign.headline
                    : presence === 'lounge'
                      ? '休憩スペースで待機中'
                      : presence === 'left'
                        ? '退勤しました'
                        : agent.activity || '手が空いています';
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={`floor-roster-row ${agent.id === selected?.id ? 'selected' : ''} ${presence} ${sign?.tone ?? ''}`}
                      onClick={() => {
                        selectAgent(agent.id);
                        setSideTab('profile');
                      }}
                      title={`${agent.name}（${agent.role}）｜${line}`}
                    >
                      <span className="roster-number">{String(index + 1).padStart(2, '0')}</span>
                      <img
                        className="roster-avatar"
                        src={characterPortrait(agent.color)}
                        alt=""
                        width={PORTRAIT_SIZE}
                        height={PORTRAIT_SIZE}
                      />
                      <span className="agent-copy">
                        <span className="roster-who">
                          <strong>{agent.name}</strong>
                          <small>{sign ? sign.room : agent.role}</small>
                        </span>
                        <em className="roster-line">{line}</em>
                      </span>
                      <span className={`status-dot ${agent.status}`} title={statusLabels[agent.status]} />
                    </button>
                  );
                })}
              </div>
              <footer>
                <span>● 稼働 {activeCount}/{agents.length}</span>
                <strong>休憩 {signboard.resting}／退勤 {signboard.left}</strong>
              </footer>
            </section>
          )}

          {sideTab === 'profile' && !selected && (
            <div className="side-body side-empty">
              <p>名簿タブか、フロア図の社員をクリックすると、ここに担当と追加指示の欄が出ます。</p>
            </div>
          )}

          {sideTab === 'profile' && selected && (
            <section className="side-body detail-panel">
              <div className="detail-title"><div><span className="eyebrow">STAFF PROFILE</span><h2>{selected.name}</h2></div><span className={`status-pill ${selected.status}`}>{statusLabels[selected.status]}</span></div>
              <dl>
                <div><dt>担当</dt><dd>{selected.role}</dd></div>
                <div><dt>いる場所</dt><dd>{dutyLabels[selected.duty]}</dd></div>
                <div><dt>現在の仕事</dt><dd title={selected.task}>{selected.task}</dd></div>
                <div><dt>動作</dt><dd title={selected.activity}>{selected.activity}</dd></div>
                <div><dt>THREAD</dt><dd className="mono" title={selected.threadId}>{shortId(selected.threadId)}</dd></div>
              </dl>
              <div
                className={`steer-input ${steerAttachments.dragging ? 'dropping' : ''}`}
                {...steerAttachments.dropHandlers}
              >
                <textarea
                  value={steerText}
                  onChange={(event) => setSteerText(event.target.value)}
                  onKeyDown={(event) => submitOnHotkey(event, () => void steerSelected())}
                  onPaste={steerAttachments.handlePaste}
                  rows={3}
                  placeholder={
                    selected.threadId === rootThreadId
                      ? 'この統括責任者へ追加指示…（Ctrl+Enterで送信）'
                      : `${selected.name}への追加指示（統括責任者ごしに伝えます）…`
                  }
                  disabled={connection !== 'connected'}
                />
                <AttachmentTray
                  box={steerAttachments}
                  disabled={connection !== 'connected'}
                  hint="ドロップ・Ctrl+Vで添付"
                />
              </div>
              <p className="detail-hint">
                {connection !== 'connected'
                  ? 'Codexへ接続すると、この欄から指示を送れるようになります。'
                  : selected.threadId === rootThreadId
                    ? '統括責任者には直接届きます。作業中なら割り込み、手が空いていれば新しい依頼になります。'
                    : '担当者には直接送れない決まりなので、統括責任者に伝えて反映してもらいます。'}
                <br />Ctrl + Enter でも送れます。
              </p>
              <div className="detail-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || connection !== 'connected' || !steerText.trim()}
                  onClick={steerSelected}
                >追加指示</button>
                <button className="danger-button" type="button" disabled={!selected.threadId || !selected.turnId} onClick={interruptSelected}>停止</button>
              </div>
            </section>
          )}

          <section className="side-body conversation-panel" hidden={sideTab !== 'meeting'}>
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

          {sideTab === 'log' && (
            <section className="side-body log-panel">
            <div className="log-list">
              {logs.slice(0, 40).map((log) => (
                <div className={`log-entry ${log.level}`} key={log.id}>
                  <time>{new Date(log.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  <p>{log.message}</p>
                </div>
              ))}
            </div>
            </section>
          )}
        </aside>
      </section>

      <footer><span>PIXEL CODEX STUDIO v{appVersion}</span><span>社員を雇用して、開発チームを育てよう</span></footer>

      {communicationOpen && (
        <div
          className="communication-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCommunicationOpen(false);
          }}
        >
          <section
            className="communication-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="communication-title"
          >
            <header className="game-window-titlebar">
              <div className="title-icon">通</div>
              <div>
                <span>ANDROID COMMUNICATION</span>
                <h2 id="communication-title">通信室・モバイル連携設定</h2>
              </div>
              <button type="button" aria-label="通信室を閉じる" onClick={() => setCommunicationOpen(false)}>×</button>
            </header>

            <div className="communication-body">
              <section className="communication-status-card">
                <div>
                  <span className={`communication-lamp ${remoteStatus.phase}`} />
                  <div>
                    <small>GATEWAY STATUS</small>
                    <strong>{remoteStatus.label}</strong>
                  </div>
                </div>
                <label className="communication-toggle">
                  <input
                    type="checkbox"
                    checked={communicationPolicy.enabled}
                    onChange={(event) => updateCommunicationPolicy({ enabled: event.target.checked })}
                  />
                  <span>Android連携を有効にする</span>
                </label>
              </section>

              <div className="communication-grid">
                <section className="communication-card">
                  <header><span>01</span><h3>ネットワーク</h3></header>
                  <label className="communication-field">
                    <span>Relay URL</span>
                    <input
                      type="url"
                      value={communicationPolicy.relayUrl}
                      placeholder="wss://relay.example.com/device"
                      onChange={(event) => updateCommunicationPolicy({ relayUrl: event.target.value })}
                    />
                  </label>
                  <label className="communication-check">
                    <input
                      type="checkbox"
                      checked={communicationPolicy.autoReconnect}
                      onChange={(event) => updateCommunicationPolicy({ autoReconnect: event.target.checked })}
                    />
                    切断時に自動で再接続する
                  </label>
                  <div className="communication-test-actions">
                    <button className="communication-test-button" type="button" onClick={validateCommunicationRelay}>
                      接続設定を確認
                    </button>
                    <button
                      className="communication-test-button qr"
                      type="button"
                      disabled={!scannableRelayUrl || !remoteHostId}
                      onClick={() => setUrlQrOpen((open) => !open)}
                    >
                      {urlQrOpen ? 'URLのQRを隠す' : 'URLのQRを表示（外部Relay用）'}
                    </button>
                    <button
                      className="communication-test-button usb"
                      type="button"
                      disabled={usbTestBusy || wirelessTestBusy}
                      onClick={() => void startUsbRemoteTest()}
                    >
                      {usbTestBusy ? 'USB接続を準備中…' : 'USB実機テストを開始'}
                    </button>
                    <button
                      className="communication-test-button wireless"
                      type="button"
                      disabled={usbTestBusy || wirelessTestBusy}
                      onClick={() => void startWirelessRemoteTest()}
                    >
                      {wirelessTestBusy ? 'Wi-Fi接続を準備中…' : 'Wi-Fi実機テストを開始（USBで初期設定）'}
                    </button>
                    <button
                      className="communication-test-button pairing"
                      type="button"
                      disabled={usbTestBusy || wirelessTestBusy || pairingBusy || Boolean(pairingSession)}
                      onClick={() => void beginWirelessPairing()}
                    >
                      {pairingBusy ? 'ペアリング準備中…' : 'ケーブルなしでペアリング'}
                    </button>
                  </div>
                  {urlQrOpen && scannableRelayUrl && remoteHostId && (
                    <div className="pairing-panel url-qr">
                      <p className="pairing-lead">
                        AndroidアプリでQRを読み取ると、Relay URLとHost IDが一度に入ります。
                        <b>このQRには認証情報が入っています。画面共有や撮影に注意してください。</b>
                      </p>
                      <PairingQr
                        value={urlPairingQr(scannableRelayUrl, remoteHostId)}
                        caption={`接続設定QR・${new URL(scannableRelayUrl).host}`}
                      />
                    </div>
                  )}
                  {pairingSession && (
                    <div className="pairing-panel">
                      <p className="pairing-lead">
                        Androidアプリで「QRで読み取る」を押すか、「PCとペアリング」に次を入力してください。
                      </p>
                      <PairingQr
                        value={lanPairingQr(pairingSession)}
                        caption={`同一Wi-Fi用・${pairingSession.lanAddress}`}
                      />
                      <dl>
                        <dt>PCのアドレス</dt>
                        <dd className="pairing-address">{pairingSession.lanAddress}</dd>
                        <dt>ペアリングコード</dt>
                        <dd className="pairing-code">{pairingSession.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</dd>
                      </dl>
                      <div className="pairing-footer">
                        <span>
                          残り {Math.floor(pairingRemaining / 60)}:{String(pairingRemaining % 60).padStart(2, '0')}
                          ／ポート {pairingSession.port}
                        </span>
                        <button type="button" onClick={cancelWirelessPairing}>受付を終了</button>
                      </div>
                    </div>
                  )}
                  <p>{remoteStatus.error ?? '「ケーブルなしでペアリング」は同じWi-Fiにいる端末とUSBなしで接続します。一度成功すれば次回からは自動接続です。'}</p>
                </section>

                <section className="communication-card">
                  <header><span>02</span><h3>スマートフォンからの指示</h3></header>
                  <label className="communication-check important">
                    <input
                      type="checkbox"
                      checked={communicationPolicy.allowRemoteInstructions}
                      onChange={(event) => updateCommunicationPolicy({ allowRemoteInstructions: event.target.checked })}
                    />
                    新規指示・追加指示を受け付ける
                  </label>
                  <label className="communication-check important">
                    <input
                      type="checkbox"
                      checked={communicationPolicy.allowRemoteApprovals}
                      onChange={(event) => updateCommunicationPolicy({ allowRemoteApprovals: event.target.checked })}
                    />
                    承認の可否と質問への回答をスマートフォンから行う
                  </label>
                  <p className="communication-caution">
                    ONにすると、コマンド実行やファイル変更の許可を手元の端末から出せるようになります。
                    承認内容は端末にも表示されます。端末を他人に渡さない前提で使ってください。
                  </p>
                  <div className="communication-rule">
                    <b>新規指示</b><span>PCで選択中の作業フォルダに新しいスレッドを開始</span>
                    <b>追加指示</b><span>実行中なら待ち行列へ、待機中ならすぐ送信</span>
                  </div>
                  <aside>承認操作と質問への回答は初期版ではPC側で行います。</aside>
                </section>

                <section className="communication-card">
                  <header><span>03</span><h3>画面プレビュー</h3></header>
                  <label className="communication-check important">
                    <input
                      type="checkbox"
                      checked={communicationPolicy.allowRemotePreview}
                      onChange={(event) => updateCommunicationPolicy({ allowRemotePreview: event.target.checked })}
                    />
                    スマートフォンからの要求で画面を撮って送る
                  </label>
                  <p className="communication-caution">
                    要求されたときだけ撮ります。自動では送りません。
                    撮った画像はそのまま端末に表示されるため、見せたくないものが映る画面は登録しないでください。
                  </p>
                  <label className="communication-field">
                    <span>プレビューURL</span>
                    <input
                      type="text"
                      value={previewUrlDraft}
                      placeholder="http://localhost:3000"
                      onChange={(event) => setPreviewUrlDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        addPreviewUrl();
                      }}
                    />
                  </label>
                  <button type="button" className="communication-button-secondary" onClick={addPreviewUrl}>
                    URLを追加
                  </button>
                  {communicationPolicy.previewUrls.length > 0 && (
                    <ul className="communication-source-list">
                      {communicationPolicy.previewUrls.map((url) => (
                        <li key={url}>
                          <span title={url}>{url}</span>
                          <button type="button" onClick={() => removePreviewUrl(url)}>削除</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <aside>
                    開発中のアプリやブラウザなど、PCで開いているウィンドウは登録なしで一覧に出ます。
                    作業フォルダに生成されたHTMLも自動で候補に加わります。
                  </aside>
                </section>

                <section className="communication-card">
                  <header><span>04</span><h3>Google Drive（外出先で見る場合）</h3></header>
                  <p className="communication-caution">
                    画面プレビューは同じWi-Fiにいる間だけ届きます。外出先でも見返したい画像は、
                    端末の「Driveへ」ボタンで預けられます。成果物がGoogleへ送られるため、
                    必要なときだけお使いください。自動では上げません。
                  </p>
                  <div className="communication-rule">
                    <b>状態</b>
                    <span>
                      {driveStatus.connected
                        ? `接続済み（${driveStatus.account}）`
                        : driveStatus.configured
                          ? '認証情報は保存済み。Googleとの接続が未完了です'
                          : '未設定'}
                    </span>
                    <b>保存先</b><span>マイドライブの「{driveStatus.folderName}」フォルダ</span>
                  </div>
                  {!driveStatus.connected && (
                    <>
                      <label className="communication-field">
                        <span>クライアントID</span>
                        <input
                          type="text"
                          value={driveClientId}
                          placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
                          onChange={(event) => setDriveClientId(event.target.value)}
                        />
                      </label>
                      <label className="communication-field">
                        <span>クライアントシークレット</span>
                        <input
                          type="password"
                          value={driveClientSecret}
                          onChange={(event) => setDriveClientSecret(event.target.value)}
                        />
                      </label>
                      <div className="communication-test-actions">
                        <button
                          type="button"
                          className="communication-button-secondary"
                          disabled={driveBusy}
                          onClick={saveDriveCredentials}
                        >認証情報を保存</button>
                        <button
                          type="button"
                          className="communication-test-button"
                          disabled={driveBusy || !driveStatus.configured}
                          onClick={() => void runDriveAction(
                            () => window.pixelCodex.connectDrive(),
                            'Google Driveと接続しました',
                          )}
                        >Googleと接続</button>
                      </div>
                    </>
                  )}
                  {driveStatus.connected && (
                    <button
                      type="button"
                      className="communication-button-secondary"
                      disabled={driveBusy}
                      onClick={() => void runDriveAction(
                        () => window.pixelCodex.disconnectDrive(),
                        'Google Driveとの接続を解除しました',
                      )}
                    >接続を解除</button>
                  )}
                  <aside>
                    Google Cloudでプロジェクトを作り、OAuthクライアント（種類は「デスクトップアプリ」）を
                    発行してください。求める権限は drive.file だけで、このアプリが作ったファイル以外の
                    Driveの中身は読めません。リンクは共有設定にしないため、端末側で同じGoogleアカウントに
                    サインインしている必要があります。
                  </aside>
                </section>

                <section className="communication-card">
                  <header><span>05</span><h3>通知するタイミング</h3></header>
                  {([
                    ['turnCompleted', '作業が完了したとき'],
                    ['approvalRequested', '承認が必要になったとき'],
                    ['questionRequested', '質問への回答が必要なとき'],
                    ['errorOccurred', 'エラーが発生したとき'],
                  ] as const).map(([key, label]) => (
                    <label className="communication-check" key={key}>
                      <input
                        type="checkbox"
                        checked={communicationPolicy.events[key]}
                        onChange={(event) => updateCommunicationPolicy({
                          events: { [key]: event.target.checked },
                        })}
                      />
                      {label}
                    </label>
                  ))}
                </section>

                <section className="communication-card">
                  <header><span>06</span><h3>送信する内容</h3></header>
                  <label className="communication-field">
                    <span>通知の詳しさ</span>
                    <select
                      value={communicationPolicy.contentLevel}
                      onChange={(event) => updateCommunicationPolicy({
                        contentLevel: event.target.value as typeof communicationPolicy.contentLevel,
                      })}
                    >
                      <option value="status-only">状態だけ</option>
                      <option value="summary">短い要約</option>
                      <option value="final-message">最終報告を含める</option>
                    </select>
                  </label>
                  <label className="communication-check">
                    <input
                      type="checkbox"
                      checked={communicationPolicy.hideSensitiveDetails}
                      onChange={(event) => updateCommunicationPolicy({ hideSensitiveDetails: event.target.checked })}
                    />
                    ファイルパスや機密らしい内容を通知から隠す
                  </label>
                  <div className="communication-device">
                    <span>HOST ID</span>
                    <strong>{remoteHostId || '初期化中'}</strong>
                    <small>待機中の遠隔指示 {remoteQueue.length}件・端末ペアリングは次の実装段階です</small>
                  </div>
                </section>

                <section className="communication-card">
                  <header><span>07</span><h3>赤ペン先生からの受け取り</h3></header>
                  <label className="communication-check">
                    <input
                      type="checkbox"
                      checked={bridgeStatus.phase === 'listening'}
                      onChange={(event) => {
                        void window.pixelCodex
                          .setBridgeEnabled(event.target.checked)
                          .then(setBridgeStatus)
                          .catch(() => undefined);
                      }}
                    />
                    同じPCの赤ペン先生から赤入れを受け取る
                  </label>
                  <div className="communication-device">
                    <span>受け取り口</span>
                    <strong>{bridgeStatus.label}</strong>
                    <small>
                      {bridgeStatus.connected ? '赤ペン先生と接続中・' : ''}
                      確認待ちの赤入れ {bridgeTasks.length}件
                    </small>
                  </div>
                  <aside>
                    受け取り口は同じPCの同じ利用者だけが使えます。待ち合わせ場所と合言葉は
                    利用者のプロファイルにしか書かれておらず、他の利用者からは読めません。
                    受け取っただけでCodexは動きません。画面で確かめて送ったときだけ動きます。
                  </aside>
                </section>
              </div>

              <footer className="communication-footer">
                <span>{communicationNotice || '通信担当が設定変更を待っています'}</span>
                <button type="button" onClick={() => setCommunicationOpen(false)}>閉じる</button>
              </footer>
            </div>
          </section>
        </div>
      )}

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
                    <label>
                      働く部屋
                      <select
                        value={agentDraft.duty}
                        onChange={(event) =>
                          setAgentDraft((draft) => ({
                            ...draft,
                            duty: event.target.value as AgentProfile['duty'],
                          }))
                        }
                      >
                        <option value="planner">企画会議室（企画・要件整理）</option>
                        <option value="coder">開発室（実装）</option>
                        <option value="researcher">資料室（調査）</option>
                        <option value="tester">テストラボ（検証）</option>
                        <option value="reviewer">企画会議室（レビュー）</option>
                        <option value="designer">開発室（デザイン）</option>
                        <option value="writer">資料室（ドキュメント）</option>
                        <option value="general">フロア（その他）</option>
                      </select>
                    </label>
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

      {skillsOpen && (
        <SkillBook
          box={skillBox}
          workspace={workspace}
          recentWorkspaces={recentWorkspaces}
          modelSettings={modelSettings}
          canAskCodex={connection === 'connected' && Boolean(workspace)}
          onClose={() => setSkillsOpen(false)}
          onLog={(message, level) => addLog(message, level)}
        />
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
                <h2 id="payroll-title">発生経費明細・トークン使用量</h2>
              </div>
              <button type="button" aria-label="明細を閉じる" onClick={() => setPayrollOpen(false)}>×</button>
            </header>

            <div className="payroll-hero">
              <span className="payroll-hero-caption">ただいまの発生経費</span>
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

              <section className="payroll-panel payroll-compare">
                <div className="game-section-title"><span>03</span><h3>ほかの契約だったら？（想定価格）</h3></div>
                <table className="payroll-table">
                  <thead>
                    <tr><th>契約のしかた</th><th>種類</th><th>今回の想定金額</th><th>補足</th></tr>
                  </thead>
                  <tbody>
                    {planEstimates.map((estimate) => (
                      <tr
                        key={estimate.planId}
                        className={estimate.planId === costSettings.planId ? 'current-plan' : ''}
                      >
                        <td>{estimate.label}</td>
                        <td>{estimate.kind === 'flat' ? '定量（定額）課金' : 'API・従量課金'}</td>
                        <td>
                          ￥{estimate.yen.toFixed(2)}
                          {estimate.kind === 'flat' && <em>/月</em>}
                        </td>
                        <td className="payroll-compare-note">{estimate.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="payroll-caution">
                  ※ 定量課金（定額プラン）は月額そのものを表示しています。今回の作業ぶんだけで追加請求されるわけではありません。
                  API（従量課金）の欄は、同じ作業量をそのモデルのAPIで実行した場合の目安です。
                </p>
              </section>

              <section className="payroll-panel">
                <div className="game-section-title"><span>04</span><h3>料金の設定</h3></div>
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
                    onClick={resetPayroll}
                  >メーターを0円にもどす</button>
                </div>
              </section>

              <section className="payroll-panel">
                <div className="game-section-title"><span>05</span><h3>HP（AI使用残量）</h3></div>
                <div className="usage-limit-detail">
                  {usageRows.length === 0 ? (
                    <p className="payroll-empty">
                      いまの契約では残量が取得できないか、まだ届いていません。
                      Codexに接続して1度でも作業を依頼すると表示されます。
                    </p>
                  ) : (
                    usageRows.map((row) => (
                      <div className="usage-limit-line" key={row.key}>
                        <strong>{row.label}</strong>
                        <div className="usage-limit-track">
                          <i className={row.tone} style={{ width: `${row.remaining}%` }} />
                        </div>
                        <b className={row.tone}>のこり {Math.round(row.remaining)}%</b>
                        <small>{row.reset || '回復時刻は未提供'}</small>
                      </div>
                    ))
                  )}
                  {rateLimits?.credits?.balance !== undefined && (
                    <p className="usage-limit-credits">
                      追加クレジット残高：{rateLimits.credits.unlimited
                        ? '無制限'
                        : `${rateLimits.credits.balance.toLocaleString('ja-JP')}`}
                    </p>
                  )}
                  <p className="payroll-caution">
                    ※ 上の残量はChatGPTのプランに紐づく使用枠です。API従量課金では表示されません。
                    {rateLimits?.updatedAt
                      ? `（最終取得 ${new Date(rateLimits.updatedAt).toLocaleTimeString('ja-JP')}）`
                      : ''}
                  </p>
                </div>
              </section>
            </div>
          </section>
        </div>
      )}

      {roadmapOpen && (
        <div
          className="roadmap-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRoadmapOpen(false);
          }}
        >
          <section className="roadmap-window" role="dialog" aria-modal="true" aria-labelledby="roadmap-title">
            <header className="game-window-titlebar roadmap-titlebar">
              <div className="title-icon">進</div>
              <div>
                <span>PROJECT ROADMAP</span>
                <h2 id="roadmap-title">進行表</h2>
              </div>
              <button type="button" aria-label="進行表を閉じる" onClick={() => setRoadmapOpen(false)}>×</button>
            </header>
            <div className="roadmap-summary">
              <div>
                <strong>{roadmap.title || '未設定のプロジェクト'}</strong>
                <small>統括責任者 {directorAgent?.name ?? '東葛大五郎'} が作成・更新します</small>
              </div>
              <div className="roadmap-summary-stats">
                <span><b>{roadmapProgress.percent}</b>% 完了</span>
                <span><b>{roadmapProgress.done}</b>/{roadmap.steps.length} 項目</span>
                <span><b>{projectStartedAt ? formatElapsed(Date.now() - projectStartedAt) : '―'}</b> 経過</span>
              </div>
            </div>
            <div className={`roadmap-current-state ${progressWaiting.tone}`}>
              <i />
              <div><small>いま待っていること</small><strong>{progressWaiting.text}</strong></div>
            </div>
            <RoadmapMilestones steps={roadmap.steps} />
            <div className="roadmap-list">
              {roadmap.steps.length === 0 ? (
                <p className="roadmap-empty">
                  まだ進行表はありません。<br />
                  大きな作業を依頼すると、統括責任者がロードマップを作ってここに掲示します。
                </p>
              ) : (
                <ol>
                  {roadmap.steps.map((step, index) => (
                    <li className={`roadmap-step ${step.status}`} key={step.id}>
                      <span className="roadmap-step-number">{String(index + 1).padStart(2, '0')}</span>
                      <div className="roadmap-step-copy">
                        <strong>{step.title}</strong>
                        <small>{step.owner ? `担当: ${step.owner}` : '担当: 統括責任者が割り振ります'}</small>
                      </div>
                      <span className={`roadmap-step-status ${step.status}`}>
                        {roadmapStatusLabels[step.status]}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <footer className="roadmap-footer">
              <span>進行表はオフィスの掲示板にも貼り出されています</span>
              <span>{roadmap.updatedAt ? `最終更新 ${new Date(roadmap.updatedAt).toLocaleTimeString('ja-JP')}` : ''}</span>
            </footer>
          </section>
        </div>
      )}

      {savesOpen && (
        <div
          className="saves-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSavesOpen(false);
          }}
        >
          <section className="saves-window" role="dialog" aria-modal="true" aria-labelledby="saves-title">
            <header className="game-window-titlebar saves-titlebar">
              <div className="title-icon">▣</div>
              <div>
                <span>SAVE &amp; LOAD</span>
                <h2 id="saves-title">セーブ／ロード</h2>
              </div>
              <button type="button" aria-label="セーブ画面を閉じる" onClick={() => setSavesOpen(false)}>×</button>
            </header>

            <div className="saves-status">
              {repoStatus?.isRepo ? (
                <>
                  <span><b>{saves.length}</b> セーブデータ</span>
                  <span><b>{repoStatus.changedFiles}</b> 未セーブの変更</span>
                  <span className="saves-branch">ブランチ {repoStatus.branch}</span>
                </>
              ) : (
                <span className="saves-branch">{repoStatus?.message ?? '状態を確認しています…'}</span>
              )}
              <button type="button" disabled={saveBusy} onClick={() => void refreshSaves()}>更新</button>
            </div>

            {saveError && <p className="saves-error">{saveError}</p>}

            {repoStatus && repoStatus.nestedRepos.length > 0 && (
              <div className="saves-nested">
                <strong>次の {repoStatus.nestedRepos.length} 個は、このセーブに含まれません</strong>
                <p>
                  それぞれが独自にGitで管理されているフォルダです。中身は無事ですが、
                  ここでセーブ／ロードしても影響しません。個別にセーブしたい場合は、
                  上の WORKSPACE でそのフォルダを作業フォルダに選び直してください。
                </p>
                <ul>
                  {repoStatus.nestedRepos.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            )}

            {repoStatus && !repoStatus.gitAvailable ? (
              <div className="saves-setup">
                <p>
                  セーブ機能は Git を使って動きます。<br />
                  <strong>Git for Windows</strong> をインストールすると使えるようになります。
                </p>
              </div>
            ) : repoStatus && !repoStatus.isRepo ? (
              <div className="saves-setup">
                <p>
                  この作業フォルダは、まだセーブに対応していません。<br />
                  下のボタンを押すと準備します（作業フォルダに記録用のデータと、
                  記録しないものを決める <code>.gitignore</code> を作ります）。
                </p>
                <button className="game-primary-button" type="button" disabled={saveBusy} onClick={() => void prepareSaves()}>
                  {saveBusy ? '準備しています…' : 'セーブを始める'}
                </button>
              </div>
            ) : (
              <>
                <div className="saves-composer">
                  <label htmlFor="save-label">このセーブの名前</label>
                  <input
                    id="save-label"
                    value={saveLabel}
                    maxLength={80}
                    placeholder="例: ログイン画面ができたところ"
                    onChange={(event) => setSaveLabel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !saveBusy) void createSave();
                    }}
                  />
                  <button className="game-primary-button" type="button" disabled={saveBusy} onClick={() => void createSave()}>
                    {saveBusy ? '書き込み中…' : '★ ここにセーブ'}
                  </button>
                </div>

                <div className="saves-list">
                  {saves.length === 0 ? (
                    <p className="saves-empty">セーブデータはまだありません。</p>
                  ) : (
                    saves.map((slot) => (
                      <article className={`save-slot ${slot.kind}`} key={slot.commit}>
                        <div className="save-slot-no">
                          <span>{saveKindLabels[slot.kind].tag}</span>
                          <b>{slotNumbers.get(slot.commit) ?? '—'}</b>
                        </div>
                        <div className="save-slot-copy">
                          <strong>{slot.subject}</strong>
                          <time>{new Date(slot.time).toLocaleString('ja-JP')}</time>
                          {slot.meta ? (
                            <dl className="save-slot-meta">
                              {slot.meta.roadmapTitle && (
                                <div><dt>進行</dt><dd>{slot.meta.roadmapTitle}（{slot.meta.roadmapDone ?? 0}/{slot.meta.roadmapTotal ?? 0}）</dd></div>
                              )}
                              <div><dt>成果物</dt><dd>{slot.meta.deliverables ?? 0} 件</dd></div>
                              <div><dt>費用</dt><dd>￥{(slot.meta.yen ?? 0).toFixed(2)}（{formatTokens(slot.meta.tokens ?? 0)} トークン）</dd></div>
                              {slot.meta.model && <div><dt>モデル</dt><dd>{slot.meta.model}</dd></div>}
                            </dl>
                          ) : (
                            <small className="save-slot-plain">{saveKindLabels[slot.kind].note}</small>
                          )}
                        </div>
                        <div className="save-slot-actions">
                          <code>{slot.shortCommit}</code>
                          <button type="button" disabled={saveBusy} onClick={() => setPendingLoad(slot)}>
                            ロード
                          </button>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </>
            )}

            <footer className="saves-footer">
              <span>ロードすると、いまの状態は自動でセーブしてから復元します</span>
              <span title={workspace}>{workspace}</span>
            </footer>
          </section>
        </div>
      )}

      {pendingLoad && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="approval-modal risk-medium"
            role="dialog"
            aria-modal="true"
            aria-labelledby="load-title"
          >
            <div className="approval-icon">▣</div>
            <span className="eyebrow">ロード かくにん</span>
            <h2 id="load-title">このセーブデータを読み込みますか？</h2>
            <p className="approval-headline">{pendingLoad.subject}</p>
            <ul className="approval-bullets">
              <li>作業フォルダの中身が、{new Date(pendingLoad.time).toLocaleString('ja-JP')} の状態に戻ります。</li>
              <li>いまの状態は「ロード前の自動セーブ」として自動的に記録するので、消えません。</li>
              <li>戻したあとで気が変わったら、その自動セーブをロードすれば元どおりです。</li>
            </ul>
            {repoStatus && repoStatus.changedFiles > 0 && (
              <p className="approval-risk medium">
                セーブしていない変更が {repoStatus.changedFiles} 件あります。これらも自動セーブに含めて記録します。
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setPendingLoad(null)}>
                やめる
              </button>
              <button type="button" className="primary-button" onClick={() => void confirmLoad()}>
                ロードする
              </button>
            </div>
          </section>
        </div>
      )}

      {reportOpen && accountingReport && (
        <div
          className="report-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setReportOpen(false);
          }}
        >
          <section className="report-window" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <header className="game-window-titlebar report-titlebar">
              <div className="title-icon">計</div>
              <div>
                <span>ACCOUNTING REPORT</span>
                <h2 id="report-title">会計報告書</h2>
              </div>
              <button type="button" aria-label="会計報告を閉じる" onClick={() => setReportOpen(false)}>×</button>
            </header>
            <div className="report-history-bar">
              <label>
                <span>保存済みの会計報告</span>
                <select
                  value={accountingReport.id}
                  onChange={(event) => openAccountingReport(event.target.value)}
                >
                  {accountingReports.map((report) => (
                    <option key={report.id} value={report.id}>{report.title}</option>
                  ))}
                </select>
              </label>
              <strong>{accountingReports.length}件を自動保存</strong>
              <button type="button" onClick={() => buildAccountingReport('途中経過の保存')}>
                現在の会計を保存
              </button>
              <button
                className="report-reset"
                type="button"
                onClick={resetPayroll}
                title="この報告までの発生経費を締めて、メーターを0円から数え直します"
              >
                締めて0円にもどす
              </button>
            </div>
            <div className="report-head">
              <div>
                <strong>{accountingReport.title}</strong>
                <small>{accountingReport.summary}</small>
              </div>
              <div className="report-total">
                <span>ご請求（目安）</span>
                <b>￥{accountingReport.totalYen.toFixed(2)}</b>
                <small>{accountingReport.planLabel} ／ {accountingReport.modelLabel}</small>
              </div>
            </div>
            <div className="report-body">
              <section className="report-section">
                <div className="game-section-title"><span>01</span><h3>担当者ごとの明細</h3></div>
                <table className="report-table">
                  <thead>
                    <tr><th>担当者</th><th>作業内容</th><th>トークン</th><th>費用</th></tr>
                  </thead>
                  <tbody>
                    {accountingReport.lines.length === 0 && (
                      <tr><td colSpan={4} className="report-empty">まだ費用の記録がありません。</td></tr>
                    )}
                    {accountingReport.lines.map((line) => (
                      <tr key={line.threadId}>
                        <td>
                          <span className="report-chip" style={{ background: hexColor(line.color) }} />
                          <div className="report-name">
                            <strong>{line.name}</strong>
                            <small>{line.role}</small>
                          </div>
                        </td>
                        <td className="report-tasks">
                          {line.tasks.length === 0 ? (
                            <small>記録なし</small>
                          ) : (
                            <ul>
                              {line.tasks.slice(-6).map((entry) => (
                                <li key={entry}>{entry}</li>
                              ))}
                              {line.tasks.length > 6 && <li>ほか {line.tasks.length - 6} 件</li>}
                            </ul>
                          )}
                        </td>
                        <td className="report-number">
                          {totalTokens(line.usage).toLocaleString('ja-JP')}
                          <small>入力 {formatTokens(line.usage.input)} / 出力 {formatTokens(line.usage.output)}</small>
                        </td>
                        <td className="report-number report-yen">￥{line.yen.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>合計</td>
                      <td>{accountingReport.deliverables.length} 件の成果物</td>
                      <td className="report-number">{totalTokens(accountingReport.usage).toLocaleString('ja-JP')}</td>
                      <td className="report-number report-yen">￥{accountingReport.totalYen.toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </section>

              <section className="report-section">
                <div className="game-section-title"><span>02</span><h3>契約別の想定価格</h3></div>
                <table className="report-table compact">
                  <thead>
                    <tr><th>契約のしかた</th><th>種類</th><th>想定金額</th></tr>
                  </thead>
                  <tbody>
                    {accountingReport.estimates.map((estimate) => (
                      <tr
                        key={estimate.planId}
                        className={estimate.planId === accountingReport.planId ? 'current-plan' : ''}
                      >
                        <td>
                          {estimate.label}
                          <small>{estimate.note}</small>
                        </td>
                        <td>{estimate.kind === 'flat' ? '定量（定額）課金' : 'API・従量課金'}</td>
                        <td className="report-number report-yen">
                          ￥{estimate.yen.toFixed(2)}{estimate.kind === 'flat' ? ' /月' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>

              <section className="report-section">
                <div className="game-section-title"><span>03</span><h3>今回やったこと</h3></div>
                <div className="report-worklist">
                  <div>
                    <h4>進行表</h4>
                    {accountingReport.steps.length === 0 ? (
                      <p className="report-empty">進行表は作成されていません。</p>
                    ) : (
                      <ul>
                        {accountingReport.steps.map((step) => (
                          <li key={step.id}>
                            <span className={`report-step-mark ${step.status}`}>
                              {step.status === 'done' ? '✓' : step.status === 'active' ? '…' : '−'}
                            </span>
                            {step.title}
                            {step.owner && <em>（{step.owner}）</em>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h4>成果物</h4>
                    {accountingReport.deliverables.length === 0 ? (
                      <p className="report-empty">ファイルの変更はありません。</p>
                    ) : (
                      <ul>
                        {accountingReport.deliverables.slice(-20).map((deliverable) => (
                          <li key={deliverable.id} title={deliverable.path}>
                            <span className={`report-step-mark ${deliverable.kind}`}>◆</span>
                            {fileName(deliverable.path)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>
            </div>
            <footer className="report-footer">
              <span>
                作成 {new Date(accountingReport.createdAt).toLocaleString('ja-JP')} ／ 経理担当 金田計理
              </span>
              <button
                type="button"
                onClick={() => {
                  setReportOpen(false);
                  addLog('会計報告を確認しました', 'info');
                }}
              >閉じる</button>
            </footer>
          </section>
        </div>
      )}

      {conflict && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="approval-modal risk-medium"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conflict-title"
          >
            <div className="approval-icon">!</div>
            <span className="eyebrow">せつぞく かくにん</span>
            <h2 id="conflict-title">ほかでCodexが動いています</h2>
            <p className="approval-headline">
              Codexは同時にひとつしか使えません。{conflict.processes.length} 件の
              Codexが別の場所（ターミナルや他のアプリ）で動いています。
            </p>
            <ul className="approval-bullets">
              {conflict.processes.map((entry) => (
                <li key={entry.pid}>
                  {entry.name}（プロセス番号 {entry.pid}{entry.memory ? ` ・ メモリ ${entry.memory}` : ''}）
                </li>
              ))}
            </ul>
            <p className="approval-guide">
              「他を切断して接続」を押すと、上の Codex を終了してからこのアプリで接続します。
              ほかの場所で作業中の内容がある場合は、先に保存してください。
            </p>
            <div className="modal-actions modal-actions-three">
              <button type="button" className="secondary-button" onClick={() => setConflict(null)}>
                やめる
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const target = conflict;
                  setConflict(null);
                  void connect(target.executable, target.workspace, true);
                }}
              >そのまま接続を試す</button>
              <button type="button" className="primary-button" onClick={() => void disconnectOthersAndConnect()}>
                他を切断して接続
              </button>
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
