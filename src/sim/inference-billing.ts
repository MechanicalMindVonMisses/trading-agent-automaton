/**
 * Simulation Inference Billing
 *
 * Wraps an InferenceClient and charges the simulation ledger per call
 * using configurable fake per-token pricing. Local (Ollama) inference
 * is free in reality, so this is what creates the economic pressure
 * the survival system is built around.
 *
 * Pricing is USD per million tokens, tunable via env:
 *   AUTOMATON_SIM_INPUT_USD_PER_M   (default 1.0)
 *   AUTOMATON_SIM_OUTPUT_USD_PER_M  (default 4.0)
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
} from "../types.js";
import { applyDelta } from "./ledger.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("sim.billing");

const DEFAULT_INPUT_USD_PER_M = 1.0;
const DEFAULT_OUTPUT_USD_PER_M = 4.0;

function envPrice(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Charge the simulation ledger for a single inference call's token usage.
 * Shared by the main-loop wrapper and the orchestration worker bridge.
 */
export function chargeSimTokens(
  inputTokens: number,
  outputTokens: number,
  label: string,
): void {
  const inputUsdPerM = envPrice(
    "AUTOMATON_SIM_INPUT_USD_PER_M",
    DEFAULT_INPUT_USD_PER_M,
  );
  const outputUsdPerM = envPrice(
    "AUTOMATON_SIM_OUTPUT_USD_PER_M",
    DEFAULT_OUTPUT_USD_PER_M,
  );
  const costCents =
    ((inputTokens / 1_000_000) * inputUsdPerM +
      (outputTokens / 1_000_000) * outputUsdPerM) *
    100;
  if (costCents > 0) {
    const balance = applyDelta(-costCents, label);
    logger.debug(
      `Charged ${costCents.toFixed(4)}c for ${inputTokens}+${outputTokens} tokens — balance ${(balance / 100).toFixed(2)} USD`,
    );
  }
}

export function withSimBilling(inner: InferenceClient): InferenceClient {
  return {
    chat: async (
      messages: ChatMessage[],
      opts?: InferenceOptions,
    ): Promise<InferenceResponse> => {
      const response = await inner.chat(messages, opts);
      chargeSimTokens(
        response.usage.promptTokens,
        response.usage.completionTokens,
        `inference:${response.model}`,
      );
      return response;
    },
    setLowComputeMode: (enabled: boolean): void => inner.setLowComputeMode(enabled),
    getDefaultModel: (): string => inner.getDefaultModel(),
  };
}
