import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const configSchema = z.object({
  symbol: z.string(),
  interval: z.string(),
  bbPeriod: z.number(),
  bbMultiplier: z.number(),
  volumePeriod: z.number(),
  volumeThreshold: z.number(),
  rsiLongMax: z.number(),
  rsiShortMin: z.number(),
  quantity: z.number(),
  leverage: z.number(),
  takeProfitPct: z.number(),
  stopLossPct: z.number(),
  allowShort: z.boolean(),
});

export type BotConfig = z.infer<typeof configSchema>;

export const getMarket = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => configSchema.parse(input))
  .handler(async ({ data }) => {
    const { fetchKlines, hasCredentials } = await import("./bingx.server");
    const { analyze, computeBands } = await import("./indicators");
    const candles = await fetchKlines(data.symbol, data.interval, 200);
    const cfg = {
      period: data.bbPeriod,
      multiplier: data.bbMultiplier,
      volumePeriod: data.volumePeriod,
      volumeThreshold: data.volumeThreshold,
      rsiLongMax: data.rsiLongMax,
      rsiShortMin: data.rsiShortMin,
    };
    return {
      candles: candles.slice(-120),
      bands: computeBands(candles, cfg).slice(-120),
      analysis: analyze(candles, cfg),
      credentials: hasCredentials(),
    };
  });

export const getAccount = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ symbol: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const { fetchBalance, fetchPositions, hasCredentials } = await import("./bingx.server");
    if (!hasCredentials()) {
      return { credentials: false as const, balance: null, positions: [] };
    }
    const [balance, positions] = await Promise.all([fetchBalance(), fetchPositions(data.symbol)]);
    return { credentials: true as const, balance, positions };
  });

export const openTrade = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    configSchema.extend({ side: z.enum(["LONG", "SHORT"]), price: z.number() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { placeMarketOrder, setLeverage } = await import("./bingx.server");
    try {
      await setLeverage(data.symbol, data.side, data.leverage);
    } catch {
      // alavancagem já configurada ou não editável — segue com a ordem
    }
    const tp =
      data.side === "LONG"
        ? data.price * (1 + data.takeProfitPct / 100)
        : data.price * (1 - data.takeProfitPct / 100);
    const sl =
      data.side === "LONG"
        ? data.price * (1 - data.stopLossPct / 100)
        : data.price * (1 + data.stopLossPct / 100);
    const order = await placeMarketOrder({
      symbol: data.symbol,
      positionSide: data.side,
      quantity: data.quantity,
      takeProfitPrice: Number(tp.toFixed(2)),
      stopLossPrice: Number(sl.toFixed(2)),
    });
    return { orderId: String(order.orderId), side: data.side, takeProfit: tp, stopLoss: sl };
  });

export const closeTrade = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        symbol: z.string(),
        positionSide: z.enum(["LONG", "SHORT"]),
        quantity: z.number(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { closePosition } = await import("./bingx.server");
    const order = await closePosition(data.symbol, data.positionSide, data.quantity);
    return { orderId: String(order.orderId) };
  });

/** Um ciclo do robô: analisa o mercado e, se houver sinal e nenhuma posição aberta, envia a ordem. */
export const botTick = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => configSchema.parse(input))
  .handler(async ({ data }) => {
    const { fetchKlines, fetchPositions, placeMarketOrder, setLeverage, hasCredentials } =
      await import("./bingx.server");
    const { analyze } = await import("./indicators");

    const candles = await fetchKlines(data.symbol, data.interval, 200);
    const analysis = analyze(candles, {
      period: data.bbPeriod,
      multiplier: data.bbMultiplier,
      volumePeriod: data.volumePeriod,
      volumeThreshold: data.volumeThreshold,
      rsiLongMax: data.rsiLongMax,
      rsiShortMin: data.rsiShortMin,
    });

    if (!analysis) return { action: "skip" as const, message: "Dados insuficientes.", analysis: null };
    if (!hasCredentials()) {
      return { action: "skip" as const, message: "Chaves da BingX não configuradas.", analysis };
    }
    if (analysis.side === "NONE") {
      return { action: "hold" as const, message: analysis.reason, analysis };
    }
    if (analysis.side === "SHORT" && !data.allowShort) {
      return { action: "hold" as const, message: "Sinal de venda ignorado (short desativado).", analysis };
    }

    const positions = await fetchPositions(data.symbol);
    if (positions.length > 0) {
      return {
        action: "hold" as const,
        message: `Sinal ${analysis.side} detectado, mas já existe posição aberta em ${data.symbol}.`,
        analysis,
      };
    }

    try {
      await setLeverage(data.symbol, analysis.side, data.leverage);
    } catch {
      // ignora
    }
    const tp =
      analysis.side === "LONG"
        ? analysis.price * (1 + data.takeProfitPct / 100)
        : analysis.price * (1 - data.takeProfitPct / 100);
    const sl =
      analysis.side === "LONG"
        ? analysis.price * (1 - data.stopLossPct / 100)
        : analysis.price * (1 + data.stopLossPct / 100);

    const order = await placeMarketOrder({
      symbol: data.symbol,
      positionSide: analysis.side,
      quantity: data.quantity,
      takeProfitPrice: Number(tp.toFixed(2)),
      stopLossPrice: Number(sl.toFixed(2)),
    });

    return {
      action: "opened" as const,
      message: `Ordem ${analysis.side} enviada (${data.quantity} ${data.symbol}) — TP ${tp.toFixed(2)} / SL ${sl.toFixed(2)}.`,
      orderId: String(order.orderId),
      analysis,
    };
  });
