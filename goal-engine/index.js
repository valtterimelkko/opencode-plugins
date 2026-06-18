/**
 * Goal Engine — Autonomous Multi-Turn Goal Execution for OpenCode
 *
 * Defines a verifiable objective that the agent will keep working toward across
 * multiple turns until the goal is achieved, paused, or cleared.
 *
 * State is session-scoped via per-session disk files so goals never leak
 * across concurrent sessions.
 *
 * Usage — call the goal_engine tool with:
 *   action: "start"      — Begin a new autonomous goal (requires: objective)
 *   action: "pause"      — Pause gracefully after current step
 *   action: "pause_now"  — Immediately pause
 *   action: "resume"     — Resume a paused goal
 *   action: "clear"      — Abandon current goal (requires: confirmed: true)
 *   action: "status"     — Get current goal status
 *   action: "report"     — Get detailed execution report
 *   action: "set_limit"  — Set max agent runs (requires: max_turns)
 *
 * The plugin is also available on the web UI's Pi Web UI OpenCode path,
 * where the server reads per-session goal state files and surfaces
 * widget_content / extension_status events to the frontend.
 *
 * State files: ~/.opencode/goal-engine/<sessionID>.goal.json
 */

import { tool } from "@opencode-ai/plugin/tool";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

// ── Constants ──────────────────────────────────────────────────────────────

const GOAL_DIR = path.join(os.homedir(), ".opencode", "goal-engine");
const DEFAULT_MAX_TURNS = 100;
const MAX_CONSECUTIVE_ERRORS = 3;
const CONTINUATION_DELAY_MS = 300;

// Minimum gap between two auto-continuations for the same session.
// Prevents duplicate continuations when multiple session.idle events arrive
// in quick succession from batched message completions.
const CONTINUATION_COOLDOWN_MS = 5_000;

const COMPLETION_PATTERNS = [
  /\bGOAL_ACHIEVED\b/i,
  /\bOBJECTIVE_ACHIEVED\b/i,
  /\ball tasks (?:are )?complete\b/i,
  /\bthe goal has been (?:fully )?achieved\b/i,
];

// ── Goal state ──────────────────────────────────────────────────────────────

const EMPTY_GOAL_STATE = {
  objective: "",
  planItems: [],
  planDone: [],
  status: "idle",
  turnCount: 0,
  startedAt: 0,
  completedAt: null,
  verifyCommand: null,
  maxTurns: DEFAULT_MAX_TURNS,
  progressCurrent: null,
  progressTotal: null,
  progressLabel: null,
  consecutiveErrors: 0,
  lastErrorMessage: null,
  lastErrorAt: null,
  compactionCount: 0,
  lastCompactedAt: null,
  lastCompactionTokens: null,
  lastCompactionEntryId: null,
  showWidget: true,
};

function normalizeGoalState(data) {
  return { ...EMPTY_GOAL_STATE, ...(data ?? {}) };
}

function isActiveGoal(gs) {
  return gs.status === "running" || gs.status === "wrapping-up";
}

function goalStatePath(sessionID) {
  return path.join(GOAL_DIR, `${sessionID}.goal.json`);
}

async function loadGoalState(sessionID) {
  try {
    const p = goalStatePath(sessionID);
    const raw = await fs.readFile(p, "utf-8");
    return normalizeGoalState(JSON.parse(raw));
  } catch {
    return { ...EMPTY_GOAL_STATE };
  }
}

async function saveGoalState(sessionID, gs) {
  const p = goalStatePath(sessionID);
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(normalizeGoalState(gs), null, 2), "utf-8");
  } catch {
    // Non-fatal: disk write failed
  }
}

async function removeGoalState(sessionID) {
  try {
    await fs.unlink(goalStatePath(sessionID));
  } catch {
    // Already gone
  }
}

// ── Goal prompt builder ────────────────────────────────────────────────────

export function stripWrappingQuotes(input) {
  const trimmed = input.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const quotePairs = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  const expectedLast = quotePairs[first];
  if (expectedLast && last === expectedLast) return trimmed.slice(1, -1).trim();
  if ((first === '"' || first === "“") && (last === '"' || last === "”")) return trimmed.slice(1, -1).trim();
  if ((first === "'" || first === "‘") && (last === "'" || last === "’")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

export function parseGoalStartOptions(input) {
  let working = input.trim();
  let verifyCommand = null;
  let maxTurns = DEFAULT_MAX_TURNS;

  working = working.replace(/\s+--verify\s+(?:"([^"]+)"|'([^']+)'|“([^”]+)”|(\S+))/g, (_all, dbl, single, smart, bare) => {
    verifyCommand = (dbl ?? single ?? smart ?? bare ?? "").trim() || null;
    return "";
  });

  working = working.replace(/\s+--max-turns\s+(\d+)/g, (_all, value) => {
    const parsed = Number(value);
    maxTurns = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TURNS;
    return "";
  });

  return {
    objective: stripWrappingQuotes(working),
    maxTurns,
    verifyCommand,
  };
}

function splitSubcommand(input) {
  const match = input.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { subcommand: (match?.[1] ?? "").toLowerCase(), rest: (match?.[2] ?? "").trim() };
}

function parseStatusMode(input) {
  const mode = input.trim().toLowerCase();
  if (mode === "show") return "show";
  if (mode === "hide" || mode === "off" || mode === "clear") return "hide";
  return "toggle";
}

export function parseSlashGoalCommand(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/goal")) return { kind: "none" };
  const rest = trimmed.slice(5).trim();
  if (!rest) return { kind: "status", mode: "toggle" };

  const { subcommand, rest: subRest } = splitSubcommand(rest);
  switch (subcommand) {
    case "status":
      return { kind: "status", mode: parseStatusMode(subRest) };
    case "report":
      return { kind: "report" };
    case "list":
      return { kind: "list" };
    case "pause":
      return { kind: "tool", action: "pause" };
    case "pause-now":
    case "pause_now":
      return { kind: "tool", action: "pause_now" };
    case "resume":
      return { kind: "tool", action: "resume" };
    case "resume-last":
    case "resume_last":
      return { kind: "tool", action: "resume_last" };
    case "clear":
      return { kind: "tool", action: "clear", confirmed: true };
    case "limit":
      return { kind: "tool", action: "set_limit", maxTurns: Number(subRest.trim()) };
    case "start":
      return { kind: "start", options: parseGoalStartOptions(subRest) };
    default:
      return { kind: "start", options: parseGoalStartOptions(rest) };
  }
}

async function findMostRecentGoal() {
  const candidates = [];
  try {
    const entries = await fs.readdir(GOAL_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".goal.json")) continue;
      const filePath = path.join(GOAL_DIR, entry.name);
      try {
        const [stat, raw] = await Promise.all([fs.stat(filePath), fs.readFile(filePath, "utf-8")]);
        const goal = normalizeGoalState(JSON.parse(raw));
        if (!goal.objective || goal.status === "idle") continue;
        candidates.push({ filePath, goal, updatedAt: stat.mtimeMs });
      } catch {
        // Skip unreadable goal files.
      }
    }
  } catch {
    return null;
  }

  candidates.sort((a, b) => (b.goal.startedAt || b.updatedAt) - (a.goal.startedAt || a.updatedAt));
  return candidates[0] ?? null;
}

function buildGoalPrompt(gs) {
  const parts = [];
  parts.push("## Active Goal");
  parts.push("");
  parts.push("You are working autonomously toward a defined objective.");
  parts.push("You will continue across MULTIPLE TURNS until it is fully achieved.");
  parts.push("");
  parts.push("### Objective");
  parts.push(gs.objective);

  if (gs.planItems.length > 0) {
    parts.push("");
    parts.push("### Plan");
    for (let i = 0; i < gs.planItems.length; i++) {
      const check = gs.planDone[i] ? "✓" : "☐";
      parts.push(`${check} ${gs.planItems[i]}`);
    }
  }

  parts.push("");
  parts.push("### Rules");
  parts.push("- Do NOT accept proxy signals. Only consider the objective achieved");
  parts.push("  when you have verified it yourself.");
  parts.push("- Treat uncertainty as NOT achieved. If unsure, keep working.");
  if (gs.verifyCommand) {
    parts.push(`- A verification command is configured: ${gs.verifyCommand}`);
    parts.push("  Only signal completion after your own checks indicate this command should pass.");
  }
  parts.push("- At the END of this turn, state one of:");
  parts.push('  • "**Status: CONTINUING**" — more work is needed');
  parts.push('  • "**Status: GOAL_ACHIEVED**" — the objective has been fully met');
  parts.push("- Include concise progress in a parseable form when possible, e.g. 'Progress: 3/10'.");
  parts.push("- Update your structured summary to reflect current progress.");
  parts.push("- If context has been compacted, re-read key files before continuing.");
  parts.push("");
  parts.push("### Current State");
  parts.push(
    `Agent run ${gs.turnCount + 1} — ${gs.turnCount === 0 ? "Starting now." : "Continue from where you left off."}`,
  );
  if (gs.maxTurns !== null) parts.push(`Max agent runs before pausing: ${gs.maxTurns}`);
  if (gs.progressCurrent !== null && gs.progressTotal !== null) {
    parts.push(`${gs.progressLabel ?? "Progress"}: ${gs.progressCurrent}/${gs.progressTotal}`);
  }
  if (gs.compactionCount > 0) parts.push(`Compactions so far: ${gs.compactionCount}`);

  return parts.join("\n");
}

// ── Status/report formatting ───────────────────────────────────────────────

const STATUS_LABELS = {
  idle: "Idle",
  running: "▶ Running",
  "wrapping-up": "⏸ Wrapping up…",
  paused: "⏸ Paused",
};

function formatStatusLines(gs) {
  const lines = [];
  lines.push(`🎯 Goal Status`);
  lines.push(`Status: ${STATUS_LABELS[gs.status] || gs.status}`);
  lines.push(`Objective: ${gs.objective}`);
  lines.push(`Started: ${gs.startedAt ? new Date(gs.startedAt).toLocaleString() : "n/a"}`);
  lines.push(`Agent runs: ${gs.turnCount}`);
  if (gs.maxTurns !== null) lines.push(`Max runs: ${gs.maxTurns}`);

  if (gs.progressCurrent !== null && gs.progressTotal !== null) {
    const label = gs.progressLabel ?? "Progress";
    lines.push(`${label}: ${gs.progressCurrent}/${gs.progressTotal}`);
  }

  if (gs.verifyCommand) lines.push(`Verification: ${gs.verifyCommand}`);

  if (gs.compactionCount > 0) {
    lines.push(`Compactions: ${gs.compactionCount}`);
    if (gs.lastCompactedAt) lines.push(`Last compaction: ${new Date(gs.lastCompactedAt).toLocaleString()}`);
    if (gs.lastCompactionTokens !== null && gs.lastCompactionTokens !== undefined) lines.push(`Last compacted tokens: ${gs.lastCompactionTokens}`);
  }

  if (gs.consecutiveErrors > 0 || gs.lastErrorMessage) {
    lines.push(`Consecutive errors: ${gs.consecutiveErrors}`);
    if (gs.lastErrorMessage) lines.push(`Last error: ${gs.lastErrorMessage}`);
    if (gs.lastErrorAt) lines.push(`Last error at: ${new Date(gs.lastErrorAt).toLocaleString()}`);
  }

  if (gs.planItems.length > 0) {
    lines.push("");
    lines.push("Plan:");
    for (let i = 0; i < gs.planItems.length; i++) {
      lines.push(`  ${gs.planDone[i] ? "✓" : "☐"} ${gs.planItems[i]}`);
    }
  }

  if (gs.completedAt) {
    lines.push("");
    lines.push(`Completed: ${new Date(gs.completedAt).toLocaleString()}`);
  }

  return lines;
}

function formatReport(gs) {
  if (!gs.objective) return "No goal has been recorded in this session.";
  const lines = formatStatusLines(gs);
  lines[0] = "🎯 Goal Report";
  return lines.join("\n");
}

// ── Completion detection ───────────────────────────────────────────────────

function isGoalAchieved(text) {
  if (!text || text.length < 5) return false;
  return COMPLETION_PATTERNS.some((p) => p.test(text));
}

// ── Progress parsing ───────────────────────────────────────────────────────

function parseProgress(text) {
  const patterns = [
    { regex: /species completed:\s*(\d+)\s*\/\s*(\d+)/i, label: "Species" },
    { regex: /completed:\s*(\d+)\s*\/\s*(\d+)/i, label: "Progress" },
    { regex: /progress:\s*(\d+)\s*\/\s*(\d+)/i, label: "Progress" },
    { regex: /\b(\d+)\s+of\s+(\d+)\b/i, label: "Progress" },
  ];
  for (const { regex, label } of patterns) {
    const match = text.match(regex);
    if (!match) continue;
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
      return { current, total, label };
    }
  }
  return null;
}

function parseChecklist(text) {
  const items = [];
  const done = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!match) continue;
    items.push(match[2].trim());
    done.push(match[1].toLowerCase() === "x");
  }
  return { items, done };
}

function updateProgressFromText(gs, text) {
  const progress = parseProgress(text);
  if (progress) {
    gs.progressCurrent = progress.current;
    gs.progressTotal = progress.total;
    gs.progressLabel = progress.label;
  }
  const checklist = parseChecklist(text);
  if (checklist.items.length > 0) {
    gs.planItems = checklist.items;
    gs.planDone = checklist.done;
  }
}

// ── Verification ───────────────────────────────────────────────────────────

async function verifyCompletion(verifyCommand) {
  if (!verifyCommand) return { ok: true, message: "No verification command." };
  try {
    // Use bash explicitly — the default /bin/sh (dash on Debian/Ubuntu) does not
    // support bash-isms like process substitution or some quoting patterns.
    await execFileAsync("/bin/bash", ["-c", verifyCommand], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, message: "Verification passed." };
  } catch (err) {
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    return { ok: false, message: output || String(err) };
  }
}

// ── Auto-continuation logic ────────────────────────────────────────────────

async function processAgentEnd(sessionID, gs, lastText, client, errorCounters, lastContinuationAt) {
  const currentErrors = errorCounters.get(sessionID) ?? 0;

  // Detect empty-turn (likely abort or immediate error with no output)
  const hasOutput = lastText.trim().length > 0;

  if (!hasOutput && gs.status === "running") {
    // Treat as abort/pause: don't continue
    gs.status = "paused";
    gs.lastErrorMessage = "Agent run produced no output — paused.";
    gs.lastErrorAt = Date.now();
    errorCounters.set(sessionID, 0);
    gs.consecutiveErrors = 0;
    await saveGoalState(sessionID, gs);
    return;
  }

  // Count this as a run if there was output
  if (hasOutput) {
    gs.turnCount += 1;
    updateProgressFromText(gs, lastText);
  }

  // Check for goal achievement
  if (isGoalAchieved(lastText)) {
    if (gs.verifyCommand) {
      const verification = await verifyCompletion(gs.verifyCommand);
      if (!verification.ok) {
        gs.lastErrorMessage = `Verification failed: ${verification.message}`;
        gs.lastErrorAt = Date.now();
        const newErrors = currentErrors + 1;
        errorCounters.set(sessionID, newErrors);
        gs.consecutiveErrors = newErrors;
        if (newErrors >= MAX_CONSECUTIVE_ERRORS) {
          gs.status = "paused";
          await saveGoalState(sessionID, gs);
          return;
        }
        await saveGoalState(sessionID, gs);
        await queueContinuation(sessionID, client, lastContinuationAt);
        return;
      }
    }
    gs.status = "idle";
    gs.completedAt = Date.now();
    gs.consecutiveErrors = 0;
    errorCounters.set(sessionID, 0);
    await saveGoalState(sessionID, gs);
    return;
  }

  // Handle wrapping-up → pause
  if (gs.status === "wrapping-up") {
    gs.status = "paused";
    gs.consecutiveErrors = 0;
    errorCounters.set(sessionID, 0);
    await saveGoalState(sessionID, gs);
    return;
  }

  // Reset error counter on successful run
  errorCounters.set(sessionID, 0);
  gs.consecutiveErrors = 0;

  // Check max turns
  if (gs.maxTurns !== null && gs.turnCount >= gs.maxTurns) {
    gs.status = "paused";
    await saveGoalState(sessionID, gs);
    return;
  }

  await saveGoalState(sessionID, gs);
  await queueContinuation(sessionID, client, lastContinuationAt);
}

async function queueContinuation(sessionID, client, lastContinuationAt) {
  await new Promise((resolve) => setTimeout(resolve, CONTINUATION_DELAY_MS));

  // Re-read fresh state to check goal wasn't paused/cleared in the interim
  const fresh = await loadGoalState(sessionID);
  if (!fresh || fresh.status !== "running") return;

  try {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "text",
            text: "Continue working toward the goal. Report your progress and state whether the objective has been fully achieved.",
          },
        ],
      },
    });
    // Record the time of this successful continuation so the cooldown check in
    // the event hook can suppress duplicate idle events from the same batch.
    lastContinuationAt.set(sessionID, Date.now());
  } catch (err) {
    console.error("[goal-engine] Failed to send continuation message:", err?.message ?? err);
  }
}

// ── Plugin entry point ──────────────────────────────────────────────────────

export default async function GoalEnginePlugin(input) {
  const client = input.client;

  // Per-session text accumulation (for completion detection)
  const sessionText = new Map(); // sessionID -> accumulated assistant text
  const errorCounters = new Map(); // sessionID -> consecutive error count
  // Sessions where we're actively processing an agent_end (prevent concurrent double-fire)
  const processingEnd = new Set();
  // Timestamps of the last continuation sent per session (prevent sequential double-fire
  // when batched message completions emit multiple session.idle events in quick succession)
  const lastContinuationAt = new Map(); // sessionID -> ms timestamp

  return {
    // ── Tools ────────────────────────────────────────────────────────────
    tool: {
      goal_engine: tool({
        description: `Manage autonomous goals. The goal engine drives the agent to keep working toward an objective across multiple turns.

Actions:
- start: Begin working autonomously toward an objective. Required: objective. Optional: max_turns (default 100), verify_command (shell command that must pass for completion).
- pause: Gracefully pause after the current step completes (sets status to wrapping-up).
- pause_now: Immediately pause (takes effect next turn).
- resume: Resume a paused goal.
- clear: Abandon/clear the current goal. Must pass confirmed: true.
- status: Get current goal status and progress.
- report: Get detailed execution report.
- set_limit: Update max agent runs. Required: max_turns.

When an active goal exists, the system prompt is automatically injected with the objective, rules, and current state. After each turn, the plugin checks the assistant's output for "Status: GOAL_ACHIEVED" to detect completion.`,
        args: {
          action: tool.schema.enum([
            "start",
            "pause",
            "pause_now",
            "resume",
            "clear",
            "status",
            "report",
            "set_limit",
            "resume_last",
          ]),
          objective: tool.schema
            .string()
            .optional()
            .describe("Goal objective text (for start)"),
          max_turns: tool.schema
            .number()
            .optional()
            .describe("Maximum agent runs before auto-pause (for start or set_limit)"),
          verify_command: tool.schema
            .string()
            .optional()
            .describe("Shell command that must exit 0 before completion is accepted (for start)"),
          confirmed: tool.schema
            .boolean()
            .optional()
            .describe("Must be true for destructive actions like clear"),
          status_mode: tool.schema.enum(["toggle", "show", "hide"])
            .optional()
            .describe("Display mode for status/widget visibility"),
        },
        async execute(args, ctx) {
          const sessionID = ctx.sessionID;
          let gs = await loadGoalState(sessionID);

          switch (args.action) {
            case "start": {
              const objective = (args.objective ?? "").trim();
              if (!objective) {
                return {
                  output:
                    "Error: objective is required for start. Example: goal_engine(action='start', objective='Refactor the auth module')",
                  metadata: { error: true },
                };
              }

              if (isActiveGoal(gs)) {
                return {
                  output: `Error: A goal is already ${gs.status}: "${gs.objective.slice(0, 60)}". Use goal_engine(action='clear', confirmed=true) first, or goal_engine(action='pause') to pause it.`,
                  metadata: { error: true, existing_status: gs.status },
                };
              }

              const newGs = {
                ...EMPTY_GOAL_STATE,
                objective,
                status: "running",
                startedAt: Date.now(),
                verifyCommand: args.verify_command ?? null,
                maxTurns:
                  args.max_turns != null && args.max_turns > 0
                    ? Math.floor(args.max_turns)
                    : DEFAULT_MAX_TURNS,
              };
              errorCounters.set(sessionID, 0);
              await saveGoalState(sessionID, newGs);

              return {
                output: `🎯 Goal started: "${objective.slice(0, 80)}${objective.length > 80 ? "…" : ""}"\n\nBegin working toward this objective now. Start by exploring the codebase/environment, understanding what needs to change, and creating a plan. Then execute systematically, verifying progress at each step.\n\nAt the end of each response, state:\n• "Status: CONTINUING" — if more work is needed\n• "Status: GOAL_ACHIEVED" — when the objective is fully met`,
                metadata: { started: true, objective },
              };
            }

            case "pause": {
              if (gs.status === "paused") {
                return { output: "Goal is already paused. Use goal_engine(action='resume') to continue.", metadata: {} };
              }
              if (gs.status === "wrapping-up") {
                return { output: "Goal is already pausing after the current run.", metadata: {} };
              }
              if (gs.status !== "running") {
                return { output: `No active goal to pause (status: ${gs.status}).`, metadata: { error: true } };
              }
              gs.status = "wrapping-up";
              await saveGoalState(sessionID, gs);
              return {
                output: "⏸ Goal pausing — will stop after this run completes. Use goal_engine(action='resume') to continue.",
                metadata: { status: "wrapping-up" },
              };
            }

            case "pause_now": {
              if (gs.status === "idle" || !gs.objective) {
                return { output: `No active goal to pause (status: ${gs.status}).`, metadata: { error: true } };
              }
              if (gs.status === "paused") {
                return { output: "Goal is already paused.", metadata: {} };
              }
              gs.status = "paused";
              await saveGoalState(sessionID, gs);
              return {
                output: "⏸ Goal paused immediately. Use goal_engine(action='resume') to continue.",
                metadata: { status: "paused" },
              };
            }

            case "resume": {
              if (gs.status !== "paused") {
                return {
                  output: `No paused goal to resume (status: ${gs.status}). Use goal_engine(action='start', objective='...') to start a new goal.`,
                  metadata: { error: true },
                };
              }
              gs.status = "running";
              gs.consecutiveErrors = 0;
              errorCounters.set(sessionID, 0);
              await saveGoalState(sessionID, gs);
              return {
                output: `▶ Goal resumed: "${gs.objective.slice(0, 60)}${gs.objective.length > 60 ? "…" : ""}" (Run ${gs.turnCount + 1})\n\nContinue from where you left off. Report progress and state whether the objective has been fully achieved.`,
                metadata: { resumed: true },
              };
            }

            case "resume_last": {
              if (isActiveGoal(gs)) {
                return { output: "A goal is already active in this session.", metadata: { error: true } };
              }
              const found = await findMostRecentGoal();
              if (!found || !found.goal.objective || found.goal.status === "idle") {
                return { output: "No resumable disk-persisted goal found.", metadata: {} };
              }
              const resumed = { ...found.goal, status: "running", consecutiveErrors: 0 };
              errorCounters.set(sessionID, 0);
              await saveGoalState(sessionID, resumed);
              return {
                output: `▶ Resuming last persisted goal: "${resumed.objective.slice(0, 60)}${resumed.objective.length > 60 ? "…" : ""}"\n\nRe-read key files, reconstruct progress, and continue from the latest verified state.`,
                metadata: { resumed: true, source: found.filePath },
              };
            }

            case "clear": {
              if (gs.status === "idle" || !gs.objective) {
                return { output: "No active goal to clear.", metadata: {} };
              }
              if (!args.confirmed) {
                return {
                  output: `To clear the goal "${gs.objective.slice(0, 60)}${gs.objective.length > 60 ? "…" : ""}" (${gs.turnCount} runs), call goal_engine(action='clear', confirmed=true).`,
                  metadata: { requiresConfirmation: true },
                };
              }
              await removeGoalState(sessionID);
              errorCounters.set(sessionID, 0);
              return { output: "🗑 Goal cleared.", metadata: { cleared: true } };
            }

            case "status": {
              if (gs.status === "idle" || !gs.objective) {
                return {
                  output: "No active goal. Use goal_engine(action='start', objective='...') to start one.",
                  metadata: { status: "idle" },
                };
              }
              if (args.status_mode === "show") gs.showWidget = true;
              else if (args.status_mode === "hide") gs.showWidget = false;
              else if (args.status_mode === "toggle") gs.showWidget = gs.showWidget === false;
              if (args.status_mode) await saveGoalState(sessionID, gs);
              return {
                output: formatStatusLines(gs).join("\n"),
                metadata: { goalState: gs },
              };
            }

            case "report": {
              return {
                output: formatReport(gs),
                metadata: { goalState: gs },
              };
            }

            case "set_limit": {
              if (!gs.objective || gs.status === "idle") {
                return { output: "No active or paused goal to limit.", metadata: { error: true } };
              }
              const limit = args.max_turns;
              if (!limit || !Number.isFinite(limit) || limit <= 0) {
                return { output: "Error: max_turns must be a positive number.", metadata: { error: true } };
              }
              gs.maxTurns = Math.floor(limit);
              await saveGoalState(sessionID, gs);
              return { output: `Goal run limit set to ${gs.maxTurns}.`, metadata: { maxTurns: gs.maxTurns } };
            }

            default:
              return { output: `Unknown action: ${args.action}`, metadata: { error: true } };
          }
        },
      }),
    },

    // ── System prompt injection ───────────────────────────────────────────
    "experimental.chat.system.transform": async (transformInput, output) => {
      const sessionID = transformInput.sessionID;
      if (!sessionID) return;
      try {
        const gs = await loadGoalState(sessionID);
        if (isActiveGoal(gs)) {
          output.system.push(buildGoalPrompt(gs));
        }
      } catch {
        // Non-fatal
      }
    },

    // ── Raw event hook: accumulate text + detect session idle ─────────────
    event: async ({ event }) => {
      try {
        const props = event.properties ?? {};
        const sessionID =
          (props.sessionID ?? props.sessionId);
        if (!sessionID) return;

        // Accumulate the TAIL of assistant text during streaming.
        // We only need the last ~3000 chars to detect GOAL_ACHIEVED patterns —
        // accumulating the full turn output causes O(n²) string copies and
        // crushes CPU for long-running turns (each delta appended to a copy
        // of the entire accumulated string so far).
        if (
          event.type === "message.part.delta" &&
          props.field === "text" &&
          typeof props.delta === "string"
        ) {
          const existing = sessionText.get(sessionID) ?? "";
          const combined = existing + props.delta;
          sessionText.set(
            sessionID,
            combined.length > 3000 ? combined.slice(-3000) : combined,
          );
        }

        // Detect session idle → process agent end
        const isIdle =
          event.type === "session.idle" ||
          (event.type === "session.status" &&
            (props.status?.type === "idle" || props.status === "idle"));

        if (!isIdle) return;

        // Guard 1: suppress duplicate idle events from the same completion batch.
        // Multiple session.idle events can arrive sequentially (one per queued message)
        // within a second or two of each other; only the first should trigger continuation.
        const lastFired = lastContinuationAt.get(sessionID) ?? 0;
        if (Date.now() - lastFired < CONTINUATION_COOLDOWN_MS) return;

        // Guard 2: prevent concurrent processing for the same session.
        if (processingEnd.has(sessionID)) return;
        processingEnd.add(sessionID);

        try {
          const gs = await loadGoalState(sessionID);
          if (!isActiveGoal(gs)) {
            sessionText.delete(sessionID);
            return;
          }

          const lastText = sessionText.get(sessionID) ?? "";
          sessionText.delete(sessionID);

          await processAgentEnd(sessionID, gs, lastText, client, errorCounters, lastContinuationAt);
        } finally {
          processingEnd.delete(sessionID);
        }
      } catch (err) {
        console.error("[goal-engine] Error in event hook:", err?.message ?? err);
      }
    },

    // ── /goal slash-command emulation via chat.message hook ───────────────
    // OpenCode plugins cannot register slash commands from the server side,
    // so we intercept /goal messages and either:
    //  - For read-only commands (status, report): read the goal file directly
    //    and inject pre-formatted output — the LLM just echoes it, no tool call.
    //  - For mutations (start, pause, resume, clear): rewrite to an explicit
    //    tool-call directive the LLM executes.
    "chat.message": async (msgInput, output) => {
      try {
        const textPart = output.parts?.find((p) => p.type === "text");
        if (!textPart) return;
        const raw = textPart.text?.trim() ?? "";
        if (!raw.startsWith("/goal")) return;

        const command = parseSlashGoalCommand(raw);

        // ── Read-only: format directly, no tool call needed ────────────────
        if (command.kind === "status" || command.kind === "report" || command.kind === "list") {
          let gs = await loadGoalState(msgInput.sessionID).catch(() => ({ ...EMPTY_GOAL_STATE }));

          if (command.kind === "list") {
            const found = await findMostRecentGoal();
            const formatted = found?.goal?.objective ? formatReport(found.goal) : "No disk-persisted goal found.";
            textPart.text = `Output the following goal report exactly as shown, no extra commentary:\n\n${formatted}`;
            return;
          }

          if (!gs.objective) {
            textPart.text = `Output this text exactly:\n\nNo goal is active in this session.\n\nStart one with: /goal <your objective>`;
            return;
          }

          if (command.kind === "report") {
            const formatted = formatReport(gs);
            textPart.text = `Output the following goal report exactly as shown, no extra commentary:\n\n${formatted}`;
            return;
          }

          if (command.mode === "show") gs.showWidget = true;
          else if (command.mode === "hide") gs.showWidget = false;
          else gs.showWidget = gs.showWidget === false;
          await saveGoalState(msgInput.sessionID, gs);
          gs = await loadGoalState(msgInput.sessionID).catch(() => gs);

          const formatted = formatStatusLines(gs).join("\n");
          const widgetNote = gs.showWidget
            ? "(Web UI status panel: now visible)"
            : "(Web UI status panel: now hidden — type /goal status show to show it)";
          textPart.text = `Output the following goal status exactly as shown, no extra commentary:\n\n${formatted}\n\n${widgetNote}`;
          return;
        }

        // ── Mutations: instruct the LLM to call the goal_engine tool ───────
        let instruction;
        if (command.kind === "start") {
          const options = command.options;
          const toolArgs = [
            'action="start"',
            `objective=${JSON.stringify(options.objective)}`,
            `max_turns=${options.maxTurns}`,
          ];
          if (options.verifyCommand) toolArgs.push(`verify_command=${JSON.stringify(options.verifyCommand)}`);
          instruction = options.objective
            ? `Use the goal_engine tool now: ${toolArgs.join(", ")}. After calling it, immediately begin working on the goal.`
            : `Use the goal_engine tool: action="status". Display the result.`;
        } else if (command.kind === "tool") {
          if (command.action === "clear") {
            instruction = `Use the goal_engine tool now: action="clear", confirmed=true. Acknowledge the goal was cleared.`;
          } else if (command.action === "set_limit") {
            instruction = `Use the goal_engine tool now: action="set_limit", max_turns=${Number.isFinite(command.maxTurns) ? command.maxTurns : 0}. Acknowledge the new goal run limit.`;
          } else if (command.action === "resume_last") {
            instruction = `Use the goal_engine tool now: action="resume_last". If a persisted goal exists, resume it and continue working toward it immediately.`;
          } else {
            instruction = `Use the goal_engine tool now: action="${command.action}". Acknowledge the new goal state.`;
          }
        } else {
          instruction = `Use the goal_engine tool: action="status". Display the result.`;
        }

        textPart.text = instruction;
      } catch {
        // Non-fatal
      }
    },

    // ── Compaction: preserve goal context ─────────────────────────────────
    "experimental.session.compacting": async (compactInput, output) => {
      try {
        const sessionID = compactInput.sessionID;
        if (!sessionID) return;
        const gs = await loadGoalState(sessionID);
        if (!isActiveGoal(gs)) return;

        // Deduplicate: if the hook fires more than once for the same compaction
        // (observed in some OpenCode versions), skip the second firing.
        const now = Date.now();
        if (gs.lastCompactedAt && now - gs.lastCompactedAt < 10_000) return;

        gs.compactionCount += 1;
        gs.lastCompactedAt = now;
        const tokensBefore = compactInput?.preparation?.tokensBefore
          ?? compactInput?.compactionEntry?.tokensBefore
          ?? compactInput?.tokensBefore;
        const compactionEntryId = compactInput?.compactionEntry?.id ?? compactInput?.entryId ?? null;
        gs.lastCompactionTokens = Number.isFinite(tokensBefore) ? tokensBefore : null;
        gs.lastCompactionEntryId = typeof compactionEntryId === "string" ? compactionEntryId : null;
        await saveGoalState(sessionID, gs);

        output.context.push(buildGoalPrompt(gs));
        output.context.push(
          "CONTEXT COMPACTED. The conversation has been summarized.\n" +
            "Your goal is still active. Re-read any files you were working on before continuing.\n" +
            "The goal prompt will be re-injected with the current state.",
        );
      } catch {
        // Non-fatal
      }
    },
  };
}

