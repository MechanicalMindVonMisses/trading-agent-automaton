/**
 * A snapshot of the tool names the agent can actually call this run.
 *
 * The tool list is assembled in loop.ts (builtins + sim trading tools +
 * installed tools, minus whatever sim mode denies), but individual tool
 * implementations in tools.ts have no way to see it — ToolContext carries the
 * db, conway and inference clients, not a registry. save_procedure needs it:
 * the model kept storing procedures whose steps referenced tools that do not
 * exist here ("pip", "nano", "vercel", "x402_fetch", "send_message"), and
 * recall_procedure then handed those back as if they were executable plans.
 * A cleanup pass had to delete 65 of 121 stored procedures on those grounds.
 *
 * loop.ts publishes the filtered list here once; save_procedure reads it to
 * reject unexecutable steps at write time instead of letting them accumulate.
 */

let availableToolNames: ReadonlySet<string> = new Set<string>();

/** Publish the tool names available this run. Called once from loop.ts. */
export function setAvailableToolNames(names: Iterable<string>): void {
  availableToolNames = new Set<string>(names);
}

/** Tool names available this run; empty before loop.ts publishes them. */
export function getAvailableToolNames(): ReadonlySet<string> {
  return availableToolNames;
}
