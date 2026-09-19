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
