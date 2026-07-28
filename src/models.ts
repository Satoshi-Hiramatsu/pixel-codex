/**
 * The models the studio can be told to use. `id` is passed straight to Codex's
 * `thread/start`; an empty id means "leave it to the Codex CLI configuration".
 * `planId` picks the matching price list in `costs.ts` so the payroll meter
 * follows the model the user actually selected.
 */
export interface ModelOption {
  id: string;
  label: string;
  note: string;
  planId: string;
}

export interface EffortOption {
  id: string;
  label: string;
  note: string;
}

export const modelOptions: ModelOption[] = [
  {
    id: '',
    label: 'おまかせ（Codexの設定どおり）',
    note: 'Codex CLI側で設定しているモデルをそのまま使います。',
    planId: 'gpt-5-codex',
  },
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex（開発向け・標準）',
    note: 'コードを書く仕事がいちばん得意。迷ったらこれ。',
    planId: 'gpt-5-codex',
  },
  {
    id: 'gpt-5',
    label: 'GPT-5（万能型）',
    note: '調査や文章づくりも含めて、幅広い仕事をこなします。',
    planId: 'gpt-5',
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini（軽い・安い）',
    note: '簡単な作業向け。料金がぐっと安くなります。',
    planId: 'gpt-5-mini',
  },
];

export const effortOptions: EffortOption[] = [
  { id: '', label: 'おまかせ', note: 'Codexの既定の考える深さを使います。' },
  { id: 'low', label: 'はやい（浅く考える）', note: '返事が早く、料金も抑えめです。' },
  { id: 'medium', label: 'ふつう', note: '速さと正確さのバランス型です。' },
  { id: 'high', label: 'じっくり（深く考える）', note: '難しい作業向け。時間と料金は増えます。' },
];

export interface ModelSettings {
  modelId: string;
  customModelId: string;
  effort: string;
}

export const defaultModelSettings: ModelSettings = {
  modelId: '',
  customModelId: '',
  effort: '',
};

export function findModel(modelId: string): ModelOption {
  return modelOptions.find((option) => option.id === modelId) ?? modelOptions[0];
}

/** The id actually sent to Codex: a hand-typed id wins over the dropdown. */
export function resolveModelId(settings: ModelSettings): string {
  const custom = settings.customModelId.trim();
  if (custom) return custom;
  return settings.modelId;
}

export function modelLabel(settings: ModelSettings): string {
  const custom = settings.customModelId.trim();
  if (custom) return `${custom}（手入力）`;
  return findModel(settings.modelId).label;
}

/** Which price list to bill against for the currently selected model. */
export function modelPlanId(settings: ModelSettings): string {
  const custom = settings.customModelId.trim().toLowerCase();
  if (custom) {
    if (custom.includes('mini') || custom.includes('nano')) return 'gpt-5-mini';
    return 'gpt-5-codex';
  }
  return findModel(settings.modelId).planId;
}
