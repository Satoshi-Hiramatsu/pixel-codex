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
  /**
   * `usage` bills per token (API / 従量課金).
   * `flat` is a monthly subscription (定額課金) where tokens cost nothing extra.
   */
  kind: 'usage' | 'flat';
  /** USD per 1,000,000 tokens. */
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  /** Monthly price in yen, for the flat plans. */
  monthlyJpy?: number;
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
    label: 'GPT-5 Codex（API・従量課金）',
    note: '入力 $1.25 / キャッシュ $0.125 / 出力 $10（100万トークンあたり）',
    kind: 'usage',
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.125,
    outputPerMTok: 10,
  },
  {
    id: 'gpt-5',
    label: 'GPT-5（API・従量課金）',
    note: '入力 $1.25 / キャッシュ $0.125 / 出力 $10（100万トークンあたり）',
    kind: 'usage',
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.125,
    outputPerMTok: 10,
  },
  {
    id: 'gpt-5-mini',
    label: 'GPT-5 mini（API・従量課金）',
    note: '入力 $0.25 / キャッシュ $0.025 / 出力 $2（100万トークンあたり）',
    kind: 'usage',
    inputPerMTok: 0.25,
    cachedInputPerMTok: 0.025,
    outputPerMTok: 2,
  },
  {
    id: 'chatgpt-plus',
    label: 'ChatGPT Plus（定額課金・月2万円未満）',
    note: '月額に含まれるため、使っても追加のお金はかかりません（目安 月3,000円）',
    kind: 'flat',
    inputPerMTok: 0,
    cachedInputPerMTok: 0,
    outputPerMTok: 0,
    monthlyJpy: 3_000,
  },
  {
    id: 'chatgpt-pro',
    label: 'ChatGPT Pro（定額課金・上位）',
    note: '月額に含まれるため、使っても追加のお金はかかりません（目安 月30,000円）',
    kind: 'flat',
    inputPerMTok: 0,
    cachedInputPerMTok: 0,
    outputPerMTok: 0,
    monthlyJpy: 30_000,
  },
  {
    id: 'custom',
    label: 'じぶんで単価を決める',
    note: '100万トークンあたりの金額（USD）を自由に設定できます',
    kind: 'usage',
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

export interface PlanEstimate {
  planId: string;
  label: string;
  kind: 'usage' | 'flat' | 'api';
  yen: number;
  note: string;
}

/**
 * 「いまの作業量を、ほかの契約でやっていたらいくらだったか」を全プランぶん出します。
 * 従量課金は実額、定額課金は月額をそのまま出したうえで、
 * 今回ぶんが月額の何％にあたるかを注記します。
 */
export function estimateAllPlans(usage: TokenUsage, settings: CostSettings): PlanEstimate[] {
  return pricingPlans.map((plan) => {
    if (plan.kind === 'flat') {
      const monthly = plan.monthlyJpy ?? 0;
      const asUsage = jpyCost(usage, { ...settings, planId: 'gpt-5-codex' });
      const share = monthly > 0 ? (asUsage / monthly) * 100 : 0;
      return {
        planId: plan.id,
        label: plan.label,
        kind: 'flat' as const,
        yen: monthly,
        note: `月額 ￥${monthly.toLocaleString('ja-JP')}（今回の作業は月額の約 ${share.toFixed(1)}% 相当）`,
      };
    }
    const yen = jpyCost(usage, { ...settings, planId: plan.id });
    return {
      planId: plan.id,
      label: plan.label,
      kind: plan.id === 'custom' ? ('usage' as const) : ('api' as const),
      yen,
      note: plan.note,
    };
  });
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
