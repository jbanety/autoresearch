// guardrails — wires the ported Claude hooks to pi's extension event system.
//
// Claude event        → pi event              → hooks
// PreToolUse (Bash)   → tool_call "bash"      → scout-block, privacy-block, dangerous-cmd-block
// PreToolUse (R/W/E)  → tool_call read/write  → scout-block, privacy-block
// UserPromptSubmit    → before_agent_start    → iteration-context, dev-rules-reminder (inject message)
// UserPromptSubmit    → input                 → simplify-gate (block/warn shipping verbs)
// SessionStart        → session_start         → session-init (persist state)
// SessionEnd          → session_shutdown      → stop-notify (notify + cleanup)
//
// All hooks fail open: a guardrail malfunction never blocks legitimate work.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import { checkDangerousCommand } from "./hooks/dangerous-cmd-block.js";
import { checkBashCommand, checkStructuredPath } from "./hooks/scout-block.js";
import {
  checkBashSensitive,
  checkStructuredSensitive,
  resolveConfirm,
} from "./hooks/privacy-block.js";
import { buildIterationContext } from "./hooks/iteration-context.js";
import { buildDevRules } from "./hooks/dev-rules-reminder.js";
import { checkSimplifyGate, surfaceWarning } from "./hooks/simplify-gate.js";
import { runStopNotify } from "./hooks/stop-notify.js";
import {
  isHookEnabled,
  loadSessionState,
  log,
  pruneStaleSessionFiles,
  saveSessionState,
} from "./lib/session-state.js";
import { execSync } from "node:child_process";
import { join } from "node:path";

const SESSION_INIT = "session-init";

function resolveGitRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      timeout: 5000,
      cwd,
    }).trim();
  } catch {
    return cwd;
  }
}

function resolveGitBranch(cwd: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      timeout: 5000,
      cwd,
    }).trim();
  } catch {
    return "";
  }
}

function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() || "unknown";
}

// session_start → session-init
function onSessionStart(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!isHookEnabled(SESSION_INIT)) return;
    try {
      const cwd = ctx.cwd;
      const sessionId = getSessionId(ctx);
      const projectRoot = resolveGitRoot(cwd);
      const gitBranch = resolveGitBranch(cwd);

      const state = {
        projectRoot,
        plansPath: join(projectRoot, "plans"),
        reportsPath: join(projectRoot, "plans", "reports"),
        gitBranch,
        sessionId,
        iterationCount: 0,
        startedAt: new Date().toISOString(),
      };
      saveSessionState(cwd, sessionId, state);
      pruneStaleSessionFiles();
      log(SESSION_INIT, { projectRoot, gitBranch });
    } catch {
      // fail-open
    }
  });
}

// session_shutdown → stop-notify
function onSessionShutdown(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const sessionId = getSessionId(ctx);
    await runStopNotify(cwd, sessionId);
  });
}

// tool_call → scout-block + privacy-block + dangerous-cmd-block
function onToolCall(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;

    // --- bash tool ---
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command as string;

      // dangerous-cmd-block (highest priority — hard block)
      const dangerous = checkDangerousCommand(command);
      if (dangerous.block) {
        if (ctx.hasUI) ctx.ui.notify(dangerous.reason || "Blocked", "error");
        return { block: true, reason: dangerous.reason };
      }

      // scout-block (.ckignore)
      const scout = checkBashCommand(command, cwd);
      if (scout.block) {
        if (ctx.hasUI) ctx.ui.notify(scout.reason || "Blocked", "error");
        return { block: true, reason: scout.reason };
      }

      // privacy-block (sensitive file → confirm; ambiguous → warn)
      const privacy = checkBashSensitive(command);
      if (privacy.warning && ctx.hasUI) {
        ctx.ui.notify(privacy.warning, "warning");
      }
      const resolved = await resolveConfirm(privacy, ctx);
      if (resolved.block) {
        return { block: true, reason: resolved.reason };
      }
      return;
    }

    // --- structured path tools: read / write / edit ---
    const pathTools = ["read", "write", "edit"] as const;
    for (const name of pathTools) {
      if (isToolCallEventType(name, event)) {
        const filePath = (event.input.path as string) || "";

        // scout-block (.ckignore)
        const scout = checkStructuredPath(filePath, cwd);
        if (scout.block) {
          if (ctx.hasUI) ctx.ui.notify(scout.reason || "Blocked", "error");
          return { block: true, reason: scout.reason };
        }

        // privacy-block (sensitive file → confirm)
        const privacy = checkStructuredSensitive(filePath);
        const resolved = await resolveConfirm(privacy, ctx);
        if (resolved.block) {
          return { block: true, reason: resolved.reason };
        }
        return;
      }
    }

    return;
  });
}

// before_agent_start → iteration-context + dev-rules-reminder (inject message)
function onBeforeAgentStart(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;
    const sessionId = getSessionId(ctx);
    const prompt = event.prompt || "";

    const parts: string[] = [];

    const iter = buildIterationContext(cwd, sessionId, prompt);
    if (iter.text) parts.push(iter.text);

    const dev = buildDevRules(cwd, sessionId);
    if (dev.text) parts.push(dev.text);

    if (parts.length === 0) return;

    return {
      message: {
        customType: "autoresearch-context",
        content: parts.join("\n\n"),
        display: false,
      },
    };
  });
}

// input → simplify-gate (block/warn shipping verbs)
function onInput(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const result = checkSimplifyGate(event.text, ctx.cwd);
    surfaceWarning(result, ctx);

    if (result.block) {
      if (ctx.hasUI) ctx.ui.notify(result.reason || "Blocked", "error");
      return { action: "handled" };
    }

    return { action: "continue" };
  });
}

export function registerGuardrails(pi: ExtensionAPI): void {
  onSessionStart(pi);
  onSessionShutdown(pi);
  onToolCall(pi);
  onBeforeAgentStart(pi);
  onInput(pi);
}

// Re-export for tests / direct use.
export { loadSessionState };
