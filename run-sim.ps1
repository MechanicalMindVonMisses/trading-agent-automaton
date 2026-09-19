# Starts the automaton in SIMULATION MODE (fake ledger, local Ollama inference).
# Usage:  .\run-sim.ps1            — start the agent
#         .\run-sim.ps1 -Status    — show status
#         .\run-sim.ps1 -Fund 5    — add $5 to the simulation ledger
param(
    [switch]$Status,
    [double]$Fund = 0
)

$env:HOME = $env:USERPROFILE
$env:AUTOMATON_SIM_MODE = "1"

# Agent shell commands are written for POSIX — run them through Git Bash.
$gitBash = "C:\Program Files\Git\bin\bash.exe"
if (Test-Path $gitBash) { $env:AUTOMATON_SHELL = $gitBash }

# Simulated inference pricing (USD per million tokens) — tune to taste.
# $env:AUTOMATON_SIM_INPUT_USD_PER_M = "1.0"
# $env:AUTOMATON_SIM_OUTPUT_USD_PER_M = "4.0"

# Large local models on limited VRAM generate slowly — allow 5 minutes.
$env:AUTOMATON_INFERENCE_TIMEOUT_MS = "300000"

# Per-task wall-clock budget across ALL turns (base-harness). Default is only
# 5 min, which 14b blows through in a couple of turns. Give tasks room to finish.
$env:AUTOMATON_TASK_TIMEOUT_MS = "1800000"   # 30 minutes — tune as needed

Set-Location $PSScriptRoot

if ($Status) {
    node dist/index.js --status
} elseif ($Fund -gt 0) {
    node dist/index.js --sim-fund $Fund
} else {
    node dist/index.js --run
}
