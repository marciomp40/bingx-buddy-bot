export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SignalSide = "LONG" | "SHORT" | "NONE";

export type Analysis = {
  price: number;
  basis: number;
  upper: number;
  lower: number;
  bandwidth: number;
  percentB: number;
  volume: number;
  volumeAvg: number;
  volumeRatio: number;
  rsi: number;
  side: SignalSide;
  confidence: number;
  reason: string;
};

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : Number.NaN);
  }
  return out;
}

export function stdDev(values: number[], period: number, means: number[]): number[] {
  return values.map((_, i) => {
    if (i < period - 1) return Number.NaN;
    const mean = means[i]!;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j]! - mean) ** 2;
    return Math.sqrt(acc / period);
  });
}

export function rsi(values: number[], period = 14): number[] {
  const out: number[] = [Number.NaN];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const up = Math.max(diff, 0);
    const down = Math.max(-diff, 0);
    if (i <= period) {
      gain += up;
      loss += down;
      if (i === period) {
        gain /= period;
        loss /= period;
        out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
      } else {
        out.push(Number.NaN);
      }
      continue;
    }
    gain = (gain * (period - 1) + up) / period;
    loss = (loss * (period - 1) + down) / period;
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  }
  return out;
}

export type BollingerConfig = {
  period: number;
  multiplier: number;
  volumePeriod: number;
  volumeThreshold: number;
  rsiLongMax: number;
  rsiShortMin: number;
};

export const defaultBollingerConfig: BollingerConfig = {
  period: 20,
  multiplier: 2,
  volumePeriod: 20,
  volumeThreshold: 1.5,
  rsiLongMax: 35,
  rsiShortMin: 65,
};

export type BandPoint = {
  time: number;
  close: number;
  basis: number;
  upper: number;
  lower: number;
  volume: number;
};

export function computeBands(candles: Candle[], config: BollingerConfig): BandPoint[] {
  const closes = candles.map((c) => c.close);
  const basis = sma(closes, config.period);
  const dev = stdDev(closes, config.period, basis);
  return candles.map((c, i) => ({
    time: c.time,
    close: c.close,
    basis: basis[i]!,
    upper: basis[i]! + config.multiplier * dev[i]!,
    lower: basis[i]! - config.multiplier * dev[i]!,
    volume: c.volume,
  }));
}

/**
 * Estratégia de scalping: reversão nas bandas de Bollinger com confirmação de volume.
 * LONG  -> preço fecha abaixo/na banda inferior, volume acima da média e RSI em sobrevenda.
 * SHORT -> preço fecha acima/na banda superior, volume acima da média e RSI em sobrecompra.
 */
export function analyze(candles: Candle[], config: BollingerConfig): Analysis | null {
  if (candles.length < Math.max(config.period, config.volumePeriod) + 2) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const basisArr = sma(closes, config.period);
  const devArr = stdDev(closes, config.period, basisArr);
  const volAvgArr = sma(volumes, config.volumePeriod);
  const rsiArr = rsi(closes, 14);

  const i = candles.length - 1;
  const price = closes[i]!;
  const basis = basisArr[i]!;
  const dev = devArr[i]!;
  const upper = basis + config.multiplier * dev;
  const lower = basis - config.multiplier * dev;
  const volume = volumes[i]!;
  const volumeAvg = volAvgArr[i]!;
  const volumeRatio = volumeAvg > 0 ? volume / volumeAvg : 0;
  const bandwidth = basis > 0 ? ((upper - lower) / basis) * 100 : 0;
  const percentB = upper !== lower ? ((price - lower) / (upper - lower)) * 100 : 50;
  const rsiNow = rsiArr[i]!;

  const volumeOk = volumeRatio >= config.volumeThreshold;
  let side: SignalSide = "NONE";
  let reason = "Preço dentro das bandas — aguardando toque com volume.";

  if (price <= lower && volumeOk && rsiNow <= config.rsiLongMax) {
    side = "LONG";
    reason = `Preço tocou a banda inferior com volume ${volumeRatio.toFixed(2)}x e RSI ${rsiNow.toFixed(1)}.`;
  } else if (price >= upper && volumeOk && rsiNow >= config.rsiShortMin) {
    side = "SHORT";
    reason = `Preço tocou a banda superior com volume ${volumeRatio.toFixed(2)}x e RSI ${rsiNow.toFixed(1)}.`;
  } else if ((price <= lower || price >= upper) && !volumeOk) {
    reason = `Toque na banda sem volume (${volumeRatio.toFixed(2)}x < ${config.volumeThreshold}x) — sinal descartado.`;
  } else if (price <= lower || price >= upper) {
    reason = `Toque na banda mas RSI ${rsiNow.toFixed(1)} não confirma a reversão.`;
  }

  const distance = side === "LONG" ? (lower - price) / lower : side === "SHORT" ? (price - upper) / upper : 0;
  const confidence =
    side === "NONE"
      ? 0
      : Math.min(
          100,
          Math.round(
            40 +
              Math.min(volumeRatio / config.volumeThreshold, 2) * 20 +
              Math.abs(distance) * 4000 +
              (side === "LONG" ? (config.rsiLongMax - rsiNow) : (rsiNow - config.rsiShortMin)) * 1.2,
          ),
        );

  return {
    price,
    basis,
    upper,
    lower,
    bandwidth,
    percentB,
    volume,
    volumeAvg,
    volumeRatio,
    rsi: rsiNow,
    side,
    confidence: Math.max(confidence, 0),
    reason,
  };
}
