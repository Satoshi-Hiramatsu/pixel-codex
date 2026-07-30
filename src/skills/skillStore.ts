import fs from 'node:fs/promises';
import path from 'node:path';

import type { Skill, SkillBook, SkillDraft, SkillScope, SkillShelf } from '../types';
import { normalizeDraft, parseSkill, serializeSkill, skillSlug } from './skillFile';

/** プロジェクト側の置き場所。作業フォルダの直下に作ります。 */
const projectFolder = '.pixel-codex';
const skillFolder = 'skills';
/** 1つの置き場所から読むスキルの上限。壊れたフォルダを指しても固まらないようにします。 */
const skillLimitPerScope = 200;
/** 他プロジェクトを探しに行く数の上限。 */
const shelfLimit = 12;

let userDataRoot = '';

/** アプリ起動時に一度だけ、ユーザーデータの場所を教えてもらいます。 */
export function setUserDataRoot(root: string): void {
  userDataRoot = root;
}

function globalDir(): string {
  if (!userDataRoot) throw new Error('スキルの保存先が初期化されていません。');
  return path.join(userDataRoot, skillFolder);
}

function globalEquippedFile(): string {
  if (!userDataRoot) throw new Error('スキルの保存先が初期化されていません。');
  return path.join(userDataRoot, 'skills.json');
}

function requireWorkspace(workspace: string): string {
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error('プロジェクトのスキルを使うには、作業フォルダを選んでください。');
  }
  return workspace;
}

function projectDir(workspace: string): string {
  return path.join(requireWorkspace(workspace), projectFolder, skillFolder);
}

function projectEquippedFile(workspace: string): string {
  return path.join(requireWorkspace(workspace), projectFolder, 'skills.json');
}

function scopeDir(scope: SkillScope, workspace: string): string {
  return scope === 'global' ? globalDir() : projectDir(workspace);
}

function equippedFile(scope: SkillScope, workspace: string): string {
  return scope === 'global' ? globalEquippedFile() : projectEquippedFile(workspace);
}

/**
 * 一覧に出す id はファイル名そのものなので、`..` やパス区切りが混ざっていると
 * 置き場所の外を指せてしまいます。読み書きの前に必ずここを通します。
 */
function skillPath(scope: SkillScope, workspace: string, id: string): string {
  const directory = scopeDir(scope, workspace);
  const fileName = `${id}.md`;
  const target = path.resolve(directory, fileName);
  if (path.dirname(target) !== path.resolve(directory)) {
    throw new Error('スキルの指定が正しくありません。');
  }
  return target;
}

async function readSkillFile(
  directory: string,
  fileName: string,
  scope: SkillScope,
): Promise<Skill | undefined> {
  const absolute = path.join(directory, fileName);
  try {
    const [text, stats] = await Promise.all([
      fs.readFile(absolute, 'utf8'),
      fs.stat(absolute).catch(() => undefined),
    ]);
    return parseSkill(text, {
      id: fileName.slice(0, -3),
      scope,
      path: absolute,
      fallbackTime: stats?.mtimeMs ?? Date.now(),
    });
  } catch {
    // 読めないファイルは無かったことにします。一覧が丸ごと出なくなるより親切です。
    return undefined;
  }
}

async function readSkillsFrom(directory: string, scope: SkillScope): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .slice(0, skillLimitPerScope);
  } catch {
    return [];
  }
  const skills = await Promise.all(
    entries.map((fileName) => readSkillFile(directory, fileName, scope)),
  );
  return skills
    .filter((skill): skill is Skill => Boolean(skill))
    .sort((left, right) => left.name.localeCompare(right.name, 'ja', { numeric: true }));
}

export function listSkills(scope: SkillScope, workspace: string): Promise<Skill[]> {
  if (scope === 'project' && !workspace) return Promise.resolve([]);
  return readSkillsFrom(scopeDir(scope, workspace), scope);
}

async function readEquippedIds(scope: SkillScope, workspace: string): Promise<string[]> {
  try {
    const text = await fs.readFile(equippedFile(scope, workspace), 'utf8');
    const parsed = JSON.parse(text) as { equipped?: unknown };
    if (!Array.isArray(parsed.equipped)) return [];
    return parsed.equipped
      .filter((value): value is string => typeof value === 'string')
      .slice(0, skillLimitPerScope);
  } catch {
    return [];
  }
}

async function writeEquippedIds(
  scope: SkillScope,
  workspace: string,
  ids: string[],
): Promise<void> {
  const target = equippedFile(scope, workspace);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ equipped: ids }, null, 2)}\n`, 'utf8');
}

/** 装備の一覧から、もう無くなったスキルを落とします。 */
function keepExisting(ids: string[], skills: Skill[]): string[] {
  const known = new Set(skills.map((skill) => skill.id));
  return ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index);
}

export async function readSkillBook(workspace: string): Promise<SkillBook> {
  const [global, project] = await Promise.all([
    listSkills('global', ''),
    workspace ? listSkills('project', workspace) : Promise.resolve([]),
  ]);
  const [equippedGlobal, equippedProject] = await Promise.all([
    readEquippedIds('global', ''),
    workspace ? readEquippedIds('project', workspace) : Promise.resolve([]),
  ]);
  return {
    workspace,
    global,
    project,
    equippedGlobal: keepExisting(equippedGlobal, global),
    equippedProject: keepExisting(equippedProject, project),
  };
}

export async function setEquippedSkills(
  scope: SkillScope,
  workspace: string,
  ids: unknown,
): Promise<string[]> {
  const requested = (Array.isArray(ids) ? ids : [])
    .filter((value): value is string => typeof value === 'string')
    .slice(0, skillLimitPerScope);
  const kept = keepExisting(requested, await listSkills(scope, workspace));
  await writeEquippedIds(scope, workspace, kept);
  return kept;
}

/** 同じ名前のファイルがあったら `-2`, `-3` と番号を足していきます。 */
async function uniqueId(directory: string, base: string): Promise<string> {
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    try {
      await fs.access(path.join(directory, `${candidate}.md`));
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * 新規作成と上書きの両方。`id` があるときはファイル名を変えずに中身だけ更新するので、
 * 名前を変えても装備が外れません。
 */
export async function saveSkill(
  scope: SkillScope,
  workspace: string,
  rawDraft: unknown,
): Promise<Skill> {
  const draft: SkillDraft = normalizeDraft(rawDraft);
  const directory = scopeDir(scope, workspace);
  await fs.mkdir(directory, { recursive: true });

  const existing = draft.id
    ? await readSkillFile(directory, `${draft.id}.md`, scope)
    : undefined;
  const id = existing?.id ?? (await uniqueId(directory, skillSlug(draft.name)));
  const now = Date.now();
  const skill: Skill = {
    id,
    name: draft.name,
    category: draft.category,
    effect: draft.effect,
    detail: draft.detail,
    scope,
    origin: draft.origin ?? existing?.origin,
    copiedFrom: draft.copiedFrom ?? existing?.copiedFrom,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    path: skillPath(scope, workspace, id),
  };
  await fs.writeFile(skill.path, serializeSkill(skill), 'utf8');
  return skill;
}

export async function deleteSkill(
  scope: SkillScope,
  workspace: string,
  id: string,
): Promise<void> {
  await fs.rm(skillPath(scope, workspace, String(id ?? '')), { force: true });
  const remaining = await listSkills(scope, workspace);
  await writeEquippedIds(
    scope,
    workspace,
    keepExisting(await readEquippedIds(scope, workspace), remaining),
  );
}

/**
 * 過去に使った作業フォルダを覗いて、スキルを持っているものだけ返します。
 * 消えたフォルダや権限のないフォルダは黙って飛ばします。
 */
export async function listSkillShelves(workspaces: unknown): Promise<SkillShelf[]> {
  const targets = (Array.isArray(workspaces) ? workspaces : [])
    .filter((value): value is string => typeof value === 'string' && path.isAbsolute(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, shelfLimit);

  const shelves = await Promise.all(
    targets.map(async (workspace) => {
      const skills = await readSkillsFrom(
        path.join(workspace, projectFolder, skillFolder),
        'project',
      );
      return { workspace, name: path.basename(workspace) || workspace, skills };
    }),
  );
  return shelves.filter((shelf) => shelf.skills.length > 0);
}
