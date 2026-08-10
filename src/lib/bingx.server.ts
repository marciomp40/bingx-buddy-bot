import type { Candle } from "./indicators";

const BASE_URL = "https://open-api.bingx.com";

function requireCredentials() {
  const apiKey = process.env["BINGX_API_KEY"];
  const apiSecret = process.env["BINGX_API_SECRET"];
  if (!apiKey || !apiSecret) {
    throw new Error(
      "Chaves da BingX não configuradas. Adicione BINGX_API_KEY e BINGX_API_SECRET para operar com ordens reais.",
    );
  }
  return { apiKey, apiSecret };
}

export function hasCredentials() {
  return Boolean(process.env["BINGX_API_KEY"] && process.env["BINGX_API_SECRET"]);
}

async function sign(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type Params = Record<string, string | number | undefined>;

function sortedEntries(params: Params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

/** String crua usada para assinar (a BingX assina sem URL-encode). */
function buildQuery(params: Params) {
  return sortedEntries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** String enviada na URL — valores precisam ser codificados (JSON de TP/SL). */
function buildEncodedQuery(params: Params) {
  return sortedEntries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}


export async function publicRequest<T>(path: string, params: Params = {}): Promise<T> {
  const query = buildQuery(params);
  const response = await fetch(`${BASE_URL}${path}${query ? `?${query}` : ""}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`BingX respondeu ${response.status}: ${text}`);
  }
  const json = JSON.parse(text) as { code: number; msg?: string; data: T };
  if (json.code !== 0) throw new Error(`BingX erro ${json.code}: ${json.msg ?? "desconhecido"}`);
  return json.data;
}

export async function signedRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {},
): Promise<T> {
  const { apiKey, apiSecret } = requireCredentials();
  const all = { ...params, timestamp: Date.now(), recvWindow: 5000 };
  const signature = await sign(buildQuery(all), apiSecret);
  const url = `${BASE_URL}${path}?${buildEncodedQuery(all)}&signature=${signature}`;
  const response = await fetch(url, { method, headers: { "X-BX-APIKEY": apiKey } });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`BingX respondeu ${response.status}: ${text}`);
  }
  const json = JSON.parse(text) as { code: number; msg?: string; data: T };
  if (json.code !== 0) throw new Error(`BingX erro ${json.code}: ${json.msg ?? "desconhecido"}`);
  return json.data;
}

type RawKline = {
  open: string;
  close: string;
  high: string;
  low: string;
  volume: string;
  time: number;
};

export async function fetchKlines(symbol: string, interval: string, limit = 200): Promise<Candle[]> {
  const data = await publicRequest<RawKline[]>("/openApi/swap/v3/quote/klines", {
    symbol,
    interval,
    limit,
  });
  return data
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }))
    .sort((a, b) => a.time - b.time);
}

export type BalanceInfo = {
  asset: string;
  balance: number;
  equity: number;
  availableMargin: number;
  unrealizedProfit: number;
};

export async function fetchBalance(): Promise<BalanceInfo> {
  const data = await signedRequest<{
    balance: {
      asset: string;
      balance: string;
      equity: string;
      availableMargin: string;
      unrealizedProfit: string;
    };
  }>("GET", "/openApi/swap/v2/user/balance");
  const b = data.balance;
  return {
    asset: b.asset,
    balance: Number(b.balance),
    equity: Number(b.equity),
    availableMargin: Number(b.availableMargin),
    unrealizedProfit: Number(b.unrealizedProfit),
  };
}

export type PositionInfo = {
  positionId: string;
  symbol: string;
  positionSide: "LONG" | "SHORT";
  positionAmt: number;
  avgPrice: number;
  leverage: number;
  unrealizedProfit: number;
  markPrice: number;
};

export async function fetchPositions(symbol?: string): Promise<PositionInfo[]> {
  const data = await signedRequest<
    Array<{
      positionId: string;
      symbol: string;
      positionSide: "LONG" | "SHORT";
      positionAmt: string;
      avgPrice: string;
      leverage: number;
      unrealizedProfit: string;
      markPrice?: string;
    }>
  >("GET", "/openApi/swap/v2/user/positions", symbol ? { symbol } : {});
  return (data ?? [])
    .filter((p) => Number(p.positionAmt) !== 0)
    .map((p) => ({
      positionId: p.positionId,
      symbol: p.symbol,
      positionSide: p.positionSide,
      positionAmt: Number(p.positionAmt),
      avgPrice: Number(p.avgPrice),
      leverage: Number(p.leverage),
      unrealizedProfit: Number(p.unrealizedProfit),
      markPrice: Number(p.markPrice ?? p.avgPrice),
    }));
}

export async function setLeverage(symbol: string, side: "LONG" | "SHORT", leverage: number) {
  return signedRequest("POST", "/openApi/swap/v2/trade/leverage", { symbol, side, leverage });
}

/** Soma o PnL realizado (incluindo taxas e funding) desde 00:00 UTC de hoje. */
export async function fetchDailyPnl(symbol?: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const data = await signedRequest<Array<{ income: string; symbol: string; incomeType: string }>>(
    "GET",
    "/openApi/swap/v2/user/income",
    { startTime: startOfDay.getTime(), limit: 1000, ...(symbol ? { symbol } : {}) },
  );
  return (data ?? []).reduce((total, row) => total + Number(row.income ?? 0), 0);
}


export type OrderResult = { orderId: string; symbol: string; side: string; positionSide: string };

export async function placeMarketOrder(input: {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}): Promise<OrderResult> {
  const params: Params = {
    symbol: input.symbol,
    type: "MARKET",
    side: input.positionSide === "LONG" ? "BUY" : "SELL",
    positionSide: input.positionSide,
    quantity: input.quantity,
  };
  if (input.takeProfitPrice) {
    params["takeProfit"] = JSON.stringify({
      type: "TAKE_PROFIT_MARKET",
      stopPrice: input.takeProfitPrice,
      price: input.takeProfitPrice,
      workingType: "MARK_PRICE",
    });
  }
  if (input.stopLossPrice) {
    params["stopLoss"] = JSON.stringify({
      type: "STOP_MARKET",
      stopPrice: input.stopLossPrice,
      price: input.stopLossPrice,
      workingType: "MARK_PRICE",
    });
  }
  const data = await signedRequest<{ order: OrderResult }>(
    "POST",
    "/openApi/swap/v2/trade/order",
    params,
  );
  return data.order;
}

export async function closePosition(symbol: string, positionSide: "LONG" | "SHORT", quantity: number) {
  const data = await signedRequest<{ order: OrderResult }>("POST", "/openApi/swap/v2/trade/order", {
    symbol,
    type: "MARKET",
    side: positionSide === "LONG" ? "SELL" : "BUY",
    positionSide,
    quantity,
  });
  return data.order;
}
