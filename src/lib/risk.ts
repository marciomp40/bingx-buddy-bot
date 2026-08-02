/** Regras de gestão de risco compartilhadas pelas server functions. */

export type RiskSettings = {
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxLeverage: number;
  useRiskSizing: boolean;
  quantity: number;
  stopLossPct: number;
  leverage: number;
};

/** Limita a alavancagem ao teto configurado. */
export function clampLeverage(leverage: number, maxLeverage: number) {
  const cap = Math.max(1, Math.floor(maxLeverage || 1));
  return Math.min(Math.max(1, Math.floor(leverage || 1)), cap);
}

/** Arredonda a quantidade para uma casa decimal segura conforme a magnitude. */
export function roundQuantity(quantity: number) {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const digits = quantity >= 100 ? 0 : quantity >= 10 ? 1 : quantity >= 1 ? 2 : quantity >= 0.1 ? 3 : 4;
  return Number(quantity.toFixed(digits));
}

/**
 * Quantidade baseada no risco: arrisca `riskPerTradePct` do patrimônio
 * considerando a distância até o stop loss.
 */
export function sizePosition(input: {
  equity: number | null;
  price: number;
  riskPerTradePct: number;
  stopLossPct: number;
  fallbackQuantity: number;
  useRiskSizing: boolean;
  leverage: number;
  availableMargin?: number | null;
}) {
  const { equity, price, riskPerTradePct, stopLossPct, fallbackQuantity, useRiskSizing } = input;
  if (!useRiskSizing || !equity || equity <= 0 || price <= 0 || stopLossPct <= 0) {
    return { quantity: roundQuantity(fallbackQuantity), source: "fixa" as const };
  }
  const riskAmount = (equity * riskPerTradePct) / 100;
  const riskPerUnit = price * (stopLossPct / 100);
  let quantity = riskAmount / riskPerUnit;

  // não deixa a margem exigida passar da margem livre disponível
  const margin = input.availableMargin;
  if (margin && margin > 0) {
    const maxByMargin = (margin * input.leverage * 0.95) / price;
    quantity = Math.min(quantity, maxByMargin);
  }

  const rounded = roundQuantity(quantity);
  if (rounded <= 0) {
    return { quantity: roundQuantity(fallbackQuantity), source: "fixa" as const };
  }
  return { quantity: rounded, source: "risco" as const };
}

export type DailyGuard = {
  dailyPnl: number;
  equity: number | null;
  lossLimit: number;
  lossPct: number;
  blocked: boolean;
};

/** Avalia se o limite de perda diária foi atingido. */
export function evaluateDailyGuard(input: {
  dailyPnl: number;
  equity: number | null;
  maxDailyLossPct: number;
}): DailyGuard {
  const equity = input.equity;
  const base = equity && equity > 0 ? equity + Math.max(0, -input.dailyPnl) : 0;
  const lossLimit = (base * input.maxDailyLossPct) / 100;
  const loss = Math.max(0, -input.dailyPnl);
  return {
    dailyPnl: input.dailyPnl,
    equity,
    lossLimit,
    lossPct: lossLimit > 0 ? (loss / lossLimit) * 100 : 0,
    blocked: input.maxDailyLossPct > 0 && lossLimit > 0 && loss >= lossLimit,
  };
}
