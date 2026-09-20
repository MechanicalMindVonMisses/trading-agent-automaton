import { describe, expect, it } from "vitest";
import { EXIT_TYPES, checkExitClaim } from "../agent/trading-tools.js";

/**
 * Positions shaped like the ones the agent actually held when it closed them
 * with a stated trigger that had not happened.
 */
function longAt(pnlInputs: {
  takeProfitPct: number;
  stopLossPct: number;
  inherited?: boolean;
}) {
  return {
    side: "long" as const,
    amount: 1,
    avgCostUsd: 100,
    collateralUsd: 0,
    takeProfitPct: pnlInputs.takeProfitPct,
    stopLossPct: pnlInputs.stopLossPct,
    levelsInherited: pnlInputs.inherited,
  };
}

describe("checkExitClaim", () => {
  it("rejects the take_profit label on a losing position", () => {
    // The real call: BTC sold at -1.13% as "reached the predefined
    // take-profit level of 10%".
    const err = checkExitClaim(
      "BTC",
      longAt({ takeProfitPct: 10, stopLossPct: 5 }),
      -1.13,
      "take_profit",
    );
    expect(err).toBeTruthy();
    expect(err).toContain("-1.13%");
    expect(err).toContain("+10%");
  });

  it("rejects take_profit when in profit but short of the declared level", () => {
    const err = checkExitClaim(
      "ETH",
      longAt({ takeProfitPct: 15, stopLossPct: 5 }),
      0.06,
      "take_profit",
    );
    expect(err).toBeTruthy();
  });

  it("accepts take_profit once the declared level is reached", () => {
    expect(
      checkExitClaim("ETH", longAt({ takeProfitPct: 15, stopLossPct: 5 }), 15, "take_profit"),
    ).toBeNull();
    expect(
      checkExitClaim("ETH", longAt({ takeProfitPct: 15, stopLossPct: 5 }), 20.4, "take_profit"),
    ).toBeNull();
  });

  it("rejects the stop_loss label above the declared stop", () => {
    const err = checkExitClaim(
      "ETH",
      longAt({ takeProfitPct: 15, stopLossPct: 5 }),
      -0.04,
      "stop_loss",
    );
    expect(err).toBeTruthy();
    expect(err).toContain("-5%");
  });

  it("accepts stop_loss at or past the declared stop", () => {
    expect(
      checkExitClaim("ETH", longAt({ takeProfitPct: 15, stopLossPct: 5 }), -5, "stop_loss"),
    ).toBeNull();
    expect(
      checkExitClaim("ETH", longAt({ takeProfitPct: 15, stopLossPct: 5 }), -8.2, "stop_loss"),
    ).toBeNull();
  });

  it("accepts a judgement label at any P&L, so closing a loser is never blocked", () => {
    const pos = longAt({ takeProfitPct: 15, stopLossPct: 5 });
    for (const pnl of [-30, -1.13, 0, 0.06, 40]) {
      expect(checkExitClaim("ETH", pos, pnl, "thesis_change")).toBeNull();
      expect(checkExitClaim("ETH", pos, pnl, "risk")).toBeNull();
    }
  });

  it("names the honest alternatives when it refuses a label", () => {
    const err = checkExitClaim(
      "BTC",
      longAt({ takeProfitPct: 10, stopLossPct: 5 }),
      -1.13,
      "take_profit",
    );
    expect(err).toContain("thesis_change");
    expect(err).toContain("risk");
  });

  it("marks levels the agent did not choose", () => {
    const err = checkExitClaim(
      "BTC",
      longAt({ takeProfitPct: 2, stopLossPct: 2, inherited: true }),
      -1.13,
      "take_profit",
    );
    expect(err).toContain("inherited");
  });

  it("rejects an unknown label and lists the valid ones", () => {
    const err = checkExitClaim(
      "BTC",
      longAt({ takeProfitPct: 10, stopLossPct: 5 }),
      5,
      "because_i_felt_like_it",
    );
    expect(err).toBeTruthy();
    for (const t of EXIT_TYPES) expect(err).toContain(t);
  });

  it("rejects a missing label", () => {
    expect(
      checkExitClaim("BTC", longAt({ takeProfitPct: 10, stopLossPct: 5 }), 5, undefined),
    ).toBeTruthy();
  });

  it("checks a short against its own direction", () => {
    // positionPnl already signs a short's P&L, so a cover at a loss arrives
    // here negative and must fail the same way a long does.
    const short = {
      side: "short" as const,
      amount: 1,
      avgCostUsd: 100,
      collateralUsd: 100,
      takeProfitPct: 10,
      stopLossPct: 5,
    };
    expect(checkExitClaim("SOL", short, -3, "take_profit")).toBeTruthy();
    expect(checkExitClaim("SOL", short, 12, "take_profit")).toBeNull();
  });
});
