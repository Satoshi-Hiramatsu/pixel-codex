import type { Skill, SkillCategory, SkillDraft, SkillScope } from '../types';

/**
 * スキルの系統。一覧の並び順はこの配列の順番になります。
 * `mark` は一覧のアイコン代わりの1文字で、`color` はカードの縁の色です。
 */
export const skillCategories: Array<{
  id: SkillCategory;
  label: string;
  mark: string;
  color: string;
  hint: string;
}> = [
  { id: 'coding', label: 'コーディング系', mark: '⚔', color: '#65b7d8', hint: '実装のしかたを揃える' },
  { id: 'planning', label: '企画系', mark: '✦', color: '#f0bd55', hint: '要件整理や設計の進め方' },
  { id: 'guard', label: '範囲抑制系', mark: '⛨', color: '#78b56c', hint: '触ってよい範囲を絞る' },
  { id: 'research', label: '調査系', mark: '◎', color: '#b58bd4', hint: '調べ方と裏取りの基準' },
  { id: 'review', label: 'レビュー系', mark: '☰', color: '#e09cb2', hint: '出す前の確認事項' },
  { id: 'writing', label: '文章系', mark: '✎', color: '#d8a26a', hint: '文書やコメントの書き方' },
  { id: 'workflow', label: '進行系', mark: '⚑', color: '#7fc7bd', hint: '報告や区切りの入れ方' },
  { id: 'other', label: 'その他', mark: '◈', color: '#94a0a0', hint: '上のどれにも当てはまらない' },
];

const categoryIds = new Set<string>(skillCategories.map((entry) => entry.id));

export function categoryInfo(category: SkillCategory): (typeof skillCategories)[number] {
  return skillCategories.find((entry) => entry.id === category) ?? skillCategories[skillCategories.length - 1];
}

export function normalizeCategory(value: unknown): SkillCategory {
  const text = String(value ?? '').trim().toLowerCase();
  return categoryIds.has(text) ? (text as SkillCategory) : 'other';
}

/** メタ欄は1行1項目なので、改行と区切り記号は空白に潰します。 */
function singleLine(value: string, limit: number): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export const skillLimits = {
  name: 40,
  effect: 120,
  detail: 8000,
} as const;

/**
 * スキル名からファイル名を作ります。日本語はそのまま残し、
 * Windowsのファイル名として使えない文字だけを落とします。
 */
export function skillSlug(name: string): string {
  // Windowsのファイル名に使えない文字と制御文字だけを空白へ置き換えます。
  const forbidden = '<>:"/\\|?*';
  const cleaned = [...name]
    .map((char) => (forbidden.includes(char) || char < ' ' ? ' ' : char))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return cleaned || `skill-${Date.now().toString(36)}`;
}

function metaNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * ファイルの中身をスキルに変換します。冒頭の `---` で囲まれた部分がメタ欄で、
 * その後ろが詳細です。メタ欄が無い手書きのファイルも、本文だけのスキルとして読めます。
 */
export function parseSkill(
  text: string,
  context: { id: string; scope: SkillScope; path: string; fallbackTime: number },
): Skill {
  // 先頭のBOMは、外で作られたファイルを読んだときに混ざります。
  const normalized = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    .replace(/\r\n/g, '\n');
  const meta = new Map<string, string>();
  let body = normalized;

  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (match) {
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':');
      if (separator <= 0) continue;
      meta.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    body = normalized.slice(match[0].length);
  }

  const createdAt = metaNumber(meta.get('createdat'), context.fallbackTime);
  return {
    id: context.id,
    name: singleLine(meta.get('name') ?? context.id, skillLimits.name) || context.id,
    category: normalizeCategory(meta.get('category')),
    effect: singleLine(meta.get('effect') ?? '', skillLimits.effect),
    detail: body.trim().slice(0, skillLimits.detail),
    scope: context.scope,
    origin: meta.get('origin') || undefined,
    copiedFrom: meta.get('copiedfrom') || undefined,
    createdAt,
    updatedAt: metaNumber(meta.get('updatedat'), createdAt),
    path: context.path,
  };
}

/** 保存する文字列。人が直接開いても読めるように、メタ欄は素直な `キー: 値` にします。 */
export function serializeSkill(skill: Skill): string {
  const meta: Array<[string, string]> = [
    ['name', singleLine(skill.name, skillLimits.name)],
    ['category', skill.category],
    ['effect', singleLine(skill.effect, skillLimits.effect)],
  ];
  if (skill.origin) meta.push(['origin', singleLine(skill.origin, 200)]);
  if (skill.copiedFrom) meta.push(['copiedFrom', singleLine(skill.copiedFrom, 200)]);
  meta.push(['createdAt', String(skill.createdAt)], ['updatedAt', String(skill.updatedAt)]);

  const front = meta.map(([key, value]) => `${key}: ${value}`).join('\n');
  return `---\n${front}\n---\n\n${skill.detail.trim()}\n`;
}

/** 画面から届いた下書きを、保存できる形に整えます。 */
export function normalizeDraft(value: unknown): SkillDraft {
  const source = (value ?? {}) as Record<string, unknown>;
  const name = singleLine(String(source.name ?? ''), skillLimits.name);
  if (!name) throw new Error('スキル名を入力してください。');
  const detail = String(source.detail ?? '').replace(/\r\n/g, '\n').trim().slice(0, skillLimits.detail);
  if (!detail) throw new Error('スキルの詳細を入力してください。');
  return {
    id: source.id ? String(source.id) : undefined,
    name,
    category: normalizeCategory(source.category),
    effect: singleLine(String(source.effect ?? ''), skillLimits.effect),
    detail,
    origin: source.origin ? singleLine(String(source.origin), 200) : undefined,
    copiedFrom: source.copiedFrom ? singleLine(String(source.copiedFrom), 200) : undefined,
  };
}

/**
 * 装備中のスキルをCodexへの指示文にします。
 * 効果だけでは足りないので、詳細もそのまま添えます。
 */
export function skillBriefing(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = [
    '',
    '[装備中のスキル]',
    'これらは今回の作業に適用されるルールです。担当者へ依頼するときも、関係する項目をそのまま伝えてください。',
  ];
  for (const skill of skills) {
    const info = categoryInfo(skill.category);
    lines.push('', `■ ${skill.name}（${info.label}）`);
    if (skill.effect) lines.push(`効果: ${skill.effect}`);
    lines.push(skill.detail.trim());
  }
  return lines.join('\n');
}
