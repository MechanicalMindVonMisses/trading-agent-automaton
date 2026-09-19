/**
 * Simulation Setup
 *
 * Non-interactive first-run setup for simulation mode. Creates the
 * wallet, writes automaton.json with simulationMode enabled, installs
 * heartbeat/SOUL/skills defaults, and seeds the simulation ledger.
 * No network calls, no Conway account, no real money.
 *
 * Usage:
 *   automaton --sim-setup [--name <name>] [--genesis "<prompt>"]
 *             [--balance <usd>] [--ollama <url>] [--model <id>]
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "../identity/wallet.js";
import { createConfig, saveConfig, getConfigPath } from "../config.js";
import { writeDefaultHeartbeatConfig } from "../heartbeat/config.js";
import { generateSoulMd, installDefaultSkills } from "../setup/defaults.js";
import { initLedger, getLedgerPath } from "./ledger.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("sim.setup");

const DEFAULT_BALANCE_USD = 10;
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const FALLBACK_MODEL = "llama3.2:latest";

const DEFAULT_GENESIS =
  "You are a fledgling autonomous agent. Your compute costs money and " +
  "your credit balance is finite. Survive: manage your credits wisely, " +
  "explore your environment, keep notes about what you learn in your " +
  "memory, and look for ways to create value. Be curious but frugal.";

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  return value.startsWith("--") ? undefined : value;
}

async function detectOllamaModel(baseUrl: string): Promise<string> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      const first = data.models?.find((m) => m.name)?.name;
      if (first) {
        logger.info(`Detected Ollama model: ${first}`);
        return first;
      }
    }
  } catch {
    // fall through
  }
  logger.warn(
    `Ollama not reachable at ${baseUrl} — defaulting model to ${FALLBACK_MODEL}. ` +
      `Install Ollama and pull a model, or re-pick later with --pick-model.`,
  );
  return FALLBACK_MODEL;
}

/**
 * Write ~/.automaton/inference-providers.json enabling ONLY the local
 * (Ollama) provider. Without this file the orchestration worker path
 * defaults to OpenAI/Groq, which 401s in simulation mode (no real keys).
 */
export function writeSimProvidersFile(ollamaBaseUrl: string, model: string): void {
  const baseUrl = `${ollamaBaseUrl.replace(/\/$/, "")}/v1`;
  const modelFor = (tier: "reasoning" | "fast" | "cheap") => ({
    id: model,
    tier,
    contextWindow: 32768,
    maxOutputTokens: 8192,
    costPerInputToken: 0,
    costPerOutputToken: 0,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  });
  const providersConfig = {
    providers: [
      {
        id: "local",
        name: "Local (Ollama, simulation)",
        baseUrl,
        apiKeyEnvVar: "LOCAL_API_KEY",
        priority: 1,
        enabled: true,
        maxRequestsPerMinute: 100,
        maxTokensPerMinute: 500000,
        models: [modelFor("reasoning"), modelFor("fast"), modelFor("cheap")],
      },
    ],
    tierDefaults: {
      reasoning: { preferredProvider: "local", fallbackOrder: [] },
      fast: { preferredProvider: "local", fallbackOrder: [] },
      cheap: { preferredProvider: "local", fallbackOrder: [] },
    },
  };
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    path.join(dir, "inference-providers.json"),
    JSON.stringify(providersConfig, null, 2),
    { mode: 0o600 },
  );
}

export async function runSimSetup(args: string[]): Promise<void> {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    logger.error(
      `Config already exists at ${configPath}. ` +
        `Delete it (or the whole ${getAutomatonDir()} directory) to re-run sim setup.`,
    );
    process.exit(1);
  }

  const name = argValue(args, "--name") || "sim-automaton";
  const genesisPrompt = argValue(args, "--genesis") || DEFAULT_GENESIS;
  const balanceUsd = Number(argValue(args, "--balance") ?? DEFAULT_BALANCE_USD);
  if (!Number.isFinite(balanceUsd) || balanceUsd < 0) {
    logger.error("Invalid --balance value. Expected a non-negative USD amount.");
    process.exit(1);
  }
  const ollamaBaseUrl = argValue(args, "--ollama") || DEFAULT_OLLAMA_URL;
  const model = argValue(args, "--model") || (await detectOllamaModel(ollamaBaseUrl));

  const { chainIdentity } = await getWallet("evm");
  const walletAddress = chainIdentity.address;

  const config = createConfig({
    name,
    genesisPrompt,
    creatorAddress: walletAddress,
    registeredWithConway: false,
    sandboxId: "",
    walletAddress,
    apiKey: "sim_mode_key",
    ollamaBaseUrl,
  });

  config.simulationMode = true;
  config.inferenceModel = model;
  // Point the OpenAI-compatible "conway" endpoint at Ollama so any code
  // path that falls back to it (e.g. the orchestrator's provider bridge)
  // lands on the local model instead of the real Conway API.
  config.conwayApiUrl = ollamaBaseUrl;
  // Empty string (not undefined) so the saved key overrides the
  // DEFAULT_CONFIG relay URL on load — disables the social relay.
  config.socialRelayUrl = "";
  config.modelStrategy = {
    inferenceModel: model,
    lowComputeModel: model,
    criticalModel: model,
    maxTokensPerTurn: config.maxTokensPerTurn,
    hourlyBudgetCents: 0,
    sessionBudgetCents: 0,
    perCallCeilingCents: 0,
    enableModelFallback: true,
    anthropicApiVersion: "2023-06-01",
  };

  saveConfig(config);
  logger.info(`automaton.json written (${configPath})`);

  writeSimProvidersFile(ollamaBaseUrl, model);
  logger.info("inference-providers.json written (local-only)");

  writeDefaultHeartbeatConfig();
  logger.info("heartbeat.yml written");

  const automatonDir = getAutomatonDir();
  const constitutionSrc = path.join(process.cwd(), "constitution.md");
  const constitutionDst = path.join(automatonDir, "constitution.md");
  if (fs.existsSync(constitutionSrc)) {
    fs.copyFileSync(constitutionSrc, constitutionDst);
    fs.chmodSync(constitutionDst, 0o444);
    logger.info("constitution.md installed (read-only)");
  }

  const soulPath = path.join(automatonDir, "SOUL.md");
  fs.writeFileSync(
    soulPath,
    generateSoulMd(name, walletAddress, walletAddress, genesisPrompt),
    { mode: 0o600 },
  );
  logger.info("SOUL.md written");

  installDefaultSkills(config.skillsDir || "~/.automaton/skills");
  logger.info("Default skills installed");

  const ledger = initLedger(balanceUsd * 100);
  logger.info(
    `Simulation ledger seeded: $${(ledger.balanceCents / 100).toFixed(2)} (${getLedgerPath()})`,
  );

  logger.info(`
=== SIMULATION SETUP COMPLETE ===
Name:     ${name}
Wallet:   ${walletAddress}
Model:    ${model} (via Ollama at ${ollamaBaseUrl})
Balance:  $${balanceUsd.toFixed(2)} (simulated — no real money)

Start:    AUTOMATON_SIM_MODE=1 automaton --run
Fund:     automaton --sim-fund <usd>
=================================
`);
}
