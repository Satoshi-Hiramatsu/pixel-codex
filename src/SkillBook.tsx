import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  categoryInfo,
  normalizeCategory,
  skillCategories,
  skillLimits,
} from './skills/skillFile';
import { resolveModelId, type ModelSettings } from './models';
import type { Skill, SkillBook as SkillBookData, SkillDraft, SkillScope, SkillShelf } from './types';

const emptyBook: SkillBookData = {
  workspace: '',
  global: [],
  project: [],
  equippedGlobal: [],
  equippedProject: [],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillBox {
  book: SkillBookData;
  shelves: SkillShelf[];
  /** グローバル装備 → プロジェクト装備の順に並べた、いま効いているスキル。 */
  equipped: Skill[];
  loading: boolean;
  refresh: () => Promise<void>;
  findShelves: (workspaces: string[]) => Promise<void>;
  toggleEquip: (skill: Skill) => Promise<void>;
  save: (scope: SkillScope, draft: SkillDraft) => Promise<Skill>;
  remove: (scope: SkillScope, id: string) => Promise<void>;
}

/**
 * スキルの読み込みと装備を受け持ちます。装備中の一覧は指示文の組み立てにも
 * 使うので、画面（SkillBook）ではなく呼び出し元のAppで持ちます。
 */
export function useSkillBook(workspace: string): SkillBox {
  const [book, setBook] = useState<SkillBookData>(emptyBook);
  const [shelves, setShelves] = useState<SkillShelf[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBook(await window.pixelCodex.readSkillBook(workspace));
    } catch {
      // 読めないときは何も装備していない扱いにします。作業自体は続けられます。
      setBook({ ...emptyBook, workspace });
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void refresh();
    // 作業フォルダが変わればプロジェクト側の棚も別物になります。
    setShelves([]);
  }, [refresh]);

  const findShelves = useCallback(async (workspaces: string[]) => {
    setShelves(
      (await window.pixelCodex.listSkillShelves(workspaces)).filter(
        (shelf) => shelf.workspace !== workspace,
      ),
    );
  }, [workspace]);

  const toggleEquip = useCallback(async (skill: Skill) => {
    const current = skill.scope === 'global' ? book.equippedGlobal : book.equippedProject;
    const next = current.includes(skill.id)
      ? current.filter((id) => id !== skill.id)
      : [...current, skill.id];
    const kept = await window.pixelCodex.setEquippedSkills(skill.scope, workspace, next);
    setBook((state) =>
      skill.scope === 'global'
        ? { ...state, equippedGlobal: kept }
        : { ...state, equippedProject: kept },
    );
  }, [book.equippedGlobal, book.equippedProject, workspace]);

  const save = useCallback(async (scope: SkillScope, draft: SkillDraft) => {
    const saved = await window.pixelCodex.saveSkill(scope, workspace, draft);
    await refresh();
    return saved;
  }, [refresh, workspace]);

  const remove = useCallback(async (scope: SkillScope, id: string) => {
    await window.pixelCodex.deleteSkill(scope, workspace, id);
    await refresh();
  }, [refresh, workspace]);

  const equipped = useMemo(() => {
    const byId = (skills: Skill[], ids: string[]): Skill[] =>
      ids.flatMap((id) => skills.filter((skill) => skill.id === id));
    return [
      ...byId(book.global, book.equippedGlobal),
      ...byId(book.project, book.equippedProject),
    ];
  }, [book]);

  return { book, shelves, equipped, loading, refresh, findShelves, toggleEquip, save, remove };
}

type DraftState = {
  id?: string;
  scope: SkillScope;
  name: string;
  category: Skill['category'];
  effect: string;
  detail: string;
  origin?: string;
  copiedFrom?: string;
};

function blankDraft(scope: SkillScope): DraftState {
  return { scope, name: '', category: 'coding', effect: '', detail: '' };
}

function draftFrom(skill: Skill, scope: SkillScope, copy: boolean): DraftState {
  return {
    id: copy ? undefined : skill.id,
    scope,
    name: copy ? `${skill.name}（写し）`.slice(0, skillLimits.name) : skill.name,
    category: skill.category,
    effect: skill.effect,
    detail: skill.detail,
    origin: skill.origin,
    copiedFrom: copy ? `${skill.origin ?? '別プロジェクト'} / ${skill.name}` : skill.copiedFrom,
  };
}

/**
 * Codexが書いてきた下書きを読み取ります。`name:` などの行を拾い、
 * `detail:` より後ろを本文にします。コードブロックで包まれていても外します。
 */
export function parseSkillReply(text: string): Partial<DraftState> {
  const body = text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  const lines = body.split('\n');
  const draft: Partial<DraftState> = {};
  let detailFrom = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^\s*(name|category|effect|detail)\s*[:：]\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'name') draft.name = value.slice(0, skillLimits.name);
    else if (key === 'category') draft.category = normalizeCategory(value);
    else if (key === 'effect') draft.effect = value.slice(0, skillLimits.effect);
    else if (key === 'detail') {
      // `detail:` と同じ行に書いてくることもあるので、その分も拾います。
      detailFrom = index;
      draft.detail = value ? `${value}\n` : '';
      break;
    }
  }

  if (detailFrom >= 0) {
    draft.detail = `${draft.detail ?? ''}${lines.slice(detailFrom + 1).join('\n')}`
      .trim()
      .slice(0, skillLimits.detail);
  } else if (!draft.name && !draft.effect) {
    // 形式を無視して普通の文章で返ってきた場合は、丸ごと詳細として扱います。
    draft.detail = body.slice(0, skillLimits.detail);
  }
  return draft;
}

const categoryList = skillCategories.map((entry) => entry.id).join('|');

function createPrompt(idea: string, workspace: string): string {
  return [
    'あなたはAIコーディングエージェントに渡す「スキル」（作業ルール）を設計する担当です。',
    '次の要望から、そのまま指示文として使えるスキルを1つ作ってください。',
    '',
    `要望: ${idea}`,
    `対象プロジェクト: ${workspace}`,
    '',
    '必要ならプロジェクト内のファイルを読んで、実際の構成に合った内容にしてください。',
    'ファイルの変更、コマンドの実行、外部への通信はしないでください。',
    '',
    '返答は次の形式のテキストだけにしてください。前置きも後書きも不要です。',
    `name: スキル名（${skillLimits.name}文字以内、短く覚えやすい名前）`,
    `category: ${categoryList} のいずれか1つ`,
    `effect: 効果の要約（${skillLimits.effect}文字以内、1行）`,
    'detail:',
    'エージェントへの指示文を箇条書きで。守るべきこと、やってはいけないこと、',
    '判断に迷ったときの基準を、具体的に書いてください。',
  ].join('\n');
}

function optimizePrompt(skill: Skill, workspace: string): string {
  return [
    'あなたはAIコーディングエージェントに渡す「スキル」（作業ルール）を整える担当です。',
    `次のスキルは別のプロジェクト（${skill.origin ?? '不明'}）向けに書かれたものです。`,
    'これを、いまのプロジェクトでそのまま使えるように書き直してください。',
    '',
    `対象プロジェクト: ${workspace}`,
    '',
    '--- 元のスキル ---',
    `name: ${skill.name}`,
    `category: ${skill.category}`,
    `effect: ${skill.effect}`,
    'detail:',
    skill.detail,
    '--- ここまで ---',
    '',
    'プロジェクト内のファイルを読んで、言語・フレームワーク・フォルダ構成・命名の',
    '実態に合わせてください。合わない項目は落とし、足りない項目は足してかまいません。',
    'ファイルの変更、コマンドの実行、外部への通信はしないでください。',
    '',
    '返答は次の形式のテキストだけにしてください。前置きも後書きも不要です。',
    'name: スキル名',
    `category: ${categoryList} のいずれか1つ`,
    'effect: 効果の要約（1行）',
    'detail:',
    '書き直した指示文',
  ].join('\n');
}

interface SkillCardProps {
  skill: Skill;
  equipped: boolean;
  children?: React.ReactNode;
}

function SkillCard({ skill, equipped, children }: SkillCardProps): React.JSX.Element {
  const info = categoryInfo(skill.category);
  return (
    <article
      className={`skill-card ${equipped ? 'equipped' : ''}`}
      style={{ '--skill-color': info.color } as React.CSSProperties}
    >
      <span className="skill-mark" aria-hidden>{info.mark}</span>
      <div className="skill-card-copy">
        <header>
          <strong>{skill.name}</strong>
          <span className="skill-category">{info.label}</span>
        </header>
        <p>{skill.effect || '（効果は未記入）'}</p>
        <small>
          {skill.scope === 'global' ? 'グローバル' : 'プロジェクト'}
          {skill.copiedFrom ? ` ・ 写し元: ${skill.copiedFrom}` : ''}
        </small>
      </div>
      {children && <div className="skill-card-actions">{children}</div>}
    </article>
  );
}

export interface SkillBookProps {
  box: SkillBox;
  workspace: string;
  recentWorkspaces: string[];
  modelSettings: ModelSettings;
  /** Codexに相談できるか。未接続のときはAI支援のボタンを止めます。 */
  canAskCodex: boolean;
  onClose: () => void;
  onLog: (message: string, level?: 'info' | 'success' | 'warning' | 'error') => void;
}

type Tab = 'library' | 'shelves';

export function SkillBook({
  box,
  workspace,
  recentWorkspaces,
  modelSettings,
  canAskCodex,
  onClose,
  onLog,
}: SkillBookProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('library');
  const [scope, setScope] = useState<SkillScope>(workspace ? 'project' : 'global');
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [idea, setIdea] = useState('');
  const [thinking, setThinking] = useState('');
  const [error, setError] = useState('');
  const [shelvesLoaded, setShelvesLoaded] = useState(false);
  const detailRef = useRef<HTMLTextAreaElement>(null);

  const equippedIds = useMemo(
    () => ({
      global: new Set(box.book.equippedGlobal),
      project: new Set(box.book.equippedProject),
    }),
    [box.book.equippedGlobal, box.book.equippedProject],
  );
  const isEquipped = (skill: Skill): boolean => equippedIds[skill.scope].has(skill.id);
  const owned = scope === 'global' ? box.book.global : box.book.project;
  const busy = Boolean(thinking);

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setError('');
    setThinking(label);
    try {
      await action();
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message);
      onLog(message, 'error');
    } finally {
      setThinking('');
    }
  }

  function openShelves(): void {
    setTab('shelves');
    if (shelvesLoaded) return;
    void run('他プロジェクトを探しています…', async () => {
      await box.findShelves(recentWorkspaces);
      setShelvesLoaded(true);
    });
  }

  function askCodexFor(prompt: string, label: string): Promise<Partial<DraftState>> {
    return window.pixelCodex
      .askCodex(workspace, prompt, {
        model: resolveModelId(modelSettings),
        effort: modelSettings.effort,
      })
      .then((reply) => {
        onLog(`スキル指南役が${label}を書き上げました`, 'success');
        return parseSkillReply(reply);
      });
  }

  function draftWithAi(): void {
    if (!idea.trim()) {
      setError('どんなスキルが欲しいかを一言で書いてください。');
      return;
    }
    void run('スキル指南役が下書きを書いています…', async () => {
      const written = await askCodexFor(createPrompt(idea.trim(), workspace), '下書き');
      setDraft((current) => ({ ...(current ?? blankDraft(scope)), ...written }));
      detailRef.current?.focus();
    });
  }

  function importSkill(skill: Skill, optimize: boolean): void {
    const target: SkillScope = workspace ? 'project' : 'global';
    void run(
      optimize ? 'スキル指南役がこのプロジェクト向けに書き直しています…' : '取り込んでいます…',
      async () => {
        const base = draftFrom(skill, target, true);
        const written = optimize
          ? await askCodexFor(optimizePrompt(skill, workspace), '書き直し')
          : {};
        setDraft({
          ...base,
          ...written,
          // 名前が空で返ってきても、元の名前が残るようにします。
          name: (written.name || base.name).slice(0, skillLimits.name),
          copiedFrom: `${skill.origin ?? '別プロジェクト'} / ${skill.name}`,
          origin: workspace,
        });
        setTab('library');
        setScope(target);
      },
    );
  }

  function submitDraft(event: React.FormEvent): void {
    event.preventDefault();
    if (!draft) return;
    void run('保存しています…', async () => {
      const saved = await box.save(draft.scope, {
        id: draft.id,
        name: draft.name,
        category: draft.category,
        effect: draft.effect,
        detail: draft.detail,
        origin: draft.origin ?? (draft.scope === 'project' ? workspace : undefined),
        copiedFrom: draft.copiedFrom,
      });
      onLog(`スキル「${saved.name}」を保存しました`, 'success');
      setDraft(null);
      setIdea('');
    });
  }

  function toggleEquip(skill: Skill): void {
    const equipping = !isEquipped(skill);
    void run(equipping ? '装備しています…' : '外しています…', async () => {
      await box.toggleEquip(skill);
      onLog(
        `スキル「${skill.name}」を${equipping ? '装備しました' : '外しました'}`,
        equipping ? 'success' : 'info',
      );
    });
  }

  function removeSkill(skill: Skill): void {
    void run('削除しています…', async () => {
      await box.remove(skill.scope, skill.id);
      onLog(`スキル「${skill.name}」を削除しました`, 'warning');
      if (draft?.id === skill.id) setDraft(null);
    });
  }

  return (
    <div
      className="skill-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="skill-window" role="dialog" aria-modal="true" aria-labelledby="skill-title">
        <header className="game-window-titlebar">
          <div className="title-icon">技</div>
          <div>
            <span>SKILL BOOK</span>
            <h2 id="skill-title">スキルブック</h2>
          </div>
          <button type="button" aria-label="スキルブックを閉じる" onClick={onClose}>×</button>
        </header>

        <div className="skill-stats">
          <span><b>{box.equipped.length}</b> 装備中</span>
          <span><b>{box.book.global.length}</b> グローバル</span>
          <span><b>{box.book.project.length}</b> プロジェクト</span>
          <div className="skill-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'library'}
              className={tab === 'library' ? 'selected' : ''}
              onClick={() => setTab('library')}
            >所持スキル</button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'shelves'}
              className={tab === 'shelves' ? 'selected' : ''}
              onClick={openShelves}
            >他プロジェクトから発掘</button>
          </div>
        </div>

        {(busy || error) && (
          <p className={`skill-banner ${error ? 'error' : ''}`}>{error || thinking}</p>
        )}

        <div className="skill-content">
          <section className="skill-column">
            <div className="game-section-title"><span>01</span><h3>装備中</h3></div>
            <div className="skill-card-list">
              {box.equipped.map((skill) => (
                <SkillCard key={`${skill.scope}-${skill.id}`} skill={skill} equipped>
                  <button type="button" onClick={() => toggleEquip(skill)}>外す</button>
                </SkillCard>
              ))}
              {!box.equipped.length && (
                <p className="skill-empty">
                  まだ何も装備していません。右の一覧から`装備`を押すと、次の指示から効き始めます。
                </p>
              )}
            </div>
          </section>

          {tab === 'library' ? (
            <section className="skill-column wide">
              <div className="game-section-title"><span>02</span><h3>所持スキル</h3></div>
              <div className="skill-scope-switch" role="group" aria-label="スキルの置き場所">
                <button
                  type="button"
                  className={scope === 'global' ? 'selected' : ''}
                  onClick={() => setScope('global')}
                >グローバル（全プロジェクト）</button>
                <button
                  type="button"
                  className={scope === 'project' ? 'selected' : ''}
                  disabled={!workspace}
                  title={workspace ? '' : '作業フォルダを選ぶと使えます'}
                  onClick={() => setScope('project')}
                >プロジェクト専用</button>
                <button
                  type="button"
                  className="skill-new-button"
                  onClick={() => setDraft(draft ? null : blankDraft(scope))}
                >{draft ? '作成を閉じる' : '＋ 新規スキル'}</button>
              </div>

              {draft && (
                <form className="skill-form" onSubmit={submitDraft}>
                  <div className="form-banner">
                    {draft.id ? 'スキルを書き換えます' : '新しいスキルを作ります'}
                    {draft.copiedFrom ? `（写し元: ${draft.copiedFrom}）` : ''}
                  </div>
                  <div className="skill-ai-assist">
                    <label>
                      AI支援：どんなスキルが欲しいか
                      <input
                        value={idea}
                        onChange={(event) => setIdea(event.target.value)}
                        placeholder="例: 変更したファイルには必ずテストを足させたい"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !canAskCodex}
                      title={canAskCodex ? '' : 'Codexへ接続し、作業フォルダを選ぶと使えます'}
                      onClick={draftWithAi}
                    >AIに書いてもらう</button>
                  </div>
                  <label>
                    スキル名
                    <input
                      value={draft.name}
                      maxLength={skillLimits.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      placeholder="例: テスト同伴"
                    />
                  </label>
                  <label>
                    系統
                    <select
                      value={draft.category}
                      onChange={(event) =>
                        setDraft({ ...draft, category: normalizeCategory(event.target.value) })
                      }
                    >
                      {skillCategories.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.mark} {entry.label}（{entry.hint}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    効果（一覧に出る1行の要約）
                    <input
                      value={draft.effect}
                      maxLength={skillLimits.effect}
                      onChange={(event) => setDraft({ ...draft, effect: event.target.value })}
                      placeholder="例: 変更したコードに対応するテストを必ず追加させる"
                    />
                  </label>
                  <label>
                    詳細（そのままエージェントへ渡す指示文）
                    <textarea
                      ref={detailRef}
                      rows={10}
                      value={draft.detail}
                      maxLength={skillLimits.detail}
                      onChange={(event) => setDraft({ ...draft, detail: event.target.value })}
                      placeholder={'- 実装を変えたら、対応するテストも同じ変更で追加・更新する\n- テストが書けない理由があるときは、報告に必ず理由を書く'}
                    />
                  </label>
                  <label>
                    置き場所
                    <select
                      value={draft.scope}
                      onChange={(event) =>
                        setDraft({ ...draft, scope: event.target.value as SkillScope })
                      }
                    >
                      <option value="global">グローバル（どのプロジェクトでも使える）</option>
                      <option value="project" disabled={!workspace}>
                        プロジェクト専用（このフォルダに保存）
                      </option>
                    </select>
                  </label>
                  <button className="game-primary-button" type="submit" disabled={busy}>
                    {draft.id ? '書き換えを保存' : 'このスキルを作成'}
                  </button>
                </form>
              )}

              <div className="skill-card-list">
                {owned.map((skill) => (
                  <SkillCard key={skill.id} skill={skill} equipped={isEquipped(skill)}>
                    <button
                      className={isEquipped(skill) ? '' : 'equip-button'}
                      type="button"
                      onClick={() => toggleEquip(skill)}
                    >{isEquipped(skill) ? '外す' : '装備'}</button>
                    <button type="button" onClick={() => setDraft(draftFrom(skill, skill.scope, false))}>
                      編集
                    </button>
                    <button type="button" onClick={() => setDraft(draftFrom(skill, skill.scope, true))}>
                      複製
                    </button>
                    <button type="button" onClick={() => removeSkill(skill)}>削除</button>
                  </SkillCard>
                ))}
                {!owned.length && (
                  <p className="skill-empty">
                    {scope === 'global'
                      ? 'グローバルのスキルはまだありません。'
                      : 'このプロジェクト専用のスキルはまだありません。'}
                  </p>
                )}
              </div>
            </section>
          ) : (
            <section className="skill-column wide">
              <div className="game-section-title"><span>02</span><h3>他プロジェクトのスキル</h3></div>
              <p className="skill-note">
                最近つないだ作業フォルダの `.pixel-codex/skills/` を見に行きます。
                `最適化して取り込む`を選ぶと、いまのプロジェクトに合わせてAIが書き直した下書きを作ります。
              </p>
              {box.shelves.map((shelf) => (
                <div className="skill-shelf" key={shelf.workspace}>
                  <header title={shelf.workspace}>
                    <strong>{shelf.name}</strong>
                    <small>{shelf.skills.length}件</small>
                  </header>
                  <div className="skill-card-list">
                    {shelf.skills.map((skill) => (
                      <SkillCard key={`${shelf.workspace}-${skill.id}`} skill={skill} equipped={false}>
                        <button type="button" disabled={busy} onClick={() => importSkill(skill, false)}>
                          そのまま取り込む
                        </button>
                        <button
                          className="equip-button"
                          type="button"
                          disabled={busy || !canAskCodex}
                          title={canAskCodex ? '' : 'Codexへ接続し、作業フォルダを選ぶと使えます'}
                          onClick={() => importSkill(skill, true)}
                        >最適化して取り込む</button>
                      </SkillCard>
                    ))}
                  </div>
                </div>
              ))}
              {shelvesLoaded && !box.shelves.length && (
                <p className="skill-empty">
                  他の作業フォルダにスキルは見つかりませんでした。
                  `WORKSPACE`でつないだことのあるフォルダだけを探します。
                </p>
              )}
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
