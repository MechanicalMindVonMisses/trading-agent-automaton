import type { UnifiedInferenceClient } from "../inference/inference-client.js";
import type { ModelTier } from "../inference/provider-registry.js";
import type { InferenceToolCall } from "../types.js";
import type { WorkerInferenceClient } from "./harness-types.js";
import { chargeSimTokens } from "../sim/inference-billing.js";

export function createWorkerInferenceBridge(
  inference: Pick<UnifiedInferenceClient, "chat">,
): WorkerInferenceClient {
  return {
    chat: async (params) => {
      const response = await inference.chat({
        tier: normalizeTier(params.tier),
        messages: params.messages,
        tools: params.tools,
        toolChoice: params.toolChoice as any,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        responseFormat: normalizeResponseFormat(params.responseFormat),
      });

      // Simulation mode: worker inference bypasses the main billing
      // wrapper, so charge the fake ledger here.
      if (process.env.AUTOMATON_SIM_MODE === "1" && response.usage) {
        chargeSimTokens(
          response.usage.inputTokens,
          response.usage.outputTokens,
          "worker-inference",
        );
      }

      return {
        content: response.content,
        toolCalls: response.toolCalls as InferenceToolCall[] | undefined,
      };
    },
  };
}

function normalizeTier(tier: string | undefined): ModelTier {
  return tier === "reasoning" || tier === "cheap" || tier === "fast"
    ? tier
    : "fast";
}

function normalizeResponseFormat(
  responseFormat: { type: string } | undefined,
): { type: "json_object" | "text" } | undefined {
  if (!responseFormat) {
    return undefined;
  }

  return responseFormat.type === "json_object"
    ? { type: "json_object" }
    : { type: "text" };
}
