import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LoadResult, RepoStatus, SaveMeta, SaveSlot } from '../types';

const execFileAsync = promisify(execFile);

/**
 * ゲームのセーブ／ロードを、作業フォルダのGitコミットとして実現します。
 *
 * 設計の要は「なにも失われないこと」です。
 * - セーブ  … いまの状態をコミットする（変更が無くても記録できます）
 * - ロード  … 先に自動セーブしてから、選んだセーブの中身を復元して**新しい
 *              コミットを積む**。履歴を巻き戻さないので、ロードしたあとで
 *              「やっぱり戻したい」と思えば、直前のセーブをロードするだけで
 *              元に戻せます。
 */
const SAVE_MARKER = '[PixelCodex]';
const AUTO_SAVE_LABEL = 'ロード前の自動セーブ';
const LOAD_LABEL_PREFIX = 'ロード: ';
const SAVE_DIR = '.pixel-codex';
const SAVE_FILE = 'save.json';
const RECORD = '';
const FIELD = '';

/** Commits are made under the app's own name so a missing global git identity never blocks a save. */
const IDENTITY = [
  '-c', 'user.name=Pixel Codex',
  '-c', 'user.email=pixel-codex@local',
  '-c', 'commit.gpgsign=false',
];

const DEFAULT_GITIGNORE = [
  '# Pixel Codex がセーブを始めるときに作りました。',
  '# 大きすぎて記録に向かないものを、あらかじめ除いています。',
  'node_modules/',
  'bower_components/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  'dist/',
  'build/',
  'out/',
  '.webpack/',
  '.next/',
  '.nuxt/',
  'target/',
  'coverage/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '',
].join('\n');

const BASE_ARGS = [
  '-c', 'core.quotepath=false',
  // セーブは「そのとき保存したものをそのまま戻す」のが目的なので、
  // 改行コードの自動変換はしません（大量の警告も出なくなります）。
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
];

/** gitの出力は警告だらけになりがちなので、本当のエラー行だけを取り出します。 */
function gitErrorMessage(error: unknown): string {
  const detail = error as { stderr?: string; message?: string };
  const raw = `${detail?.stderr ?? ''}\n${detail?.message ?? String(error)}`;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const serious = lines.filter((line) => /^(error|fatal):/i.test(line));
  const picked = serious.length ? serious : lines.filter((line) => !/^(warning|hint):/i.test(line));
  return picked.slice(0, 4).join(' / ').slice(0, 500) || 'gitの実行に失敗しました。';
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    throw new Error(gitErrorMessage(error));
  }
}

const NESTED_BEGIN = '# >>> Pixel Codex: 入れ子のGitリポジトリ >>>';
const NESTED_END = '# <<< Pixel Codex: 入れ子のGitリポジトリ <<<';
const SCAN_SKIP = new Set([
  '.git', 'node_modules', 'bower_components', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', '.next', '.nuxt', 'target', 'coverage', '.webpack', '.vite',
]);

/**
 * 作業フォルダの中にある、それ自体がGitで管理されているフォルダを探します。
 *
 * こういうフォルダを親から `git add -A` しようとすると、Gitは中身を取り込めず、
 * コミットが1つも無い場合は `does not have a commit checked out` で丸ごと失敗します。
 * 親のセーブからは外す必要があるので、先に見つけておきます。
 */
async function findNestedRepos(workspace: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const isRepo = await fs
        .access(path.join(full, '.git'))
        .then(() => true)
        .catch(() => false);
      if (isRepo) {
        found.push(`${path.relative(workspace, full).split(path.sep).join('/')}/`);
        continue; // 入れ子のさらに中までは見ません。
      }
      await walk(full, depth + 1);
    }
  };
  await walk(workspace, 1);
  return found.sort();
}

/**
 * 見つけた入れ子リポジトリを `.git/info/exclude` に書きます。
 * ここはリポジトリ内部の設定ファイルなので、利用者のフォルダに余計なファイルを
 * 増やさずに済みます。印で囲った範囲だけを毎回書き換えます。
 */
async function syncNestedExcludes(workspace: string): Promise<string[]> {
  const nested = await findNestedRepos(workspace);
  const excludePath = path.join(workspace, '.git', 'info', 'exclude');
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const current = await fs.readFile(excludePath, 'utf8').catch(() => '');
  const withoutBlock = current
    .replace(new RegExp(`${NESTED_BEGIN}[\\s\\S]*?${NESTED_END}\\r?\\n?`, 'g'), '')
    .trimEnd();
  const block = nested.length
    ? [
        NESTED_BEGIN,
        '# これらは独自にGit管理されているため、このフォルダのセーブには含めません。',
        ...nested,
        NESTED_END,
      ].join('\n')
    : '';
  const next = [withoutBlock, block].filter(Boolean).join('\n\n');
  await fs.writeFile(excludePath, next ? `${next}\n` : '', 'utf8');
  return nested;
}

function assertWorkspace(workspace: string): void {
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error('作業フォルダが正しく選ばれていません。');
  }
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { windowsHide: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function getRepoStatus(workspace: string): Promise<RepoStatus> {
  assertWorkspace(workspace);
  const empty: RepoStatus = {
    gitAvailable: false,
    isRepo: false,
    hasCommits: false,
    branch: '',
    changedFiles: 0,
    changes: [],
    nestedRepos: [],
  };
  if (!(await gitAvailable())) {
    return { ...empty, message: 'Gitが見つかりません。Git for Windowsを入れると、セーブ機能が使えます。' };
  }

  let isRepo = false;
  try {
    // 親フォルダのリポジトリを間違って掴まないよう、この場所自身かどうかを見ます。
    const top = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();
    isRepo = path.resolve(top) === path.resolve(workspace);
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    return {
      ...empty,
      gitAvailable: true,
      nestedRepos: await findNestedRepos(workspace),
      message: 'この作業フォルダはまだセーブに対応していません。「セーブを始める」を押すと準備します。',
    };
  }

  let hasCommits = true;
  try {
    await git(workspace, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasCommits = false;
  }

  // 入れ子リポジトリは毎回さがして除外し直します（作業中に増えることがあるため）。
  const nestedRepos = await syncNestedExcludes(workspace).catch(() => findNestedRepos(workspace));

  const branch = (await git(workspace, ['branch', '--show-current']).catch(() => '')).trim();
  const porcelain = await git(workspace, ['status', '--porcelain']).catch(() => '');
  const changes = porcelain
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return {
    gitAvailable: true,
    isRepo: true,
    hasCommits,
    branch: branch || '(なし)',
    changedFiles: changes.length,
    changes: changes.slice(0, 40),
    nestedRepos,
  };
}

export async function initRepo(workspace: string): Promise<RepoStatus> {
  assertWorkspace(workspace);
  if (!(await gitAvailable())) {
    throw new Error('Gitが見つかりません。Git for Windowsを入れてから、もう一度お試しください。');
  }
  const status = await getRepoStatus(workspace);
  if (!status.isRepo) {
    await git(workspace, ['init']);
  }
  // .gitignore が無いまま全部記録すると node_modules まで抱え込んでしまうので、
  // 最初の一回だけ用意します。既にあるものには手を触れません。
  const ignorePath = path.join(workspace, '.gitignore');
  const hasIgnore = await fs
    .access(ignorePath)
    .then(() => true)
    .catch(() => false);
  if (!hasIgnore) await fs.writeFile(ignorePath, DEFAULT_GITIGNORE, 'utf8');
  // 入れ子リポジトリを外してからでないと、最初のセーブが失敗します。
  await syncNestedExcludes(workspace);

  const after = await getRepoStatus(workspace);
  if (!after.hasCommits) {
    await git(workspace, ['add', '-A']);
    await git(workspace, [
      ...IDENTITY,
      'commit',
      '--allow-empty',
      '-m',
      `${SAVE_MARKER} さいしょのセーブ`,
    ]);
  }
  return getRepoStatus(workspace);
}

function parseMeta(raw: string): SaveMeta | undefined {
  try {
    const parsed = JSON.parse(raw) as SaveMeta;
    if (parsed && typeof parsed.label === 'string') return parsed;
  } catch {
    // メタ情報が読めなくても、コミット自体はロードできます。
  }
  return undefined;
}

export async function listSaves(workspace: string): Promise<SaveSlot[]> {
  assertWorkspace(workspace);
  const status = await getRepoStatus(workspace);
  if (!status.isRepo || !status.hasCommits) return [];

  const log = await git(workspace, [
    'log',
    '-n', '40',
    `--format=%H${FIELD}%at${FIELD}%s${FIELD}%an${RECORD}`,
  ]);

  const slots = log
    .split(RECORD)
    .map((entry) => entry.replace(/^[\r\n]+/, ''))
    .filter((entry) => entry.trim())
    .map((entry): SaveSlot => {
      const [commit, at, subject, author] = entry.split(FIELD);
      const isAppSave = (subject ?? '').startsWith(SAVE_MARKER);
      const title = (subject ?? '').replace(`${SAVE_MARKER} `, '').trim();
      const kind: SaveSlot['kind'] = !isAppSave
        ? 'other'
        : title === AUTO_SAVE_LABEL
          ? 'auto'
          : title.startsWith(`${LOAD_LABEL_PREFIX}`)
            ? 'load'
            : 'save';
      return {
        commit,
        shortCommit: commit.slice(0, 7),
        time: Number(at) * 1000,
        subject: title || '(説明なし)',
        author: author ?? '',
        kind,
        isAppSave,
      };
    });

  // メタ情報はコミットの中の save.json から読みます（無い場合はそのまま）。
  await Promise.all(
    slots.map(async (slot) => {
      if (!slot.isAppSave) return;
      const raw = await git(workspace, [
        'show',
        `${slot.commit}:${SAVE_DIR}/${SAVE_FILE}`,
      ]).catch(() => '');
      if (raw) slot.meta = parseMeta(raw);
    }),
  );

  return slots;
}

async function writeSaveFile(workspace: string, meta: SaveMeta): Promise<void> {
  const dir = path.join(workspace, SAVE_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, SAVE_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function createSave(
  workspace: string,
  label: string,
  meta: SaveMeta,
): Promise<SaveSlot[]> {
  assertWorkspace(workspace);
  const status = await getRepoStatus(workspace);
  if (!status.isRepo) {
    throw new Error('まだセーブの準備ができていません。「セーブを始める」を押してください。');
  }
  const title = label.trim().slice(0, 80) || '無題のセーブ';
  await writeSaveFile(workspace, { ...meta, label: title, createdAt: Date.now() });
  await syncNestedExcludes(workspace);
  await git(workspace, ['add', '-A']);
  // 変更が無くてもセーブできたほうが、ゲームらしくて分かりやすいので --allow-empty。
  await git(workspace, [...IDENTITY, 'commit', '--allow-empty', '-m', `${SAVE_MARKER} ${title}`]);
  return listSaves(workspace);
}

export async function loadSave(workspace: string, commit: string): Promise<LoadResult> {
  assertWorkspace(workspace);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('セーブデータの指定が正しくありません。');
  const status = await getRepoStatus(workspace);
  if (!status.isRepo || !status.hasCommits) {
    throw new Error('読み込めるセーブデータがありません。');
  }
  // 指定されたコミットが本当にこのリポジトリのものか確かめます。
  const resolved = (await git(workspace, ['rev-parse', '--verify', `${commit}^{commit}`])).trim();

  // ロードで今の状態が消えないよう、必ず先に自動セーブしておきます。
  await syncNestedExcludes(workspace);
  await git(workspace, ['add', '-A']);
  await git(workspace, [
    ...IDENTITY,
    'commit',
    '--allow-empty',
    '-m',
    `${SAVE_MARKER} ${AUTO_SAVE_LABEL}`,
  ]);
  const autoSavedCommit = (await git(workspace, ['rev-parse', 'HEAD'])).trim();

  // 選んだセーブの中身を、作業フォルダと索引に展開します。
  await git(workspace, ['read-tree', '-u', '--reset', resolved]);
  const subject = (await git(workspace, ['log', '-1', '--format=%s', resolved])).trim();
  await git(workspace, [
    ...IDENTITY,
    'commit',
    '--allow-empty',
    '-m',
    `${SAVE_MARKER} ${LOAD_LABEL_PREFIX}${subject.replace(`${SAVE_MARKER} `, '')}`,
  ]);

  const raw = await git(workspace, ['show', `${resolved}:${SAVE_DIR}/${SAVE_FILE}`]).catch(() => '');
  return {
    status: await getRepoStatus(workspace),
    meta: raw ? parseMeta(raw) : undefined,
    autoSavedCommit,
  };
}
