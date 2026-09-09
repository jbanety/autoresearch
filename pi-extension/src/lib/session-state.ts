// Session state persistence — ported from claude-plugin/hooks/lib/ar-hook-utils.cjs.
// In Claude, hooks received a session_id on stdin. In pi, we derive a stable
// hash from cwd + session id via ExtensionContext. State lives in the OS temp
// dir keyed by that hash, exactly like the original.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

export interface SessionState {
  projectRoot: string;
  plansPath: string;
  reportsPath: string;
  gitBranch: string;
  sessionId: string;
  iterationCount: number;
  startedAt?: string;
  lastContextInjection?: number;
}

const DEFAULT_STATE = (cwd: string, sessionId: string): SessionState => ({
  projectRoot: cwd,
  plansPath: join(cwd, "plans"),
  reportsPath: join(cwd, "plans", "reports"),
  gitBranch: "",
  sessionId,
  iterationCount: 0,
});

export function sessionHash(cwd: string, sessionId: string): string {
  return createHash("md5").update(`${cwd}:${sessionId}`).digest("hex").slice(0, 12);
}

export function sessionStatePath(cwd: string, sessionId: string): string {
  return join(tmpdir(), `ar-session-${sessionHash(cwd, sessionId)}.json`);
}

export function loadSessionState(cwd: string, sessionId: string): SessionState {
  try {
    const raw = readFileSync(sessionStatePath(cwd, sessionId), "utf8");
    return { ...DEFAULT_STATE(cwd, sessionId), ...JSON.parse(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return DEFAULT_STATE(cwd, sessionId);
  }
}

export function saveSessionState(cwd: string, sessionId: string, state: SessionState): void {
  writeFileSync(sessionStatePath(cwd, sessionId), JSON.stringify(state, null, 2));
}

export function incrementCounter(
  cwd: string,
  sessionId: string,
  field: keyof SessionState,
): number {
  const state = loadSessionState(cwd, sessionId);
  const next = ((state[field] as number) || 0) + 1;
  (state[field] as number) = next;
  saveSessionState(cwd, sessionId, state);
  return next;
}

export function cleanupSessionFile(cwd: string, sessionId: string): void {
  try {
    unlinkSync(sessionStatePath(cwd, sessionId));
  } catch {
    /* already gone */
  }
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function pruneStaleSessionFiles(): void {
  try {
    const now = Date.now();
    const tmp = tmpdir();
    for (const entry of readdirSync(tmp)) {
      if (!entry.startsWith("ar-session-") || !entry.endsWith(".json")) continue;
      const fp = join(tmp, entry);
      try {
        const stat = statSync(fp);
        if (now - stat.mtimeMs > SESSION_MAX_AGE_MS) unlinkSync(fp);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* tmp dir unreadable */
  }
}

// Bounded metadata-only runtime log, mirroring the original. Lives under the
// pi config dir (~/.pi/agent/hooks/.logs/<projectHash>/hook-log.jsonl). Raw
// paths, commands, tool inputs, and secrets are intentionally excluded.
export function log(hookName: string, entry: Record<string, unknown>): void {
  try {
    const cwd = process.cwd();
    const projectKey = createHash("md5").update(cwd).digest("hex").slice(0, 12);
    const logDir = join(homedir(), ".pi", "agent", "hooks", ".logs", projectKey);
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "hook-log.jsonl");
    const safeEntry: Record<string, unknown> = {};
    for (const key of [
      "action",
      "tool",
      "loc",
      "duration",
      "iterations",
      "category",
      "remediation",
      "matched",
    ]) {
      if (entry && typeof entry[key] !== "undefined") safeEntry[key] = entry[key];
    }
    const record = JSON.stringify({ ts: new Date().toISOString(), hook: hookName, ...safeEntry });
    appendFileSync(logPath, record + "\n");
  } catch {
    /* fail-open */
  }
}

export function isHookEnabled(hookName: string): boolean {
  const envKey = "AR_DISABLE_" + hookName.replace(/-/g, "_").toUpperCase();
  return !process.env[envKey];
}

export { homedir, basename, dirname, existsSync, readFileSync };
