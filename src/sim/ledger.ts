/**
 * Simulation Ledger
 *
 * Local fake-credit ledger for simulation mode. Replaces Conway's
 * server-side credit balance with a JSON file so the automaton runs
 * under the same economic pressure without real money.
 *
 * Balances are stored in cents as floats so sub-cent inference costs
 * accumulate accurately. Survival tier semantics are unchanged:
 * negative balance = dead.
 */

import fs from "fs";
import path from "path";
import { getAutomatonDir } from "../identity/wallet.js";

const LEDGER_FILENAME = "sim-ledger.json";
const MAX_TRANSACTIONS = 1000;

export interface SimTransaction {
  timestamp: string;
  deltaCents: number;
  balanceAfterCents: number;
  reason: string;
}

export interface SimLedger {
  balanceCents: number;
  createdAt: string;
  transactions: SimTransaction[];
}

export function isSimulationMode(): boolean {
  return process.env.AUTOMATON_SIM_MODE === "1";
}

export function getLedgerPath(): string {
  return path.join(getAutomatonDir(), LEDGER_FILENAME);
}

export function loadLedger(): SimLedger {
  const ledgerPath = getLedgerPath();
  if (!fs.existsSync(ledgerPath)) {
    return { balanceCents: 0, createdAt: new Date().toISOString(), transactions: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
    return {
      balanceCents: Number.isFinite(raw.balanceCents) ? raw.balanceCents : 0,
      createdAt: raw.createdAt || new Date().toISOString(),
      transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
    };
  } catch {
    return { balanceCents: 0, createdAt: new Date().toISOString(), transactions: [] };
  }
}

function saveLedger(ledger: SimLedger): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(getLedgerPath(), JSON.stringify(ledger, null, 2), { mode: 0o600 });
}

export function initLedger(initialCents: number): SimLedger {
  const ledger: SimLedger = {
    balanceCents: initialCents,
    createdAt: new Date().toISOString(),
    transactions: [
      {
        timestamp: new Date().toISOString(),
        deltaCents: initialCents,
        balanceAfterCents: initialCents,
        reason: "initial_funding",
      },
    ],
  };
  saveLedger(ledger);
  return ledger;
}

export function getBalanceCents(): number {
  return loadLedger().balanceCents;
}

/**
 * Apply a delta (positive = fund, negative = spend).
 * The balance may go negative — that is the "dead" signal, same as Conway.
 */
export function applyDelta(deltaCents: number, reason: string): number {
  const ledger = loadLedger();
  ledger.balanceCents += deltaCents;
  ledger.transactions.push({
    timestamp: new Date().toISOString(),
    deltaCents,
    balanceAfterCents: ledger.balanceCents,
    reason,
  });
  if (ledger.transactions.length > MAX_TRANSACTIONS) {
    ledger.transactions = ledger.transactions.slice(-MAX_TRANSACTIONS);
  }
  saveLedger(ledger);
  return ledger.balanceCents;
}
