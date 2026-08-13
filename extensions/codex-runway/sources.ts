import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexUsageSnapshot, CodexUsageSource } from "./types";
import { clampPct } from "./core";

const DEFAULT_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const WHAM_URL = "https://chatgpt.com/backend-api/wham/usage";
// WHAM describes its actual window duration. Treat a primary window as the
// weekly allowance only when it is genuinely week-length, rather than trusting
// the field name (primary vs. secondary) to mean session vs. weekly.
const MIN_WEEKLY_WINDOW_SECONDS = 6 * 24 * 60 * 60;

interface CodexCredentials { access?: string; accountId?: string }

/**
 * Official Codex/ChatGPT quota adapter. The budget engine only depends on
 * CodexUsageSource, so this can be replaced by Codex CLI, CodexBar, or a
 * browser/API adapter without changing accounting calculations.
 */
export class WhamUsageSource implements CodexUsageSource {
  readonly name = "codex-wham";
  constructor(private readonly authFile = DEFAULT_AUTH_FILE, private readonly fetchFn: typeof fetch = fetch) {}

  async getUsage(signal?: AbortSignal): Promise<CodexUsageSnapshot | null> {
    let credentials: CodexCredentials | undefined;
    try {
      const auth = JSON.parse(await readFile(this.authFile, "utf8")) as Record<string, CodexCredentials>;
      credentials = auth["openai-codex"];
    } catch {
      throw new Error("Codex credentials are unavailable.");
    }
    if (!credentials?.access) throw new Error("Codex access credential is unavailable.");
    const headers: Record<string, string> = { Authorization: `Bearer ${credentials.access}` };
    if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
    const response = await this.fetchFn(WHAM_URL, { headers, signal });
    if (!response.ok) throw new Error(`Codex usage request failed (HTTP ${response.status}).`);
    const body = await response.json() as {
      rate_limit?: {
        secondary_window?: { used_percent?: number; reset_after_seconds?: number } | null;
        primary_window?: { used_percent?: number; reset_after_seconds?: number; limit_window_seconds?: number } | null;
      };
    };
    const secondary = body.rate_limit?.secondary_window;
    const primary = body.rate_limit?.primary_window;
    // Most accounts put the weekly limit in secondary_window. This account
    // puts its 604800-second (seven-day) allowance in primary_window instead.
    // The advertised window duration, not the field name, determines safety.
    const weekly = secondary ?? (
      Number(primary?.limit_window_seconds) >= MIN_WEEKLY_WINDOW_SECONDS ? primary : undefined
    );
    if (!weekly) throw new Error("Codex API did not publish a weekly-length quota window.");
    if (!Number.isFinite(weekly.used_percent) || !Number.isFinite(weekly.reset_after_seconds)) {
      throw new Error("Codex API returned an incomplete weekly quota window.");
    }
    const now = Date.now();
    return {
      remainingPct: clampPct(100 - Number(weekly.used_percent)),
      resetTimestamp: new Date(now + Number(weekly.reset_after_seconds) * 1000).toISOString(),
      fetchedAt: new Date(now).toISOString(),
      source: secondary ? this.name : `${this.name}-primary-weekly`,
    };
  }
}

/** A simple injection adapter for another extension, CLI wrapper, or test. */
export class CallbackUsageSource implements CodexUsageSource {
  constructor(readonly name: string, private readonly callback: (signal?: AbortSignal) => Promise<CodexUsageSnapshot | null>) {}
  getUsage(signal?: AbortSignal) { return this.callback(signal); }
}

/** Tries sources in order, permitting a future Codex CLI/CodexBar adapter. */
export class FallbackUsageSource implements CodexUsageSource {
  readonly name = "fallback";
  constructor(private readonly sources: CodexUsageSource[]) {}
  async getUsage(signal?: AbortSignal): Promise<CodexUsageSnapshot | null> {
    const failures: string[] = [];
    for (const source of this.sources) {
      try {
        const result = await source.getUsage(signal);
        if (result) return result;
        failures.push(`${source.name}: no quota snapshot returned`);
      } catch (error) {
        failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(failures.join("; ") || "No Codex quota source is configured.");
  }
}
