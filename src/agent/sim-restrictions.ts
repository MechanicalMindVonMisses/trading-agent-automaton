/**
 * Simulation "solo mode" restrictions.
 *
 * When AUTOMATON_SIM_MODE=1 the automaton runs as a single, self-contained
 * agent on the operator's local machine (one Ollama backend, a fake ledger).
 * In that world the colony/orchestration machinery is actively harmful:
 *  - spawning child automatons or in-process local workers means several
 *    concurrent inference streams fighting over one small local model, and
 *  - domain registration, on-chain registry, and real-money transfers are
 *    all blocked or meaningless, so goals built around them can never complete
 *    (the agent just loops: search_domains -> no results -> loop-enforcement).
 *
 * Sim solo mode narrows the agent to exactly two things it CAN do here:
 *   (A) improve its own codebase, and
 *   (B) investment research / analysis / tooling.
 *
 * This module is the single source of truth for which tools disappear in sim
 * solo mode. loop.ts filters the tool list through {@link filterToolsForSim}
 * and skips orchestrator/worker-pool init entirely (see loop.ts).
 */

import type { AutomatonTool } from "../types.js";

/** True when the process is running in simulation mode. */
export function isSimMode(): boolean {
  return process.env.AUTOMATON_SIM_MODE === "1";
}

/**
 * Tools removed from the agent in sim solo mode. Grouped by why they go.
 * Anything not listed here stays available (the trading tools, read_file,
 * write_file, the memory/journaling tools, sleep, view_soul, ...) — that is
 * the trading-only surface.
 */
export const SIM_DENIED_TOOLS: ReadonlySet<string> = new Set<string>([
  // ── Creating new agents / sandboxes (operator runs ONE agent locally) ──
  "spawn_child",
  "start_child",
  "fund_child",
  "list_children",
  "check_child_status",
  "message_child",
  "prune_dead_children",
  "create_sandbox",
  "delete_sandbox",
  "list_sandboxes",

  // ── Colony delegation (no orchestrator in solo mode — work is done solo) ──
  "create_goal",
  "cancel_goal",
  "get_plan",
  "orchestrator_status",
  "list_goals",

  // ── Domains: blocked in sim, the classic futile-goal sink ──
  "search_domains",
  "register_domain",
  "manage_dns",

  // ── On-chain registry / reputation: EVM real-money paths, dead in sim ──
  "register_erc8004",
  "update_agent_card",
  "discover_agents",
  "give_feedback",
  "check_reputation",

  // ── Real-money credit movement: x402 is disabled in sim ──
  "topup_credits",
  "transfer_credits",

  // ── Soul self-rewrite: the agent kept clobbering its own Core Purpose and
  //    driving genesis_alignment to 0 via update_soul/reflect_on_soul. Its
  //    identity is operator-authored here; trading direction lives in the
  //    genesisPrompt + system prompt, which the agent cannot touch. Learning
  //    from trades still flows through memory/procedures/WORKLOG, not the soul.
  "update_soul",
  "reflect_on_soul",

  // ── Public web services: no public internet in sim, and the upstream
  //    "earn credits by exposing a paid service" drive kept pulling the agent
  //    off its two tracks into building/deploying web endpoints. These are
  //    dead here (mock conway throws), so remove the temptation entirely.
  "expose_port",
  "remove_port",
  "install_mcp_server",

  // ── Aspirational goal-setting: in solo sim there is NO orchestrator to
  //    execute goals (it is disabled here). set_goal just writes an aspirational
  //    goal into working memory, which is then re-injected as context and
  //    re-primes drift ("build a web app", "earn credits") turn after turn.
  //    The agent is driven by the trading prompt + WORKLOG + remember_fact
  //    instead; a goal queue with no executor is pure noise here.
  "set_goal",
  "complete_goal",

  // ── TRADING-ONLY scope (operator decision): the agent's sole job here is
  //    crypto paper trading. Every recurring drift was the model wanting to
  //    BUILD something (web app, dashboard, dApp), which the "improve your own
  //    code" track invited. Removing the code/build surface makes that impulse
  //    impossible to act on. The agent keeps: trading tools, memory/journaling
  //    (read_file, write_file, remember_fact, save_procedure...), and
  //    operational tools (sleep, view_soul, ...).
  "exec",
  "edit_own_file",
  "revert_last_edit",
  "reset_to_upstream",
  "install_npm_package",
  "review_upstream_changes",
  "pull_upstream",
  "git_commit",
  "git_push",
  "git_branch",
  "git_clone",
  "create_skill",
  "remove_skill",
  "install_skill",
  "modify_heartbeat",
  "update_genesis_prompt",

  // ── Compute-budget introspection: the sim ledger (inference credits) is the
  //    OPERATOR's concern, not a trading input — it buys tokens, not coins.
  //    Exposing it made the agent conflate the two: it repeatedly stored facts
  //    like "available_credits $5.00" and wrote procedures that waited for
  //    "credits to reach $10" before buying, while $3,790 of trading cash sat
  //    idle. The numbers also go stale within the hour and then mislead.
  //    check_usdc_balance goes for the same reason (always 0 here, and USDC is
  //    not the paper-trading currency). The heartbeat's own credit check is
  //    unaffected — it reads ctx.creditBalance directly, not this tool — so
  //    low-credit wake/escalation behaviour still works.
  "check_credits",
  "check_usdc_balance",
]);

/**
 * Return `tools` filtered for the current mode. In sim solo mode the tools in
 * {@link SIM_DENIED_TOOLS} are dropped; otherwise the list is returned as-is.
 */
export function filterToolsForSim<T extends AutomatonTool>(tools: T[]): T[] {
  if (!isSimMode()) return tools;
  return tools.filter((t) => !SIM_DENIED_TOOLS.has(t.name));
}
