export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

export interface PricingPlan {
  id: string;
  label: string;
  note: string;
  /** USD per 1,000,000 tokens. */
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

export interface CostSettings {
  planId: string;
  jpyPerUsd: number;
  customInputPerMTok: number;
  customCachedPerMTok: number;
  customOutputPerMTok: number;
}

export const emptyUsage: TokenUsage = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };

// Reference API list prices (USD / 1M tokens). They are shown in the UI as
// "目安" because the actual bill depends on the plan the user signed up for.
export const pricingPlans: PricingPlan[] = [
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex（従量課金）',
    note: '入力 $1.25 / キャッシュ $0.125 / 出力 $10（100万トークンあたり）',
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.125,
    outputPerMTok: 10,
  },
  {
    id: 'gpt-5',
    label: 'GPT-5（従量課金）',
    note: '入力 $1.25 / キャッシュ $0.125 / 出力 $10（100万トークンあたり）',
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.125,
    outputPerMTok: 10,
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini（従量課金）',
    note: '入力 $0.25 / キャッシュ $0.025 / 出力 $2（100万トークンあたり）',
    inputPerMTok: 0.25,
    cachedInputPerMTok: 0.025,
    outputPerMTok: 2,
  },
  {
    id: 'chatgpt-plan',
    label: 'ChatGPT 定額プラン',
    note: '月額に含まれるため、使っても追加のお金はかかりません',
    inputPerMTok: 0,
    cachedInputPerMTok: 0,
    outputPerMTok: 0,
  },
  {
    id: 'custom',
    label: 'じぶんで単価を決める',
    note: '100万トークンあたりの金額（USD）を自由に設定できます',
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.125,
    outputPerMTok: 10,
  },
];

export const defaultCostSettings: CostSettings = {
  planId: 'gpt-5-codex',
  jpyPerUsd: 155,
  customInputPerMTok: 1.25,
  customCachedPerMTok: 0.125,
  customOutputPerMTok: 10,
};

export function findPlan(planId: string): PricingPlan {
  return pricingPlans.find((plan) => plan.id === planId) ?? pricingPlans[0];
}

export function planPrices(settings: CostSettings): {
  input: number;
  cachedInput: number;
  output: number;
} {
  if (settings.planId === 'custom') {
    return {
      input: settings.customInputPerMTok,
      cachedInput: settings.customCachedPerMTok,
      output: settings.customOutputPerMTok,
    };
  }
  const plan = findPlan(settings.planId);
  return {
    input: plan.inputPerMTok,
    cachedInput: plan.cachedInputPerMTok,
    output: plan.outputPerMTok,
  };
}

export function addUsage(base: TokenUsage, extra: TokenUsage): TokenUsage {
  return {
    input: base.input + extra.input,
    cachedInput: base.cachedInput + extra.cachedInput,
    output: base.output + extra.output,
    reasoning: base.reasoning + extra.reasoning,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output;
}

/**
 * Codex reports `input` including the cached portion, and cached tokens are
 * billed at a lower rate, so the fresh input is what remains after removing them.
 */
export function usdCost(usage: TokenUsage, settings: CostSettings): number {
  const prices = planPrices(settings);
  const cached = Math.min(usage.cachedInput, usage.input);
  const fresh = Math.max(0, usage.input - cached);
  return (
    (fresh / 1_000_000) * prices.input +
    (cached / 1_000_000) * prices.cachedInput +
    (usage.output / 1_000_000) * prices.output
  );
}

export function jpyCost(usage: TokenUsage, settings: CostSettings): number {
  return usdCost(usage, settings) * settings.jpyPerUsd;
}

/** Splits yen into the big scoreboard digits and the small "銭" remainder. */
export function splitYen(value: number): { main: string; fraction: string } {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  const whole = Math.floor(safe);
  const fraction = Math.round((safe - whole) * 100);
  return {
    main: whole.toLocaleString('ja-JP').padStart(2, '0'),
    fraction: String(fraction).padStart(2, '0'),
  };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
