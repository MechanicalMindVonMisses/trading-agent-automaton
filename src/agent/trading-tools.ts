/**
 * Mock Crypto Trading Tools (sim mode)
 *
 * Paper-trading loop for the simulation agent: live prices from the free
 * CoinGecko API, a fake-USD portfolio ledger on disk, and buy/sell tools
 * that trade at the live price. No real money is ever involved — the
 * ledger is a plain JSON file, entirely separate from sim-ledger.json
 * (which tracks inference cost).
 */

import fs from "node:fs";
import nodePath from "node:path";
import type { AutomatonTool } from "../types.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("trading");

// ─── Universe ──────────────────────────────────────────────────

/** Tradeable coins: ticker symbol → CoinGecko id. */
const COINS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
};

const SYMBOLS = Object.keys(COINS);
const INITIAL_CAPITAL_USD = 10_000;
const MIN_TRADE_USD = 10;

// ─── Sell Discipline ───────────────────────────────────────────
// The agent tends to buy-and-accumulate forever and never take profit or cut
// losses. These thresholds turn portfolio_status into an explicit sell-signal
// feed, and buy_crypto enforces a cash reserve + per-coin concentration cap so
// the agent cannot deploy everything into one endless long.
// Thresholds are deliberately tight. At +5%/-4% the agent ran for a full day
// without a single signal firing — BTC/ETH simply never moved that far — so the
// sell discipline was never exercised and we learned nothing about whether the
// model obeys it. At +-2% signals fire on ordinary intraday moves, which is the
// point: this is a behavioural experiment, not a strategy tuned for returns.
// Exit levels are now declared per position by the agent at entry; these are
// only the fallback for positions opened before that was required, and the
// bounds a declaration has to sit inside.
const DEFAULT_TAKE_PROFIT_PCT = 2;
const DEFAULT_STOP_LOSS_PCT = 2;
const MIN_EXIT_PCT = 0.5; // a level tighter than this is noise, not a thesis
const MAX_EXIT_PCT = 50; // a level looser than this is not a level at all
const MIN_CASH_RESERVE_PCT = 20; // never let an entry push cash below this % of equity
const MAX_POSITION_PCT = 45; // no single coin may exceed this % of equity (either side)
const NO_AVERAGE_DOWN_PCT = 1; // block adding to a position already down more than this %

// ─── Portfolio Ledger ──────────────────────────────────────────

interface Position {
  /** long = own the coin; short = borrowed and sold it, profits when price falls. */
  side: "long" | "short";
  /** Coin units, always positive; `side` carries the direction. */
  amount: number;
  /** Average entry price per unit in USD. */
  avgCostUsd: number;
  /**
   * Cash set aside to back a short at 100% margin (no leverage). Longs hold 0:
   * their cash already went into the coin.
   */
  collateralUsd: number;
  /** The exit levels the agent committed to when it opened the position. */
  takeProfitPct: number;
  stopLossPct: number;
  /** True when levels came from migration rather than the agent's own call. */
  levelsInherited?: boolean;
}

interface TradeRecord {
  time: string;
  /** buy/sell open and close longs; short/cover open and close shorts. */
  side: "buy" | "sell" | "short" | "cover";
  symbol: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
  reason: string;
  /**
   * The checked label the agent put on a close: take_profit, stop_loss,
   * thesis_change or risk (closing trades only). Recorded so the mix can be
   * read back — a run that is all thesis_change at a loss reads very
   * differently from one that is all take_profit.
   */
  exitType?: string;
  /** Realized profit/loss vs average entry (closing trades only). */
  realizedPnlUsd?: number;
}

interface Portfolio {
  version: 1;
  createdAt: string;
  initialCapitalUsd: number;
  cashUsd: number;
  positions: Record<string, Position>;
  trades: TradeRecord[];
}

function portfolioPath(): string {
  return nodePath.join(getAutomatonDir(), "portfolio.json");
}

/**
 * Bring a position written by an older build up to the current shape: it had no
 * side (everything was a long), no collateral, and no declared exit levels
 * because the thresholds were global constants. Such positions inherit the
 * defaults and are flagged, so the agent is told they are not its own numbers
 * and gets asked to set them on the first decision turn.
 */
function migratePosition(raw: Partial<Position>): Position {
  return {
    side: raw.side ?? "long",
    amount: raw.amount ?? 0,
    avgCostUsd: raw.avgCostUsd ?? 0,
    collateralUsd: raw.collateralUsd ?? 0,
    takeProfitPct: raw.takeProfitPct ?? DEFAULT_TAKE_PROFIT_PCT,
    stopLossPct: raw.stopLossPct ?? DEFAULT_STOP_LOSS_PCT,
    levelsInherited:
      raw.takeProfitPct === undefined || raw.stopLossPct === undefined
        ? true
        : raw.levelsInherited,
  };
}

function loadPortfolio(): Portfolio {
  const file = portfolioPath();
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Portfolio;
    for (const symbol of Object.keys(parsed.positions ?? {})) {
      parsed.positions[symbol] = migratePosition(parsed.positions[symbol]);
    }
    return parsed;
  }
  const fresh: Portfolio = {
    version: 1,
    createdAt: new Date().toISOString(),
    initialCapitalUsd: INITIAL_CAPITAL_USD,
    cashUsd: INITIAL_CAPITAL_USD,
    positions: {},
    trades: [],
  };
  savePortfolio(fresh);
  return fresh;
}

// ─── Position Maths ────────────────────────────────────────────
// One definition of P&L, equity and exposure, direction-aware, so a short is
// never accidentally valued like a long.

/** Unrealized P&L for a position at `price`, signed by direction. */
function positionPnl(
  pos: Position,
  price: number,
): { pnlUsd: number; pnlPct: number } {
  const dir = pos.side === "long" ? 1 : -1;
  const pnlUsd = (price - pos.avgCostUsd) * pos.amount * dir;
  const pnlPct =
    pos.avgCostUsd > 0 ? (price / pos.avgCostUsd - 1) * 100 * dir : 0;
  return { pnlUsd, pnlPct };
}

/** What a position contributes to equity: coin value, or collateral +/- P&L. */
function positionEquity(pos: Position, price: number): number {
  return pos.side === "long"
    ? pos.amount * price
    : pos.collateralUsd + positionPnl(pos, price).pnlUsd;
}

/** Absolute market exposure to a coin, regardless of direction. */
function positionExposure(pos: Position, price: number): number {
  return pos.amount * price;
}

function computeEquity(
  portfolio: Portfolio,
  quotes: Record<string, PriceQuote>,
): number {
  let equity = portfolio.cashUsd;
  for (const [symbol, pos] of Object.entries(portfolio.positions)) {
    equity += positionEquity(pos, quotes[symbol]?.usd ?? pos.avgCostUsd);
  }
  return equity;
}

/**
 * Describe the last time this symbol was closed, for the refusal message when
 * the agent tries to close it again.
 *
 * It did exactly that four turns running: after selling ETH on its stop it
 * called sell_crypto three more times, each with the signal's numbers rather
 * than the fill's, and the loop detector's "stop repeating yourself" injection
 * did not break it. "No ETH position to sell" says what is missing but not why,
 * so the intent that produced the call still looks unfinished. Telling it what
 * it already did, at the moment it tries to redo it, puts the fact where the
 * decision is being made instead of in a journal it is not consulting.
 */
function describeRecentClose(
  portfolio: Portfolio,
  symbol: string,
): string | null {
  const close = [...portfolio.trades]
    .reverse()
    .find(
      (t) =>
        t.symbol === symbol && (t.side === "sell" || t.side === "cover"),
    );
  if (!close) return null;

  const minutesAgo = Math.max(
    0,
    Math.round((Date.now() - new Date(close.time).getTime()) / 60_000),
  );
  const when =
    minutesAgo < 90
      ? `${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`
      : `at ${close.time.slice(11, 16)} UTC`;
  const verb = close.side === "sell" ? "sold" : "covered";
  const pnl = close.realizedPnlUsd;
  const pnlNote =
    pnl === undefined
      ? ""
      : `, realizing ${pnl >= 0 ? "+" : "-"}$${fmtUsd(Math.abs(pnl))}`;

  return (
    `You already closed this position ${when}: ${verb} ${fmtAmount(close.amount)} ${symbol} ` +
    `@ $${fmtUsd(close.priceUsd)}${pnlNote}. That trade is done — the level you are reacting to ` +
    `has already been acted on. Stop re-closing it and pick your next move.`
  );
}

/** Reject a declared exit level that is missing or outside sane bounds. */
function validateExitLevel(value: unknown, label: string): string | null {
  const pct = Number(value);
  if (!Number.isFinite(pct)) {
    return `Refused: ${label} is required — state the percentage move at which you will exit.`;
  }
  if (pct < MIN_EXIT_PCT || pct > MAX_EXIT_PCT) {
    return `Refused: ${label} of ${pct}% is outside the allowed ${MIN_EXIT_PCT}-${MAX_EXIT_PCT}% range.`;
  }
  return null;
}

function savePortfolio(portfolio: Portfolio): void {
  const file = portfolioPath();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(portfolio, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// ─── Trade Journal (WORKLOG.md) ────────────────────────────────
// The prompt tells the agent to journal with write_file, but write_file
// resolves paths against the sandbox root ("/root") while the prompt loads the
// journal from the automaton state dir — so anything it wrote could never be
// read back. In ~800 turns it never called write_file once anyway. Trades are
// appended here instead, to the exact path the prompt reads, so the agent's own
// stated reasons come back to it on the next turn.
//
// The loader injects the whole file with no truncation, so the journal is
// trimmed to the most recent entries to keep it (and the token bill) bounded.
const WORKLOG_MAX_ENTRIES = 30;

function appendWorklog(entry: string): void {
  try {
    const file = nodePath.join(getAutomatonDir(), "WORKLOG.md");
    const header = `# Trade Journal

Appended automatically on every executed trade.

`;
    const existing = fs.existsSync(file)
      ? fs.readFileSync(file, "utf-8")
      : header;
    const entries = existing
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "));
    entries.push(entry);
    const kept = entries.slice(-WORKLOG_MAX_ENTRIES);
    fs.writeFileSync(file, header + kept.join("\n") + "\n", "utf-8");
  } catch (err) {
    logger.error(
      "WORKLOG append failed",
      err instanceof Error ? err : undefined,
    );
  }
}

// ─── Sell Signals ──────────────────────────────────────────────
// Shared by portfolio_status (which reports them) and the loop (which uses
// them to force a decision turn). Keeping one definition means the agent can
// never be forced to decide about a signal it was not also shown.

export interface SellSignal {
  symbol: string;
  side: "long" | "short";
  kind: "TAKE PROFIT" | "STOP LOSS";
  pnlPct: number;
  pnlUsd: number;
  /** The level the agent itself declared, which this move has now crossed. */
  levelPct: number;
  inherited: boolean;
}

/**
 * Fires against the position's OWN declared levels, not a global constant.
 * The point is not that 2% is meaningful — it is that the agent said it would
 * exit here, and is now at that price.
 */
function signalFor(
  symbol: string,
  pos: Position,
  pnlPct: number,
  pnlUsd: number,
): SellSignal | null {
  const base = {
    symbol,
    side: pos.side,
    pnlPct,
    pnlUsd,
    inherited: pos.levelsInherited === true,
  };
  if (pnlPct >= pos.takeProfitPct) {
    return {
      ...base,
      kind: "TAKE PROFIT" as const,
      levelPct: pos.takeProfitPct,
    };
  }
  if (pnlPct <= -pos.stopLossPct) {
    return { ...base, kind: "STOP LOSS" as const, levelPct: pos.stopLossPct };
  }
  return null;
}

/**
 * Sell signals currently firing, at live prices. Returns an empty list on any
 * failure (no positions, price feed down) so a network blip can never trap the
 * agent in a forced decision it has no data for.
 */
export async function getActiveSellSignals(): Promise<SellSignal[]> {
  try {
    const quotes = await fetchQuotes();
    const portfolio = enforceLiquidations(loadPortfolio(), quotes);
    const signals: SellSignal[] = [];
    for (const symbol of Object.keys(portfolio.positions)) {
      const pos = portfolio.positions[symbol];
      const price = quotes[symbol]?.usd;
      if (price === undefined || pos.avgCostUsd <= 0) continue;
      const { pnlUsd, pnlPct } = positionPnl(pos, price);
      const signal = signalFor(symbol, pos, pnlPct, pnlUsd);
      if (signal) signals.push(signal);
    }
    return signals;
  } catch (err) {
    logger.error(
      "Sell-signal check failed",
      err instanceof Error ? err : undefined,
    );
    return [];
  }
}

/** One line per signal, as shown to the agent. */
export function formatSellSignal(s: SellSignal): string {
  const sign = s.pnlUsd >= 0 ? "+" : "-";
  const dir = s.pnlUsd >= 0 ? "up" : "down";
  const level =
    s.kind === "TAKE PROFIT"
      ? `your +${s.levelPct}% take-profit`
      : `your -${s.levelPct}% stop-loss`;
  return (
    `${s.kind} — ${s.side.toUpperCase()} ${s.symbol} is ${dir} ` +
    `${Math.abs(s.pnlPct).toFixed(2)}% (${sign}$${fmtUsd(Math.abs(s.pnlUsd))}), crossing ${level}` +
    `${s.inherited ? " (inherited level — you never set one for this position)" : ""}.`
  );
}

/**
 * Margin liquidation for shorts. A short's loss is unbounded while its backing
 * is not: at 100% margin the collateral is gone once the price doubles. A real
 * venue closes the position there, so this does too, before equity can go
 * negative. This is exchange mechanics, not a trading decision — the agent is
 * never consulted, and it is journaled so the loss is not silent.
 */
function enforceLiquidations(
  portfolio: Portfolio,
  quotes: Record<string, PriceQuote>,
): Portfolio {
  let changed = false;
  for (const symbol of Object.keys(portfolio.positions)) {
    const pos = portfolio.positions[symbol];
    if (pos.side !== "short") continue;
    const price = quotes[symbol]?.usd;
    if (price === undefined) continue;
    const { pnlUsd } = positionPnl(pos, price);
    if (pnlUsd > -pos.collateralUsd) continue;

    portfolio.trades.push({
      time: new Date().toISOString(),
      side: "cover",
      symbol,
      amount: pos.amount,
      priceUsd: price,
      valueUsd: pos.amount * price,
      reason: "LIQUIDATED — short loss reached posted collateral",
      realizedPnlUsd: -pos.collateralUsd,
    });
    delete portfolio.positions[symbol];
    changed = true;
    logger.info(`LIQUIDATED short ${symbol} @ $${fmtUsd(price)}`);
    appendWorklog(
      `- ${new Date().toISOString()} **LIQUIDATED SHORT ${symbol}** @ $${fmtUsd(price)}, ` +
        `collateral $${fmtUsd(pos.collateralUsd)} wiped — the price moved against you far enough to consume the margin.`,
    );
  }
  if (changed) savePortfolio(portfolio);
  return portfolio;
}

// ─── Price Feed (CoinGecko) ────────────────────────────────────

interface PriceQuote {
  usd: number;
  change24hPct: number;
  volume24hUsd: number;
}

const PRICE_CACHE_TTL_MS = 60_000;
let priceCache: { at: number; quotes: Record<string, PriceQuote> } | null =
  null;

/** Fetch live quotes for all supported coins, cached for 60s. */
async function fetchQuotes(): Promise<Record<string, PriceQuote>> {
  if (priceCache && Date.now() - priceCache.at < PRICE_CACHE_TTL_MS) {
    return priceCache.quotes;
  }

  const ids = Object.values(COINS).join(",");
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
    `&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`CoinGecko HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Record<
    string,
    { usd: number; usd_24h_change?: number; usd_24h_vol?: number }
  >;

  const quotes: Record<string, PriceQuote> = {};
  for (const [symbol, id] of Object.entries(COINS)) {
    const entry = data[id];
    if (!entry || typeof entry.usd !== "number") {
      throw new Error(`CoinGecko response missing price for ${id}`);
    }
    quotes[symbol] = {
      usd: entry.usd,
      change24hPct: entry.usd_24h_change ?? 0,
      volume24hUsd: entry.usd_24h_vol ?? 0,
    };
  }

  priceCache = { at: Date.now(), quotes };
  return quotes;
}

// ─── Formatting ────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtAmount(n: number): string {
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}%`;
}

/**
 * The labels an agent may put on a close, two of which the numbers can settle.
 *
 * Closing used to take a free-text `reason` alone, which made the stated
 * trigger unfalsifiable — and the agent duly stated triggers that had not
 * happened. It sold BTC at -1.13% calling it "reached the predefined
 * take-profit level of 10%", then ETH at -0.04% calling it "hit take-profit
 * target of 15%". Both sales may well have been sensible; the stated grounds
 * were arithmetic claims about the position, and both were false. Prose cannot
 * be checked, so the model could produce the form of a disciplined
 * rule-follower over invented numbers.
 *
 * A label from a fixed set can be checked. take_profit and stop_loss assert
 * that a declared level was reached, which the position either supports or
 * does not. thesis_change and risk assert a judgement, which only the agent
 * can make and which no P&L can contradict — so they are accepted at any
 * number, including a deep loss.
 *
 * The check refuses the label, never the trade: every exit stays available on
 * the next call, and closing a loser is always one honest word away. What is
 * no longer available is calling a loss a win.
 */
export const EXIT_TYPES = ["take_profit", "stop_loss", "thesis_change", "risk"] as const;

/** Reject an exit label the position contradicts. Returns null when it holds. */
export function checkExitClaim(
  symbol: string,
  pos: Position,
  pnlPct: number,
  rawExitType: unknown,
): string | null {
  const exitType = String(rawExitType ?? "").trim().toLowerCase();
  if (!(EXIT_TYPES as readonly string[]).includes(exitType)) {
    return (
      `exit_type must be one of: ${EXIT_TYPES.join(", ")}. ` +
      `take_profit and stop_loss are claims about your declared levels and are checked ` +
      `against the position; thesis_change and risk are your judgement and are always accepted.`
    );
  }

  const inherited = pos.levelsInherited ? " (inherited, not yours)" : "";

  if (exitType === "take_profit" && pnlPct < pos.takeProfitPct) {
    return (
      `You labelled this take_profit, but ${symbol} is at ${fmtPct(pnlPct)} and your ` +
      `take-profit is +${pos.takeProfitPct}%${inherited}. That level has not been reached, ` +
      `so this close is not a take-profit.\n` +
      `You can still close it right now — label what it actually is: thesis_change if the ` +
      `reason you opened it no longer holds, risk if this is about sizing rather than a view ` +
      `on ${symbol}, or stop_loss once it is at or past -${pos.stopLossPct}%. ` +
      `The number is checked; the judgement stays yours.`
    );
  }

  if (exitType === "stop_loss" && pnlPct > -pos.stopLossPct) {
    return (
      `You labelled this stop_loss, but ${symbol} is at ${fmtPct(pnlPct)} and your ` +
      `stop-loss is -${pos.stopLossPct}%${inherited}. That level has not been reached, ` +
      `so this close is not a stop-loss.\n` +
      `You can still close it right now — label what it actually is: thesis_change if the ` +
      `reason you opened it no longer holds, or risk if this is about sizing rather than a ` +
      `view on ${symbol}. The number is checked; the judgement stays yours.`
    );
  }

  return null;
}

function normalizeSymbol(raw: unknown): string | { error: string } {
  const symbol = String(raw ?? "").trim().toUpperCase();
  if (!COINS[symbol]) {
    return {
      error: `Unknown coin "${raw}". Supported: ${SYMBOLS.join(", ")}`,
    };
  }
  return symbol;
}

// ─── Tools ─────────────────────────────────────────────────────

export function createTradingTools(): AutomatonTool[] {
  return [
    {
      name: "get_crypto_price",
      description:
        "Get live crypto prices (USD), 24h change and 24h volume from CoinGecko " +
        `for the coins you can trade: ${SYMBOLS.join(", ")}. ` +
        "Prices are cached for 60 seconds.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        const quotes = await fetchQuotes();
        const lines = SYMBOLS.map((s) => {
          const q = quotes[s];
          const arrow = q.change24hPct >= 0 ? "+" : "";
          return `${s}: $${fmtUsd(q.usd)} (24h: ${arrow}${q.change24hPct.toFixed(2)}%, vol: $${fmtUsd(q.volume24hUsd)})`;
        });
        return lines.join("\n");
      },
    },
    {
      name: "buy_crypto",
      description:
        "Buy crypto with fake USD at the live market price (paper trading, no real money). " +
        `Coins: ${SYMBOLS.join(", ")}. Always state your trading thesis in "reason".`,
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: `Coin to buy: ${SYMBOLS.join(", ")}`,
          },
          usd_amount: {
            type: "number",
            description: `USD amount to spend (min $${MIN_TRADE_USD})`,
          },
          reason: {
            type: "string",
            description: "Your trading thesis: why this is a buy right now",
          },
          take_profit_pct: {
            type: "number",
            description: `Percent gain at which you commit to selling (${MIN_EXIT_PCT}-${MAX_EXIT_PCT})`,
          },
          stop_loss_pct: {
            type: "number",
            description: `Percent loss at which you commit to cutting it (${MIN_EXIT_PCT}-${MAX_EXIT_PCT})`,
          },
        },
        required: [
          "symbol",
          "usd_amount",
          "reason",
          "take_profit_pct",
          "stop_loss_pct",
        ],
      },
      execute: async (args) => {
        const symbol = normalizeSymbol(args.symbol);
        if (typeof symbol === "object") return symbol.error;
        const usdAmount = Number(args.usd_amount);
        if (!Number.isFinite(usdAmount) || usdAmount < MIN_TRADE_USD) {
          return `Invalid usd_amount: minimum trade is $${MIN_TRADE_USD}.`;
        }
        // Levels are declared, not inherited: the agent names the price at
        // which it will act, and the decision turn later holds it to that.
        const tpError = validateExitLevel(args.take_profit_pct, "take_profit_pct");
        if (tpError) return tpError;
        const slError = validateExitLevel(args.stop_loss_pct, "stop_loss_pct");
        if (slError) return slError;
        const takeProfitPct = Number(args.take_profit_pct);
        const stopLossPct = Number(args.stop_loss_pct);

        const portfolio = loadPortfolio();
        if (usdAmount > portfolio.cashUsd) {
          return `Insufficient cash: you have $${fmtUsd(portfolio.cashUsd)}, tried to spend $${fmtUsd(usdAmount)}.`;
        }

        const quotes = await fetchQuotes();
        const price = quotes[symbol].usd;
        const amount = usdAmount / price;

        const existing = portfolio.positions[symbol];
        if (existing && existing.side === "short") {
          return (
            `Blocked: you are SHORT ${symbol}. Buying it now would be betting both ways on the same coin. ` +
            `Close the short with close_short first if your view has flipped.`
          );
        }

        // No averaging down: refuse to add to a position that is already
        // underwater beyond a small dip. Throwing more money at a loser keeps
        // its %P&L near zero and dodges the stop-loss forever. Force the
        // position to resolve (recover into take-profit, or hit stop-loss).
        if (existing && existing.avgCostUsd > 0) {
          const posPnlPct = positionPnl(existing, price).pnlPct;
          if (posPnlPct < -NO_AVERAGE_DOWN_PCT) {
            return (
              `Blocked: ${symbol} is already down ${Math.abs(posPnlPct).toFixed(2)}% on your position — do NOT average down into a loser. ` +
              `Either hold and wait for it to recover toward take-profit, or cut it with sell_crypto if the thesis is broken. Adding more only digs the hole deeper.`
            );
          }
        }

        // Sell-discipline guards: keep a cash reserve and cap concentration so
        // the agent can't deploy everything into one endless accumulation.
        const equityUsd = computeEquity(portfolio, quotes);
        const cashAfter = portfolio.cashUsd - usdAmount;
        const reserveFloor = (equityUsd * MIN_CASH_RESERVE_PCT) / 100;
        if (cashAfter < reserveFloor) {
          return (
            `Blocked: this buy would drop cash to $${fmtUsd(cashAfter)}, below your ${MIN_CASH_RESERVE_PCT}% reserve ($${fmtUsd(reserveFloor)}). ` +
            `You are over-invested — take profit or cut a losing position (sell_crypto) before buying more. Check portfolio_status for SELL signals.`
          );
        }
        const posValueAfter =
          (portfolio.positions[symbol]?.amount ?? 0) * price + usdAmount;
        const concentrationCap = (equityUsd * MAX_POSITION_PCT) / 100;
        if (posValueAfter > concentrationCap) {
          return (
            `Blocked: this buy would make ${symbol} worth $${fmtUsd(posValueAfter)}, over your ${MAX_POSITION_PCT}% single-coin cap ($${fmtUsd(concentrationCap)}). ` +
            `Diversify into another coin or trim ${symbol} first — do not pile everything into one position.`
          );
        }

        const pos = portfolio.positions[symbol];
        if (pos) {
          const totalCost = pos.avgCostUsd * pos.amount + usdAmount;
          pos.amount += amount;
          pos.avgCostUsd = totalCost / pos.amount;
          // Adding to a position re-states the plan for the whole thing.
          pos.takeProfitPct = takeProfitPct;
          pos.stopLossPct = stopLossPct;
          pos.levelsInherited = false;
        } else {
          portfolio.positions[symbol] = {
            side: "long",
            amount,
            avgCostUsd: price,
            collateralUsd: 0,
            takeProfitPct,
            stopLossPct,
            levelsInherited: false,
          };
        }
        portfolio.cashUsd -= usdAmount;
        portfolio.trades.push({
          time: new Date().toISOString(),
          side: "buy",
          symbol,
          amount,
          priceUsd: price,
          valueUsd: usdAmount,
          reason: String(args.reason ?? ""),
        });
        savePortfolio(portfolio);
        logger.info(
          `BUY ${symbol}: $${fmtUsd(usdAmount)} @ $${fmtUsd(price)}`,
        );
        appendWorklog(
          `- ${new Date().toISOString()} **BUY ${symbol}** $${fmtUsd(usdAmount)} @ $${fmtUsd(price)} ` +
            `(TP +${takeProfitPct}% / SL -${stopLossPct}%) — ` +
            `thesis: ${String(args.reason ?? "").trim() || "(none given)"}`,
        );

        return (
          `Bought ${fmtAmount(amount)} ${symbol} @ $${fmtUsd(price)} for $${fmtUsd(usdAmount)} (paper trade).\n` +
          `Cash remaining: $${fmtUsd(portfolio.cashUsd)}. Position: ${fmtAmount(portfolio.positions[symbol].amount)} ${symbol} (avg cost $${fmtUsd(portfolio.positions[symbol].avgCostUsd)}).\n` +
          `You committed to exiting at +${takeProfitPct}% or -${stopLossPct}%. You will be asked to act when it gets there.`
        );
      },
    },
    {
      name: "sell_crypto",
      description:
        "Sell crypto for fake USD at the live market price (paper trading, no real money). " +
        `Either a USD amount or the whole position. Always state why in "reason".`,
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: `Coin to sell: ${SYMBOLS.join(", ")}`,
          },
          usd_amount: {
            type: "number",
            description:
              "USD value to sell. Omit and set sell_all=true to close the whole position.",
          },
          sell_all: {
            type: "boolean",
            description: "Set true to sell the entire position",
          },
          exit_type: {
            type: "string",
            enum: [...EXIT_TYPES],
            description:
              "What this close is. take_profit and stop_loss claim your declared level was " +
              "reached and are checked against the position — a false claim is rejected. " +
              "thesis_change (the reason you opened it no longer holds) and risk (sizing, " +
              "not a view) are your judgement and are accepted at any profit or loss.",
          },
          reason: {
            type: "string",
            description: "Why you are selling, in your own words",
          },
        },
        required: ["symbol", "reason", "exit_type"],
      },
      execute: async (args) => {
        const symbol = normalizeSymbol(args.symbol);
        if (typeof symbol === "object") return symbol.error;

        const portfolio = loadPortfolio();
        const pos = portfolio.positions[symbol];
        if (!pos || pos.amount <= 0) {
          const open =
            Object.keys(portfolio.positions).join(", ") || "(none — all cash)";
          const recent = describeRecentClose(portfolio, symbol);
          return recent
            ? `${recent}\nYour open positions: ${open}. Cash: $${fmtUsd(portfolio.cashUsd)}.`
            : `No ${symbol} position to sell. Current positions: ${open}`;
        }
        if (pos.side === "short") {
          return `Your ${symbol} position is a SHORT — you do not own coins to sell. Use close_short to buy it back and realize the result.`;
        }

        const quotes = await fetchQuotes();
        const price = quotes[symbol].usd;
        const positionValueUsd = pos.amount * price;

        // Settle the stated grounds before touching the portfolio: a close
        // labelled take_profit or stop_loss has to match the position.
        const claimError = checkExitClaim(
          symbol,
          pos,
          positionPnl(pos, price).pnlPct,
          args.exit_type,
        );
        if (claimError) return claimError;
        const exitType = String(args.exit_type).trim().toLowerCase();

        let sellValueUsd: number;
        if (args.sell_all === true || args.usd_amount === undefined) {
          sellValueUsd = positionValueUsd;
        } else {
          sellValueUsd = Number(args.usd_amount);
          if (!Number.isFinite(sellValueUsd) || sellValueUsd < MIN_TRADE_USD) {
            return `Invalid usd_amount: minimum trade is $${MIN_TRADE_USD}. To close the position, set sell_all=true.`;
          }
          if (sellValueUsd > positionValueUsd) {
            return `Position too small: ${fmtAmount(pos.amount)} ${symbol} is worth $${fmtUsd(positionValueUsd)}, tried to sell $${fmtUsd(sellValueUsd)}. Use sell_all=true to close it.`;
          }
        }

        const amount = Math.min(sellValueUsd / price, pos.amount);
        const realizedPnlUsd = (price - pos.avgCostUsd) * amount;

        pos.amount -= amount;
        if (pos.amount * price < 0.01) {
          delete portfolio.positions[symbol];
        }
        portfolio.cashUsd += sellValueUsd;
        portfolio.trades.push({
          time: new Date().toISOString(),
          side: "sell",
          symbol,
          amount,
          priceUsd: price,
          valueUsd: sellValueUsd,
          reason: String(args.reason ?? ""),
          exitType,
          realizedPnlUsd,
        });
        savePortfolio(portfolio);
        logger.info(
          `SELL ${symbol}: $${fmtUsd(sellValueUsd)} @ $${fmtUsd(price)} (P&L $${fmtUsd(realizedPnlUsd)}, ${exitType})`,
        );
        appendWorklog(
          `- ${new Date().toISOString()} **SELL ${symbol}** $${fmtUsd(sellValueUsd)} @ $${fmtUsd(price)}, ` +
            `realized ${realizedPnlUsd >= 0 ? "+" : "-"}$${fmtUsd(Math.abs(realizedPnlUsd))} ` +
            `[${exitType}] — reason: ${String(args.reason ?? "").trim() || "(none given)"}`,
        );

        const pnlSign = realizedPnlUsd >= 0 ? "+" : "-";
        return (
          `Sold ${fmtAmount(amount)} ${symbol} @ $${fmtUsd(price)} for $${fmtUsd(sellValueUsd)} (paper trade).\n` +
          `Realized P&L: ${pnlSign}$${fmtUsd(Math.abs(realizedPnlUsd))} vs avg cost $${fmtUsd(pos.avgCostUsd)}.\n` +
          `Cash: $${fmtUsd(portfolio.cashUsd)}.`
        );
      },
    },
    {
      // Shorting exists because the agent's documented failure was not just
      // refusing to sell — it was that every one of its 68 trades was a buy.
      // With only long tools, "the market is falling" has no expressible
      // action, so a bearish read collapses into holding cash. This gives the
      // view somewhere to go. Margin is 100%: the cash backing the short is
      // locked as collateral, so there is no leverage and the worst case is a
      // liquidation that costs exactly that collateral.
      name: "open_short",
      description:
        "Open a SHORT position: borrow a coin and sell it at the live price, profiting if the price FALLS " +
        "(paper trading, no real money). The USD amount is locked as collateral until you close. " +
        `Coins: ${SYMBOLS.join(", ")}. State your thesis and commit to exit levels.`,
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: `Coin to short: ${SYMBOLS.join(", ")}`,
          },
          usd_amount: {
            type: "number",
            description: `USD notional to short, locked as collateral (min $${MIN_TRADE_USD})`,
          },
          reason: {
            type: "string",
            description: "Your bearish thesis: why this coin falls from here",
          },
          take_profit_pct: {
            type: "number",
            description: `Percent DROP at which you commit to covering (${MIN_EXIT_PCT}-${MAX_EXIT_PCT})`,
          },
          stop_loss_pct: {
            type: "number",
            description: `Percent RISE at which you commit to cutting it (${MIN_EXIT_PCT}-${MAX_EXIT_PCT})`,
          },
        },
        required: [
          "symbol",
          "usd_amount",
          "reason",
          "take_profit_pct",
          "stop_loss_pct",
        ],
      },
      execute: async (args) => {
        const symbol = normalizeSymbol(args.symbol);
        if (typeof symbol === "object") return symbol.error;
        const usdAmount = Number(args.usd_amount);
        if (!Number.isFinite(usdAmount) || usdAmount < MIN_TRADE_USD) {
          return `Invalid usd_amount: minimum trade is $${MIN_TRADE_USD}.`;
        }
        const tpError = validateExitLevel(args.take_profit_pct, "take_profit_pct");
        if (tpError) return tpError;
        const slError = validateExitLevel(args.stop_loss_pct, "stop_loss_pct");
        if (slError) return slError;
        const takeProfitPct = Number(args.take_profit_pct);
        const stopLossPct = Number(args.stop_loss_pct);

        const portfolio = loadPortfolio();
        const existing = portfolio.positions[symbol];
        if (existing && existing.side === "long") {
          return (
            `Blocked: you are LONG ${symbol}. Shorting it now would be betting both ways on the same coin. ` +
            `Sell the long first with sell_crypto if your view has flipped.`
          );
        }
        if (usdAmount > portfolio.cashUsd) {
          return `Insufficient cash for collateral: you have $${fmtUsd(portfolio.cashUsd)}, this short needs $${fmtUsd(usdAmount)}.`;
        }

        const quotes = await fetchQuotes();
        const price = quotes[symbol].usd;
        const amount = usdAmount / price;

        if (existing && existing.avgCostUsd > 0) {
          const posPnlPct = positionPnl(existing, price).pnlPct;
          if (posPnlPct < -NO_AVERAGE_DOWN_PCT) {
            return (
              `Blocked: your ${symbol} short is already down ${Math.abs(posPnlPct).toFixed(2)}% — do NOT add to a losing short. ` +
              `The price is moving against you; adding size raises your liquidation risk instead of fixing the thesis. Hold it or close it with close_short.`
            );
          }
        }

        const equityUsd = computeEquity(portfolio, quotes);
        const cashAfter = portfolio.cashUsd - usdAmount;
        const reserveFloor = (equityUsd * MIN_CASH_RESERVE_PCT) / 100;
        if (cashAfter < reserveFloor) {
          return (
            `Blocked: posting $${fmtUsd(usdAmount)} of collateral would drop cash to $${fmtUsd(cashAfter)}, below your ${MIN_CASH_RESERVE_PCT}% reserve ($${fmtUsd(reserveFloor)}). ` +
            `Close something before opening a new position.`
          );
        }
        const exposureAfter = (existing?.amount ?? 0) * price + usdAmount;
        const concentrationCap = (equityUsd * MAX_POSITION_PCT) / 100;
        if (exposureAfter > concentrationCap) {
          return (
            `Blocked: this short would put $${fmtUsd(exposureAfter)} of exposure on ${symbol}, over your ${MAX_POSITION_PCT}% single-coin cap ($${fmtUsd(concentrationCap)}).`
          );
        }

        if (existing) {
          const totalNotional =
            existing.avgCostUsd * existing.amount + usdAmount;
          existing.amount += amount;
          existing.avgCostUsd = totalNotional / existing.amount;
          existing.collateralUsd += usdAmount;
          existing.takeProfitPct = takeProfitPct;
          existing.stopLossPct = stopLossPct;
          existing.levelsInherited = false;
        } else {
          portfolio.positions[symbol] = {
            side: "short",
            amount,
            avgCostUsd: price,
            collateralUsd: usdAmount,
            takeProfitPct,
            stopLossPct,
            levelsInherited: false,
          };
        }
        portfolio.cashUsd -= usdAmount;
        portfolio.trades.push({
          time: new Date().toISOString(),
          side: "short",
          symbol,
          amount,
          priceUsd: price,
          valueUsd: usdAmount,
          reason: String(args.reason ?? ""),
        });
        savePortfolio(portfolio);
        logger.info(`SHORT ${symbol}: $${fmtUsd(usdAmount)} @ $${fmtUsd(price)}`);
        appendWorklog(
          `- ${new Date().toISOString()} **SHORT ${symbol}** $${fmtUsd(usdAmount)} @ $${fmtUsd(price)} ` +
            `(TP -${takeProfitPct}% / SL +${stopLossPct}%) — ` +
            `thesis: ${String(args.reason ?? "").trim() || "(none given)"}`,
        );

        const liquidationPrice = price * 2;
        return (
          `Shorted ${fmtAmount(amount)} ${symbol} @ $${fmtUsd(price)}, $${fmtUsd(usdAmount)} locked as collateral (paper trade).\n` +
          `You profit if ${symbol} falls. Cash remaining: $${fmtUsd(portfolio.cashUsd)}.\n` +
          `You committed to covering at -${takeProfitPct}% or cutting at +${stopLossPct}%. ` +
          `If ${symbol} reaches about $${fmtUsd(liquidationPrice)} the collateral is gone and the position is liquidated.`
        );
      },
    },
    {
      name: "close_short",
      description:
        "Close a SHORT position: buy the coin back at the live price and realize the profit or loss. " +
        `Your collateral is returned along with the result. Always state why in "reason".`,
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: `Coin whose short to close: ${SYMBOLS.join(", ")}`,
          },
          exit_type: {
            type: "string",
            enum: [...EXIT_TYPES],
            description:
              "What this close is. take_profit and stop_loss claim your declared level was " +
              "reached and are checked against the position — a false claim is rejected. " +
              "thesis_change (the reason you opened it no longer holds) and risk (sizing, " +
              "not a view) are your judgement and are accepted at any profit or loss.",
          },
          reason: {
            type: "string",
            description: "Why you are covering, in your own words",
          },
        },
        required: ["symbol", "reason", "exit_type"],
      },
      execute: async (args) => {
        const symbol = normalizeSymbol(args.symbol);
        if (typeof symbol === "object") return symbol.error;

        const portfolio = loadPortfolio();
        const pos = portfolio.positions[symbol];
        if (!pos || pos.amount <= 0) {
          const open =
            Object.keys(portfolio.positions).join(", ") || "(none — all cash)";
          const recent = describeRecentClose(portfolio, symbol);
          return recent
            ? `${recent}\nYour open positions: ${open}. Cash: $${fmtUsd(portfolio.cashUsd)}.`
            : `No ${symbol} position to close. Current positions: ${open}`;
        }
        if (pos.side !== "short") {
          return `Your ${symbol} position is a LONG, not a short. Use sell_crypto to close it.`;
        }

        const quotes = await fetchQuotes();
        const price = quotes[symbol].usd;
        const { pnlUsd, pnlPct } = positionPnl(pos, price);
        const collateral = pos.collateralUsd;

        // Same check as sell_crypto: a short covered at a loss cannot be
        // labelled a take-profit. Direction is already handled by positionPnl.
        const claimError = checkExitClaim(symbol, pos, pnlPct, args.exit_type);
        if (claimError) return claimError;
        const exitType = String(args.exit_type).trim().toLowerCase();

        portfolio.cashUsd += collateral + pnlUsd;
        delete portfolio.positions[symbol];
        portfolio.trades.push({
          time: new Date().toISOString(),
          side: "cover",
          symbol,
          amount: pos.amount,
          priceUsd: price,
          valueUsd: pos.amount * price,
          reason: String(args.reason ?? ""),
          exitType,
          realizedPnlUsd: pnlUsd,
        });
        savePortfolio(portfolio);
        logger.info(
          `COVER ${symbol} @ $${fmtUsd(price)} (P&L $${fmtUsd(pnlUsd)}, ${exitType})`,
        );
        const sign = pnlUsd >= 0 ? "+" : "-";
        appendWorklog(
          `- ${new Date().toISOString()} **COVER ${symbol}** @ $${fmtUsd(price)}, ` +
            `realized ${sign}$${fmtUsd(Math.abs(pnlUsd))} ` +
            `[${exitType}] — reason: ${String(args.reason ?? "").trim() || "(none given)"}`,
        );

        return (
          `Covered ${fmtAmount(pos.amount)} ${symbol} @ $${fmtUsd(price)} vs entry $${fmtUsd(pos.avgCostUsd)} (paper trade).\n` +
          `Realized P&L: ${sign}$${fmtUsd(Math.abs(pnlUsd))}. Collateral $${fmtUsd(collateral)} returned.\n` +
          `Cash: $${fmtUsd(portfolio.cashUsd)}.`
        );
      },
    },
    {
      // The counterpart to sell_crypto on a forced decision turn. Holding
      // through a signal is a legitimate call, but it has to be an argued
      // decision rather than silence — before this existed the agent could
      // let a signal stand simply by calling a read-only tool again, which it
      // did for eleven turns straight.
      name: "hold_position",
      description:
        "Decide to HOLD a position that crossed one of your declared exit levels, instead of closing it. " +
        "You must give a reason AND set new levels: holding through your own stop means moving it, " +
        "deliberately and on the record. The decision is written to your journal.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: `Coin to hold (${SYMBOLS.join(", ")})`,
          },
          reason: {
            type: "string",
            description:
              "Why the thesis still stands despite the level being hit, and what would change your mind.",
          },
          new_take_profit_pct: {
            type: "number",
            description: `Revised take-profit level (${MIN_EXIT_PCT}-${MAX_EXIT_PCT})`,
          },
          new_stop_loss_pct: {
            type: "number",
            description: `Revised stop-loss level (${MIN_EXIT_PCT}-${MAX_EXIT_PCT})`,
          },
        },
        required: [
          "symbol",
          "reason",
          "new_take_profit_pct",
          "new_stop_loss_pct",
        ],
      },
      execute: async (args) => {
        const symbol = String(args.symbol ?? "").toUpperCase();
        if (!SYMBOLS.includes(symbol)) {
          return `Unknown symbol "${symbol}". Tradeable: ${SYMBOLS.join(", ")}.`;
        }
        const portfolio = loadPortfolio();
        const pos = portfolio.positions[symbol];
        if (!pos) {
          return `You hold no ${symbol} position, so there is nothing to hold.`;
        }
        const reason = String(args.reason ?? "").trim();
        if (!reason) {
          return "Refused: holding through your own exit level requires a reason. State why the thesis still stands.";
        }
        // Requiring new levels is what stops this from being a way to ignore
        // the signal forever: the level has to move, so the next decision turn
        // fires somewhere new instead of re-firing on the same price tick.
        const tpError = validateExitLevel(
          args.new_take_profit_pct,
          "new_take_profit_pct",
        );
        if (tpError) return tpError;
        const slError = validateExitLevel(
          args.new_stop_loss_pct,
          "new_stop_loss_pct",
        );
        if (slError) return slError;
        const oldTp = pos.takeProfitPct;
        const oldSl = pos.stopLossPct;
        pos.takeProfitPct = Number(args.new_take_profit_pct);
        pos.stopLossPct = Number(args.new_stop_loss_pct);
        pos.levelsInherited = false;
        savePortfolio(portfolio);

        logger.info(`HOLD ${symbol}: ${reason.slice(0, 80)}`);
        appendWorklog(
          `- ${new Date().toISOString()} **HOLD ${pos.side.toUpperCase()} ${symbol}** through its level — ` +
            `levels revised +${oldTp}%/-${oldSl}% → +${pos.takeProfitPct}%/-${pos.stopLossPct}% — reason: ${reason}`,
        );
        return (
          `Recorded: holding ${fmtAmount(pos.amount)} ${symbol} (${pos.side}) through its exit level.\n` +
          `Your levels are now +${pos.takeProfitPct}% / -${pos.stopLossPct}%, and your reason is journaled.\n` +
          `You will be asked again at the new levels — a thesis you have to keep re-writing is a thesis to close.`
        );
      },
    },
    {
      name: "portfolio_status",
      description:
        "Show your paper-trading portfolio: cash, positions with live value and unrealized P&L, " +
        "total equity vs starting capital, and recent trades.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        const quotes = await fetchQuotes();
        const portfolio = enforceLiquidations(loadPortfolio(), quotes);
        const lines: string[] = [];

        const sellSignals: string[] = [];
        const symbols = Object.keys(portfolio.positions);
        if (symbols.length > 0) {
          lines.push("Positions:");
          for (const symbol of symbols) {
            const pos = portfolio.positions[symbol];
            const price = quotes[symbol]?.usd;
            if (price === undefined) {
              lines.push(`  ${symbol}: ${fmtAmount(pos.amount)} (no live price)`);
              continue;
            }
            const { pnlUsd, pnlPct } = positionPnl(pos, price);
            const sign = pnlUsd >= 0 ? "+" : "-";
            const label = pos.side === "long" ? "LONG" : "SHORT";
            const valueNote =
              pos.side === "long"
                ? `→ $${fmtUsd(positionExposure(pos, price))}`
                : `notional $${fmtUsd(positionExposure(pos, price))}, collateral $${fmtUsd(pos.collateralUsd)}`;
            lines.push(
              `  ${label} ${symbol}: ${fmtAmount(pos.amount)} @ entry $${fmtUsd(pos.avgCostUsd)} ${valueNote} ` +
                `(unrealized ${sign}$${fmtUsd(Math.abs(pnlUsd))}, ${sign}${Math.abs(pnlPct).toFixed(2)}%) ` +
                `— your levels: +${pos.takeProfitPct}% / -${pos.stopLossPct}%${pos.levelsInherited ? " (inherited, not yours)" : ""}`,
            );
            const signal = signalFor(symbol, pos, pnlPct, pnlUsd);
            if (signal) {
              const closer =
                pos.side === "long" ? "sell_crypto" : "close_short";
              sellSignals.push(
                `${formatSellSignal(signal)} ${
                  signal.kind === "TAKE PROFIT"
                    ? `Close it with ${closer} to lock in the gain.`
                    : `Close it with ${closer} to cut the loss.`
                }`,
              );
            }
          }
        } else {
          lines.push("Positions: (none — all cash)");
        }

        const equityUsd = computeEquity(portfolio, quotes);
        const totalPnlUsd = equityUsd - portfolio.initialCapitalUsd;
        const totalSign = totalPnlUsd >= 0 ? "+" : "-";
        lines.push(`Cash: $${fmtUsd(portfolio.cashUsd)}`);
        lines.push(
          `Total equity: $${fmtUsd(equityUsd)} (started $${fmtUsd(portfolio.initialCapitalUsd)}, ${totalSign}$${fmtUsd(Math.abs(totalPnlUsd))}, ${totalSign}${Math.abs((totalPnlUsd / portfolio.initialCapitalUsd) * 100).toFixed(2)}%)`,
        );

        if (sellSignals.length > 0) {
          lines.push(`>>> SELL SIGNALS (act on these now):`);
          for (const sig of sellSignals) lines.push(`  ! ${sig}`);
        } else if (symbols.length > 0) {
          lines.push(
            `No exit levels hit yet — each position above shows the levels you set. Holding is fine.`,
          );
        }

        const recent = portfolio.trades.slice(-5);
        if (recent.length > 0) {
          lines.push(`Recent trades (${portfolio.trades.length} total):`);
          for (const t of recent) {
            lines.push(
              `  [${t.time.slice(0, 16)}] ${t.side.toUpperCase()} ${fmtAmount(t.amount)} ${t.symbol} @ $${fmtUsd(t.priceUsd)} — ${t.reason}`,
            );
          }
        } else {
          lines.push("No trades yet.");
        }

        return lines.join("\n");
      },
    },
  ];
}
