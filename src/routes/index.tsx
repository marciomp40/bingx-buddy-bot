import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";
import type { BotConfig } from "@/lib/trading.functions";
import {
  botTick,
  closeTrade,
  getAccount,
  getMarket,
  getRiskStatus,
  openTrade,
} from "@/lib/trading.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Robô Scalping BingX | Bollinger + Volume" },
      {
        name: "description",
        content:
          "Robô de scalping para futuros perpétuos da BingX: sinais de Bollinger com confirmação de volume, execução automática de ordens, take profit e stop loss.",
      },
      { property: "og:title", content: "Robô Scalping BingX | Bollinger + Volume" },
      {
        property: "og:description",
        content:
          "Automatize scalping em futuros perpétuos da BingX com bandas de Bollinger, filtro de volume e gestão de risco.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ScalpingBot,
});

const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT", "BNB-USDT"];
const INTERVALS = ["1m", "3m", "5m", "15m"];

type CandleShapeProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: { open: number; close: number; high: number; low: number; bullish: boolean };
};

/** Desenha uma vela (corpo + pavio) usando o range [low, high] da barra. */
function CandleShape({ x = 0, y = 0, width = 0, height = 0, payload }: CandleShapeProps) {
  if (!payload) return null;
  const { open, close, high, low, bullish } = payload;
  const range = high - low;
  const scale = range > 0 ? height / range : 0;
  const priceToY = (p: number) => y + (high - p) * scale;
  const color = bullish ? "var(--color-chart-2)" : "var(--color-destructive)";
  const bodyTop = priceToY(Math.max(open, close));
  const bodyBottom = priceToY(Math.min(open, close));
  const bodyHeight = Math.max(bodyBottom - bodyTop, 1);
  const bodyWidth = Math.max(width * 0.6, 1);
  const center = x + width / 2;
  return (
    <g>
      <line x1={center} x2={center} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect
        x={center - bodyWidth / 2}
        y={bodyTop}
        width={bodyWidth}
        height={bodyHeight}
        fill={bullish ? color : color}
        fillOpacity={bullish ? 0.9 : 0.9}
        stroke={color}
      />
    </g>
  );
}


const defaultConfig: BotConfig = {
  symbol: "BTC-USDT",
  interval: "1m",
  bbPeriod: 20,
  bbMultiplier: 2,
  volumePeriod: 20,
  volumeThreshold: 1.5,
  rsiLongMax: 35,
  rsiShortMin: 65,
  quantity: 0.001,
  leverage: 5,
  takeProfitPct: 0.4,
  stopLossPct: 0.25,
  allowShort: true,
  riskPerTradePct: 1,
  maxDailyLossPct: 3,
  maxLeverage: 10,
  useRiskSizing: true,
};


type LogEntry = { at: number; kind: "info" | "trade" | "error"; text: string };

function fmt(value: number | undefined | null, digits = 2) {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return value.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const RUNNING_KEY = "scalping-bot-running";

function ScalpingBot() {
  const [config, setConfig] = useState<BotConfig>(defaultConfig);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const tickingRef = useRef(false);
  const configRef = useRef(config);
  configRef.current = config;

  // restaura o estado do robô após recarregar a página
  useEffect(() => {
    if (localStorage.getItem(RUNNING_KEY) === "1") setRunning(true);
  }, []);
  useEffect(() => {
    localStorage.setItem(RUNNING_KEY, running ? "1" : "0");
  }, [running]);


  const marketFn = useServerFn(getMarket);
  const accountFn = useServerFn(getAccount);
  const tickFn = useServerFn(botTick);
  const openFn = useServerFn(openTrade);
  const closeFn = useServerFn(closeTrade);
  const riskFn = useServerFn(getRiskStatus);

  const pushLog = useCallback((kind: LogEntry["kind"], text: string) => {
    setLog((prev) => [{ at: Date.now(), kind, text }, ...prev].slice(0, 40));
  }, []);

  const market = useQuery({
    queryKey: ["market", config],
    queryFn: () => marketFn({ data: config }),
    refetchInterval: 5000,
  });

  const account = useQuery({
    queryKey: ["account", config.symbol],
    queryFn: () => accountFn({ data: { symbol: config.symbol } }),
    refetchInterval: 8000,
  });

  const risk = useQuery({
    queryKey: ["risk", config.symbol, config.maxDailyLossPct],
    queryFn: () => riskFn({ data: { symbol: config.symbol, maxDailyLossPct: config.maxDailyLossPct } }),
    refetchInterval: 20000,
  });


  const manualOrder = useMutation({
    mutationFn: (side: "LONG" | "SHORT") =>
      openFn({ data: { ...config, side, price: market.data?.analysis?.price ?? 0 } }),
    onSuccess: (res) => {
      pushLog(
        "trade",
        `Ordem manual ${res.side} enviada · ${res.quantity} @ ${res.leverage}x (sizing ${res.sizing}) · TP ${fmt(res.takeProfit)} / SL ${fmt(res.stopLoss)}`,
      );
      toast.success(`Ordem ${res.side} enviada`);
      void account.refetch();
      void risk.refetch();
    },

    onError: (error: Error) => {
      pushLog("error", error.message);
      toast.error(error.message);
    },
  });

  const close = useMutation({
    mutationFn: (input: { positionSide: "LONG" | "SHORT"; quantity: number }) =>
      closeFn({ data: { symbol: config.symbol, ...input } }),
    onSuccess: () => {
      pushLog("trade", "Posição encerrada a mercado.");
      toast.success("Posição encerrada");
      void account.refetch();
      void risk.refetch();
    },
    onError: (error: Error) => {
      pushLog("error", error.message);
      toast.error(error.message);
    },
  });

  useEffect(() => {
    if (!running) return;
    let cancelled = false;

    const tick = async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const res = await tickFn({ data: config });
        if (cancelled) return;
        if (res.action === "opened") {
          pushLog("trade", res.message);
          toast.success(res.message);
          void account.refetch();
          void risk.refetch();
        } else if (res.action === "blocked") {
          pushLog("error", res.message);
          toast.error(res.message);
          void risk.refetch();
          setRunning(false);
        } else if (res.action === "skip") {
          pushLog("error", res.message);
        } else {
          pushLog("info", res.message);
        }

      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Falha no ciclo do robô";
          pushLog("error", message);
        }
      } finally {
        tickingRef.current = false;
      }
    };

    pushLog("info", `Robô iniciado em ${config.symbol} · ${config.interval}`);
    void tick();
    const id = setInterval(() => void tick(), 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, config]);

  const analysis = market.data?.analysis ?? null;
  const candlesRaw = market.data?.candles ?? [];
  const chartData = (market.data?.bands ?? []).map((b, i) => {
    const c = candlesRaw[i];
    return {
      ...b,
      open: c?.open ?? b.close,
      high: c?.high ?? b.close,
      low: c?.low ?? b.close,
      candle: [c?.low ?? b.close, c?.high ?? b.close] as [number, number],
      bullish: (c?.close ?? b.close) >= (c?.open ?? b.close),
      label: new Date(b.time).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    };
  });

  const credentialsMissing = market.data ? !market.data.credentials : false;
  const positions = account.data?.positions ?? [];
  const balance = account.data?.balance ?? null;
  const guard = risk.data?.guard ?? null;
  const riskBlocked = guard?.blocked ?? false;

  const riskAmount = balance ? (balance.equity * config.riskPerTradePct) / 100 : null;
  const estimatedQty =
    config.useRiskSizing && riskAmount && analysis?.price && config.stopLossPct > 0
      ? riskAmount / (analysis.price * (config.stopLossPct / 100))
      : config.quantity;

  const sideColor =
    analysis?.side === "LONG" ? "text-long" : analysis?.side === "SHORT" ? "text-short" : "text-muted-foreground";

  const update = <K extends keyof BotConfig>(key: K, value: BotConfig[K]) =>
    setConfig((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "maxLeverage" || key === "leverage") {
        next.maxLeverage = Math.max(1, Math.min(125, Math.floor(next.maxLeverage || 1)));
        next.leverage = Math.max(1, Math.min(next.maxLeverage, Math.floor(next.leverage || 1)));
      }
      return next;
    });


  return (
    <div className="min-h-screen">
      <Toaster />
      <header className="border-b border-border/70 bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Robô Scalping <span className="text-primary">BingX</span>
            </h1>
            <p className="text-xs text-muted-foreground">
              Futuros perpétuos · Bollinger {config.bbPeriod}/{config.bbMultiplier} + filtro de volume
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="stat-label">Preço {config.symbol}</p>
              <p className="mono text-lg font-semibold">{fmt(analysis?.price)}</p>
            </div>
            <button
              onClick={() => setRunning((v) => !v)}
              disabled={!running && riskBlocked}
              title={!running && riskBlocked ? "Limite de perda diária atingido" : undefined}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                running
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              {running ? "Parar robô" : "Ligar robô"}
            </button>

          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-5">
        {credentialsMissing && (
          <div className="panel border-warning/40 bg-warning/10 p-4 text-sm">
            <p className="font-medium text-warning">Chaves da BingX ainda não configuradas</p>
            <p className="mt-1 text-muted-foreground">
              Os sinais e o gráfico já funcionam com dados públicos, mas o envio de ordens exige a API Key e a
              API Secret da BingX com permissão de Futuros Perpétuos.
            </p>
          </div>
        )}

        {riskBlocked && (
          <div className="panel border-destructive/50 bg-destructive/10 p-4 text-sm">
            <p className="font-medium text-short">Limite de perda diária atingido</p>
            <p className="mt-1 text-muted-foreground">
              PnL de hoje: {fmt(guard?.dailyPnl)} · limite: -{fmt(guard?.lossLimit)} ({config.maxDailyLossPct}%
              do patrimônio). Novas entradas estão bloqueadas até 00:00 UTC.
            </p>
          </div>
        )}

        <div className="panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Gestão de risco</h2>
            <span className={`text-[11px] ${riskBlocked ? "text-short" : "text-long"}`}>
              {risk.data?.credentials === false
                ? "○ sem chaves"
                : riskBlocked
                  ? "● bloqueado hoje"
                  : "● dentro do limite"}
            </span>
          </div>

          <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
            <label className="block">
              <span className="stat-label">Risco por trade (% do patrimônio)</span>
              <input
                type="number"
                step={0.1}
                min={0}
                max={100}
                value={config.riskPerTradePct}
                onChange={(e) => update("riskPerTradePct", Number(e.target.value))}
                className="mono mt-1 w-full rounded-md border border-input bg-surface px-2 py-1.5 text-sm outline-none focus:border-ring"
              />
            </label>
            <label className="block">
              <span className="stat-label">Perda diária máxima (%)</span>
              <input
                type="number"
                step={0.5}
                min={0}
                max={100}
                value={config.maxDailyLossPct}
                onChange={(e) => update("maxDailyLossPct", Number(e.target.value))}
                className="mono mt-1 w-full rounded-md border border-input bg-surface px-2 py-1.5 text-sm outline-none focus:border-ring"
              />
            </label>
            <label className="block">
              <span className="stat-label">Alavancagem máxima (x)</span>
              <input
                type="number"
                step={1}
                min={1}
                max={125}
                value={config.maxLeverage}
                onChange={(e) => update("maxLeverage", Number(e.target.value))}
                className="mono mt-1 w-full rounded-md border border-input bg-surface px-2 py-1.5 text-sm outline-none focus:border-ring"
              />
            </label>
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={config.useRiskSizing}
              onChange={(e) => update("useRiskSizing", e.target.checked)}
              className="size-4 accent-[var(--color-primary)]"
            />
            <span>Calcular quantidade pelo risco (em vez de quantidade fixa)</span>
          </label>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div>
              <dt className="stat-label">Risco por trade</dt>
              <dd className="mono">{riskAmount === null ? "—" : `${fmt(riskAmount)} USDT`}</dd>
            </div>
            <div>
              <dt className="stat-label">Qtd. estimada</dt>
              <dd className="mono">{fmt(estimatedQty, 4)}</dd>
            </div>
            <div>
              <dt className="stat-label">PnL de hoje</dt>
              <dd className={`mono ${(guard?.dailyPnl ?? 0) >= 0 ? "text-long" : "text-short"}`}>
                {fmt(guard?.dailyPnl)}
              </dd>
            </div>
            <div>
              <dt className="stat-label">Limite diário</dt>
              <dd className="mono">{guard ? `-${fmt(guard.lossLimit)}` : "—"}</dd>
            </div>
          </dl>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full transition-all ${riskBlocked ? "bg-destructive" : "bg-warning"}`}
              style={{ width: `${Math.min(100, Math.max(0, guard?.lossPct ?? 0))}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Consumo do limite de perda diária: {fmt(Math.min(100, guard?.lossPct ?? 0), 0)}% · alavancagem
            efetiva limitada a {config.maxLeverage}x.
          </p>
        </div>



        <section className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Bandas de Bollinger &amp; volume</h2>
              <div className="flex gap-2">
                <select
                  value={config.symbol}
                  onChange={(e) => update("symbol", e.target.value)}
                  className="mono rounded-md border border-input bg-surface px-2 py-1 text-xs"
                >
                  {SYMBOLS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  value={config.interval}
                  onChange={(e) => update("interval", e.target.value)}
                  className="mono rounded-md border border-input bg-surface px-2 py-1 text-xs"
                >
                  {INTERVALS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <CartesianGrid stroke="var(--color-grid)" strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }} minTickGap={40} />
                  <YAxis
                    domain={["dataMin - 20", "dataMax + 20"]}
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                    width={62}
                    tickFormatter={(v: number) => fmt(v, 0)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-popover)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v) => fmt(Number(v))}
                  />
                  <Area type="monotone" dataKey="upper" stroke="var(--color-chart-1)" fill="var(--color-chart-1)" fillOpacity={0.06} strokeWidth={1} dot={false} />
                  <Area type="monotone" dataKey="lower" stroke="var(--color-chart-1)" fill="var(--color-background)" fillOpacity={0.4} strokeWidth={1} dot={false} />
                  <Line type="monotone" dataKey="basis" stroke="var(--color-muted-foreground)" strokeDasharray="4 4" strokeWidth={1} dot={false} />
                  <Bar dataKey="candle" shape={<CandleShape />} isAnimationActive={false} barSize={8} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-2 h-20">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData}>
                  <XAxis dataKey="label" hide />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-popover)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="volume" fillOpacity={0.55} isAnimationActive={false}>
                    {chartData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={d.bullish ? "var(--color-chart-2)" : "var(--color-destructive)"}
                      />
                    ))}
                  </Bar>

                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="space-y-4">
            <div className="panel p-4">
              <p className="stat-label">Sinal atual</p>
              <p className={`mono mt-1 text-3xl font-bold ${sideColor}`}>{analysis?.side ?? "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">{analysis?.reason ?? "Carregando mercado..."}</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${analysis?.confidence ?? 0}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Confiança {analysis?.confidence ?? 0}%
              </p>

              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <dt className="stat-label">Banda sup.</dt>
                  <dd className="mono">{fmt(analysis?.upper)}</dd>
                </div>
                <div>
                  <dt className="stat-label">Banda inf.</dt>
                  <dd className="mono">{fmt(analysis?.lower)}</dd>
                </div>
                <div>
                  <dt className="stat-label">Volume x média</dt>
                  <dd className="mono">{fmt(analysis?.volumeRatio)}x</dd>
                </div>
                <div>
                  <dt className="stat-label">RSI 14</dt>
                  <dd className="mono">{fmt(analysis?.rsi, 1)}</dd>
                </div>
                <div>
                  <dt className="stat-label">%B</dt>
                  <dd className="mono">{fmt(analysis?.percentB, 1)}%</dd>
                </div>
                <div>
                  <dt className="stat-label">Largura</dt>
                  <dd className="mono">{fmt(analysis?.bandwidth, 2)}%</dd>
                </div>
              </dl>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  onClick={() => manualOrder.mutate("LONG")}
                  disabled={manualOrder.isPending || !analysis || riskBlocked}
                  className="rounded-md bg-long/15 px-3 py-2 text-xs font-semibold text-long transition-colors hover:bg-long/25 disabled:opacity-50"
                >
                  Comprar (LONG)
                </button>
                <button
                  onClick={() => manualOrder.mutate("SHORT")}
                  disabled={manualOrder.isPending || !analysis || riskBlocked}
                  className="rounded-md bg-short/15 px-3 py-2 text-xs font-semibold text-short transition-colors hover:bg-short/25 disabled:opacity-50"
                >
                  Vender (SHORT)
                </button>
              </div>
            </div>

            <div className="panel p-4">
              <p className="stat-label">Conta de futuros</p>
              {balance ? (
                <div className="mt-2 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="stat-label">Patrimônio</p>
                    <p className="mono text-base">{fmt(balance.equity)} {balance.asset}</p>
                  </div>
                  <div>
                    <p className="stat-label">Margem livre</p>
                    <p className="mono text-base">{fmt(balance.availableMargin)}</p>
                  </div>
                  <div className="col-span-2">
                    <p className="stat-label">PnL não realizado</p>
                    <p className={`mono text-base ${balance.unrealizedProfit >= 0 ? "text-long" : "text-short"}`}>
                      {fmt(balance.unrealizedProfit)} {balance.asset}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Conecte as chaves da BingX para ver saldo e posições.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div className="panel p-4">
            <h2 className="text-sm font-semibold">Parâmetros do robô</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              {(
                [
                  ["quantity", "Quantidade (contratos)", 0.0001],
                  ["leverage", "Alavancagem (x)", 1],
                  ["takeProfitPct", "Take profit (%)", 0.05],
                  ["stopLossPct", "Stop loss (%)", 0.05],
                  ["bbPeriod", "Período Bollinger", 1],
                  ["bbMultiplier", "Desvios padrão", 0.1],
                  ["volumeThreshold", "Volume mínimo (x média)", 0.1],
                  ["volumePeriod", "Período do volume", 1],
                  ["rsiLongMax", "RSI máx. para LONG", 1],
                  ["rsiShortMin", "RSI mín. para SHORT", 1],
                ] as const
              ).map(([key, label, step]) => (
                <label key={key} className="block">
                  <span className="stat-label">{label}</span>
                  <input
                    type="number"
                    step={step}
                    value={config[key]}
                    onChange={(e) => update(key, Number(e.target.value) as never)}
                    className="mono mt-1 w-full rounded-md border border-input bg-surface px-2 py-1.5 text-sm outline-none focus:border-ring"
                  />
                </label>
              ))}
              <label className="col-span-2 flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  checked={config.allowShort}
                  onChange={(e) => update("allowShort", e.target.checked)}
                  className="size-4 accent-[var(--color-primary)]"
                />
                <span>Permitir operações de venda (short)</span>
              </label>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              O robô avalia o mercado a cada 15s e abre no máximo uma posição por símbolo, sempre com TP e SL
              anexados à ordem.
            </p>
          </div>

          <div className="space-y-4">
            <div className="panel p-4">
              <h2 className="text-sm font-semibold">Posições abertas</h2>
              {positions.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">Nenhuma posição aberta.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {positions.map((p) => (
                    <li key={p.positionId} className="flex items-center justify-between rounded-md bg-surface px-3 py-2 text-xs">
                      <div>
                        <p className={`mono font-semibold ${p.positionSide === "LONG" ? "text-long" : "text-short"}`}>
                          {p.positionSide} {p.symbol}
                        </p>
                        <p className="text-muted-foreground">
                          {fmt(Math.abs(p.positionAmt), 4)} @ {fmt(p.avgPrice)} · {p.leverage}x
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`mono ${p.unrealizedProfit >= 0 ? "text-long" : "text-short"}`}>
                          {fmt(p.unrealizedProfit)}
                        </span>
                        <button
                          onClick={() =>
                            close.mutate({ positionSide: p.positionSide, quantity: Math.abs(p.positionAmt) })
                          }
                          disabled={close.isPending}
                          className="rounded-md border border-input px-2 py-1 text-[11px] transition-colors hover:bg-secondary disabled:opacity-50"
                        >
                          Fechar
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="panel p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Registro do robô</h2>
                <span className={`text-[11px] ${running ? "text-long" : "text-muted-foreground"}`}>
                  {running ? "● operando" : "○ parado"}
                </span>
              </div>
              <ul className="mono mt-2 max-h-56 space-y-1 overflow-auto text-[11px]">
                {log.length === 0 && <li className="text-muted-foreground">Sem eventos ainda.</li>}
                {log.map((entry) => (
                  <li
                    key={entry.at + entry.text}
                    className={
                      entry.kind === "trade"
                        ? "text-long"
                        : entry.kind === "error"
                          ? "text-short"
                          : "text-muted-foreground"
                    }
                  >
                    [{new Date(entry.at).toLocaleTimeString("pt-BR")}] {entry.text}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <p className="pb-6 text-center text-[11px] text-muted-foreground">
          Ferramenta educacional. Scalping alavancado em futuros perpétuos tem risco elevado de perda total do
          capital — teste com valores mínimos antes de aumentar a exposição.
        </p>
      </main>
    </div>
  );
}
