# Automaton Sim — Solo Paper-Trading Fork

> A fork of [Conway-Research/automaton](https://github.com/Conway-Research/automaton) that
> turns the autonomous-agent framework into a **single, offline, simulation-only crypto
> paper-trading agent**. No real money, no cloud, no self-replication — it runs locally on
> [Ollama](https://ollama.com) and trades a fake $10,000 portfolio on live prices.

This is an experiment, not a product. See the [disclaimer](#disclaimer) before reading anything into it.

---

## What this fork changes

The upstream [Automaton](https://github.com/Conway-Research/automaton) is a *sovereign* agent
designed to earn real money, register domains, spawn child agents, and self-replicate in the
cloud. This fork **deliberately disables all of that** and narrows the agent to one job:
discretionary crypto paper trading, driven by a local LLM.

| Upstream Automaton | This fork |
| --- | --- |
| Real USDC wallet, pays for its own compute | Simulated credit ledger — fake money only |
| Cloud VMs, public services, domains | Runs offline on your machine; no internet services |
| Spawns & funds child agents, colony orchestration | **Solo** — exactly one agent, no children, no workers |
| Can edit its own code, deploy, earn credits | **Trader only** — code/build/earn tools removed |
| Paid frontier models | Local [Ollama](https://ollama.com) model (e.g. `qwen3:14b`) |
| Rewrites its own soul/identity | Operator-authored identity, locked |

The one job, every turn:

1. Check live prices for BTC / ETH / SOL (`get_crypto_price`, free CoinGecko API).
2. Form an explicit thesis — or decide to hold.
3. Act: `buy_crypto` / `sell_crypto` at the live price, thesis required.
4. Review P&L with `portfolio_status`.
5. Journal the thesis and outcome so the strategy (in principle) compounds.

The fake portfolio lives in `~/.automaton/portfolio.json`, separate from the simulated
compute-cost ledger.

## What was added on top of upstream

- **`src/sim/`** — simulation mode: a fake credit ledger, a mock Conway client (local `exec`,
  no cloud), and per-token inference billing at configurable fake prices.
- **`src/agent/trading-tools.ts`** — the paper-trading tools (`get_crypto_price`, `buy_crypto`,
  `sell_crypto`, `portfolio_status`) and the on-disk portfolio ledger.
- **`src/agent/sim-restrictions.ts`** — "solo trading" tool gating: strips agent-spawning,
  colony delegation, domains, on-chain, real-money, code/build, and soul-rewrite tools when
  `AUTOMATON_SIM_MODE=1`, leaving only the trading + journaling surface.
- Simulation-only system-prompt, SOUL, and genesis variants that scope the agent to trading.

All simulation behavior is gated behind `AUTOMATON_SIM_MODE=1`; with the flag off, the code
path is upstream-identical.

## Quick start

Requires Node 20+ and a running [Ollama](https://ollama.com) with a pulled model.

```bash
git clone <your-fork-url>
cd automaton
npm install && npm run build

# pull a local model
ollama pull qwen3:14b

# one-time simulation setup + seed the fake compute ledger
node dist/index.js --sim-setup
node dist/index.js --sim-fund 10
```

On Windows, `run-sim.ps1` sets the environment (`AUTOMATON_SIM_MODE`, `HOME`, Git Bash shell)
and launches the loop:

```powershell
.\run-sim.ps1              # start the agent
.\run-sim.ps1 -Status      # ledger balance + status
Get-Content sim-run.log -Tail 40 -Wait   # watch it trade
```

The agent writes its portfolio to `~/.automaton/portfolio.json` and its trade journal to
`~/.automaton/WORKLOG.md`.

## Disclaimer

- **Paper trading only.** No real funds are ever touched. There is no exchange integration,
  no order execution, no custody — trades are simulated against public price feeds.
- **Not financial advice**, not a trading strategy, and not a serious trading system. The
  agent makes discretionary calls from a small local LLM with no backtesting and no risk model.
- Built as an **educational / research experiment** in autonomous-agent behavior. Treat its
  P&L as a curiosity, not a signal.

## Credit & license

This fork is built on **[Conway-Research/automaton](https://github.com/Conway-Research/automaton)**
by Conway, used under the MIT License. The original `LICENSE` (© Conway) is preserved, and the
original project README is kept as [`README.upstream.md`](./README.upstream.md). All fork-specific
changes are likewise released under the MIT License.
