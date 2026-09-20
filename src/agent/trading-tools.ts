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
const TAKE_PROFIT_PCT = 2; // flag SELL when a position is up >= this %
const STOP_LOSS_PCT = 2; // flag SELL when a position is down >= this %
const MIN_CASH_RESERVE_PCT = 20; // never let a buy push cash below this % of equity
const MAX_POSITION_PCT = 45; // no single coin may exceed this % of equity
const NO_AVERAGE_DOWN_PCT = 1; // block adding to a position already down more than this %

// ─── Portfolio Ledger ──────────────────────────────────────────

interface Position {
  /** Coin units held. */
  amount: number;
  /** Average cost per unit in USD. */
  avgCostUsd: number;
}

interface TradeRecord {
  time: string;
  side: "buy" | "sell";
  symbol: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
  reason: string;
  /** Realized profit/loss vs average cost (sells only). */
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

function loadPortfolio(): Portfolio {
  const file = portfolioPath();
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Portfolio;
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
            description: "Your trading thesis: why buy, and at what condition you would exit",
          },
        },
        required: ["symbol", "usd_amount", "reason"],
      },
      execute: async (args) => {
        const symbol = normalizeSymbol(args.symbol);
        if (typeof symbol === "object") return symbol.error;
        const usdAmount = Number(args.usd_amount);
        if (!Number.isFinite(usdAmount) || usdAmount < MIN_TRADE_USD) {
          return `Invalid usd_amount: minimum trade is $${MIN_TRADE_USD}.`;
        }

        const portfolio = loadPortfolio();
        if (usdAmount > portfolio.cashUsd) {
          return `Insufficient cash: you have $${fmtUsd(portfolio.cashUsd)}, tried to spend $${fmtUsd(usdAmount)}.`;
        }

        const quotes = await fetchQuotes();
        const price = quotes[symbol].usd;
        const amount = usdAmount / price;

        // No averaging down: refuse to add to a position that is already
        // underwater beyond a small dip. Throwing more money at a loser keeps
        // its %P&L near zero and dodges the stop-loss forever. Force the
        // position to resolve (recover into take-profit, or hit stop-loss).
        const existing = portfolio.positions[symbol];
        if (existing && existing.avgCostUsd > 0) {
          const posPnlPct = (price / existing.avgCostUsd - 1) * 100;
          if (posPnlPct < -NO_AVERAGE_DOWN_PCT) {
            return (
              `Blocked: ${symbol} is already down ${Math.abs(posPnlPct).toFixed(2)}% on your position — do NOT average down into a loser. ` +
              `Either hold and wait for it to recover toward take-profit, or cut it with sell_crypto if the thesis is broken. Adding more only digs the hole deeper.`
            );
          }
        }

        // Sell-discipline guards: keep a cash reserve and cap concentration so
        // the agent can't deploy everything into one endless accumulation.
        let equityUsd = portfolio.cashUsd;
        for (const [s, p] of Object.entries(portfolio.positions)) {
          equityUsd += p.amount * (quotes[s]?.usd ?? p.avgCostUsd);
        }
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
        } else {
          portfolio.positions[symbol] = { amount, avgCostUsd: price };
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
          `- ${new Date().toISOString()} **BUY ${symbol}** $${fmtUsd(usdAmount)} @ $${fmtUsd(price)} — ` +
            `thesis: ${String(args.reason ?? "").trim() || "(none given)"}`,
        );

        return (
          `Bought ${fmtAmount(amount)} ${symbol} @ $${fmtUsd(price)} for $${fmtUsd(usdAmount)} (paper trade).\n` +
          `Cash remaining: $${fmtUsd(portfolio.cashUsd)}. Position: ${fmtAmount(portfolio.positions[symbol].amount)} ${symbol} (avg cost $${fmtUsd(portfolio.positions[symbol].avgCostUsd)}).`
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
          reason: {
            type: "string",
            description: "Why you are selling (thesis played out, stop-loss, rebalance...)",
          },
        },
        required: ["symbol", "reason"],
      },
      execute: async (args) => {
        const symbol = normalizeSymbol(args.symbol);
        if (typeof symbol === "object") return symbol.error;

        const portfolio = loadPortfolio();
        const pos = portfolio.positions[symbol];
        if (!pos || pos.amount <= 0) {
          return `No ${symbol} position to sell. Current positions: ${
            Object.keys(portfolio.positions).join(", ") || "(none)"
          }`;
        }

        const quotes = await fetchQuotes();
        const price = quotes[symbol].usd;
        const positionValueUsd = pos.amount * price;

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
          realizedPnlUsd,
        });
        savePortfolio(portfolio);
        logger.info(
          `SELL ${symbol}: $${fmtUsd(sellValueUsd)} @ $${fmtUsd(price)} (P&L $${fmtUsd(realizedPnlUsd)})`,
        );
        appendWorklog(
          `- ${new Date().toISOString()} **SELL ${symbol}** $${fmtUsd(sellValueUsd)} @ $${fmtUsd(price)}, ` +
            `realized ${realizedPnlUsd >= 0 ? "+" : "-"}$${fmtUsd(Math.abs(realizedPnlUsd))} — ` +
            `reason: ${String(args.reason ?? "").trim() || "(none given)"}`,
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
        const portfolio = loadPortfolio();
        const lines: string[] = [];

        let positionsValueUsd = 0;
        const sellSignals: string[] = [];
        const symbols = Object.keys(portfolio.positions);
        if (symbols.length > 0) {
          const quotes = await fetchQuotes();
          lines.push("Positions:");
          for (const symbol of symbols) {
            const pos = portfolio.positions[symbol];
            const price = quotes[symbol]?.usd;
            if (price === undefined) {
              lines.push(`  ${symbol}: ${fmtAmount(pos.amount)} (no live price)`);
              continue;
            }
            const valueUsd = pos.amount * price;
            positionsValueUsd += valueUsd;
            const pnlUsd = (price - pos.avgCostUsd) * pos.amount;
            const pnlPct =
              pos.avgCostUsd > 0 ? (price / pos.avgCostUsd - 1) * 100 : 0;
            const sign = pnlUsd >= 0 ? "+" : "-";
            lines.push(
              `  ${symbol}: ${fmtAmount(pos.amount)} @ avg $${fmtUsd(pos.avgCostUsd)} → $${fmtUsd(valueUsd)} (unrealized ${sign}$${fmtUsd(Math.abs(pnlUsd))}, ${sign}${Math.abs(pnlPct).toFixed(2)}%)`,
            );
            if (pnlPct >= TAKE_PROFIT_PCT) {
              sellSignals.push(
                `TAKE PROFIT — ${symbol} is up ${pnlPct.toFixed(2)}% (+$${fmtUsd(pnlUsd)}). Consider sell_crypto to lock in the gain.`,
              );
            } else if (pnlPct <= -STOP_LOSS_PCT) {
              sellSignals.push(
                `STOP LOSS — ${symbol} is down ${Math.abs(pnlPct).toFixed(2)}% (-$${fmtUsd(Math.abs(pnlUsd))}). Consider sell_crypto to cut the loss.`,
              );
            }
          }
        } else {
          lines.push("Positions: (none — all cash)");
        }

        const equityUsd = portfolio.cashUsd + positionsValueUsd;
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
            `No sell signals yet (take-profit +${TAKE_PROFIT_PCT}% / stop-loss -${STOP_LOSS_PCT}% not hit). Holding is fine.`,
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
