/**
 * Simulation Conway Client
 *
 * Implements the ConwayClient interface without a Conway account:
 * - exec / files / ports delegate to the real client's local fallback
 *   (empty sandboxId → local execution)
 * - credits are backed by the local simulation ledger
 * - sandbox creation and domain mutations are disabled
 * - identity registration succeeds locally (no network)
 */

import { createConwayClient } from "../conway/client.js";
import type {
  ConwayClient,
  PricingTier,
  CreditTransferResult,
  ModelInfo,
  SandboxInfo,
  DomainSearchResult,
  DnsRecord,
  DomainRegistration,
} from "../types.js";
import { getBalanceCents, applyDelta } from "./ledger.js";

const SIM_DISABLED =
  "Operation disabled in simulation mode: no real Conway account or funds. " +
  "It will become available when the automaton is funded with real money.";

export function createSimConwayClient(): ConwayClient {
  // Empty sandboxId → the real client executes locally (no network).
  // The apiUrl is never reached because every remote method is overridden.
  const local = createConwayClient({
    apiUrl: "http://sim.invalid",
    apiKey: "sim",
    sandboxId: "",
  });

  const client: ConwayClient = {
    exec: local.exec,
    writeFile: local.writeFile,
    readFile: local.readFile,
    exposePort: local.exposePort,
    removePort: local.removePort,

    createSandbox: async (): Promise<SandboxInfo> => {
      throw new Error(SIM_DISABLED);
    },
    deleteSandbox: async (): Promise<void> => {},
    listSandboxes: async (): Promise<SandboxInfo[]> => [],

    getCreditsBalance: async (): Promise<number> => getBalanceCents(),
    getCreditsPricing: async (): Promise<PricingTier[]> => [],
    transferCredits: async (
      toAddress: string,
      amountCents: number,
      note?: string,
    ): Promise<CreditTransferResult> => {
      const balanceAfterCents = applyDelta(
        -amountCents,
        `transfer to ${toAddress}${note ? `: ${note}` : ""}`,
      );
      return {
        transferId: `sim-${Date.now()}`,
        status: "simulated",
        toAddress,
        amountCents,
        balanceAfterCents,
      };
    },

    registerAutomaton: async () => ({
      automaton: { registered: "simulated" },
    }),

    searchDomains: async (): Promise<DomainSearchResult[]> => [],
    registerDomain: async (): Promise<DomainRegistration> => {
      throw new Error(SIM_DISABLED);
    },
    listDnsRecords: async (): Promise<DnsRecord[]> => [],
    addDnsRecord: async (): Promise<DnsRecord> => {
      throw new Error(SIM_DISABLED);
    },
    deleteDnsRecord: async (): Promise<void> => {
      throw new Error(SIM_DISABLED);
    },

    listModels: async (): Promise<ModelInfo[]> => [],

    // Child sandboxes are disabled in simulation, so every scope is local.
    createScopedClient: (): ConwayClient => client,
  };

  return client;
}
