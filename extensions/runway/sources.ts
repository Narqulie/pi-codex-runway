import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WeeklyUsageSnapshot, WeeklyUsageSource } from "./types";
import { knownWindow, projectWeekly, validateBinding } from "./quota";
import type { AccountBinding, AccountObservation, QuotaSource, QuotaWindow, TelemetryIssue, WindowScope } from "./quota";

const DEFAULT_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
export class TelemetryError extends Error {
  constructor(readonly issue: TelemetryIssue, message: string) { super(message); }
}
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function timestamp(value: unknown): string | undefined {
  const ms = finite(value) ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined;
}
function windowReading(id: string, label: string, raw: unknown, scope: WindowScope, durationSeconds: number | undefined, source: string, now: Date, claude = false): QuotaWindow {
  const value = object(raw);
  const used = claude ? value.utilization : value.used_percent;
  const absolute = timestamp(claude ? value.resets_at : value.reset_at);
  const relative = !claude && finite(value.reset_after_seconds) && value.reset_after_seconds >= 0 ? timestamp(now.getTime() / 1000 + value.reset_after_seconds) : undefined;
  const resetAt = absolute ?? relative;
  const valid = finite(used) && used >= 0 && used <= 100 && !!resetAt;
  return { id, label, scope, durationSeconds, usedPct: finite(used) && used >= 0 && used <= 100 ? used : undefined,
    resetAt, observedAt: now.toISOString(), source, revision: now.toISOString(), evidence: valid ? absolute ? "published" : "reconstructed" : "unavailable" };
}
/** All returned WHAM windows, with duration as identity rather than primary/secondary role.
 * Unknown durations/scopes remain unknown, never guessed as a weekly or model allowance. */
export function parseWhamUsage(body: unknown, account: AccountBinding, now = new Date()): AccountObservation {
  account = validateBinding(account);
  if (account.provider !== "openai-codex") throw new Error("WHAM requires an openai-codex binding.");
  const root = object(body), limits = object(root.rate_limit);
  const windows: QuotaWindow[] = [];
  const additional = root.additional_rate_limits;
  // An explicit null is a published absence. An omitted role is unknown.
  let inventoryComplete = Object.hasOwn(limits, "primary_window") && Object.hasOwn(limits, "secondary_window")
    && (additional == null || Array.isArray(additional));
  for (const [pool, raw, scope] of [["rate_limit", limits, { kind: "all" }],
    ...(Array.isArray(additional) ? additional.map((entry: unknown, index: number) => {
      const limit = object(entry);
      return [`additional:${typeof limit.limit_name === "string" ? limit.limit_name : index}`, object(limit.rate_limit), { kind: "unknown" }];
    }) : [])] as Array<[string, Record<string, any>, WindowScope]>) {
    if (!raw.primary_window && !raw.secondary_window) inventoryComplete = false;
    for (const role of ["primary_window", "secondary_window"]) {
      if (raw[role] == null) continue;
      const duration = object(raw[role]).limit_window_seconds;
      const seconds = finite(duration) && duration > 0 ? duration : undefined;
      const id = `${pool}:${seconds ?? role}`;
      const window = windowReading(id, `${pool} · ${seconds == null ? "duration unknown" : seconds === 18000 ? "5h" : seconds === 604800 ? "weekly" : `${seconds}s`}`, raw[role], scope, seconds, "codex-wham", now);
      window.providerLabel = role;
      // Duplicate durations cannot silently overwrite competing provider evidence.
      const duplicate = windows.find((entry) => entry.id === id);
      if (duplicate) { duplicate.scope = { kind: "unknown" }; window.id += `:${role}`; window.scope = { kind: "unknown" }; }
      windows.push(window);
    }
  }
  const complete = inventoryComplete && windows.every((window) => window.evidence !== "unavailable" && window.durationSeconds != null && window.scope.kind !== "unknown");
  return { account, windows, complete, issue: complete ? undefined : "partial", observedAt: now.toISOString(), source: "codex-wham", revision: now.toISOString() };
}
/** Unofficial telemetry shape; extra_usage is spend, not subscription percentage. */
export function parseClaudeUsage(body: unknown, account: AccountBinding, now = new Date()): AccountObservation {
  account = validateBinding(account);
  if (account.provider !== "anthropic") throw new Error("Claude telemetry requires an anthropic binding.");
  const root = object(body), windows: QuotaWindow[] = [];
  for (const key of ["five_hour", "seven_day", ...Object.keys(root).filter((key) => key.startsWith("seven_day_") && key !== "seven_day_breakdown")]) {
    if (root[key] == null && key !== "five_hour" && key !== "seven_day") continue;
    const family = key === "seven_day_sonnet" ? "sonnet" : key === "seven_day_opus" ? "opus" : undefined;
    const scope: WindowScope = key === "five_hour" || key === "seven_day" ? { kind: "all" } : family ? { kind: "models", families: [family] } : { kind: "unknown" };
    windows.push(windowReading(key, key.replaceAll("_", " "), root[key], scope, key === "five_hour" ? 18000 : 604800, "claude-oauth-usage", now, true));
  }
  if (Array.isArray(root.limits)) root.limits.forEach((raw: unknown, index: number) => {
    const value = object(raw);
    const namedId = value.kind === "session" ? "five_hour" : value.kind === "weekly_all" ? "seven_day" : undefined;
    const named = windows.find(window => window.id === namedId);
    // Published aliases are one window, but only when scope, usage and reset agree.
    if (value.scope === null && named && knownWindow(named) && value.percent === named.usedPct && timestamp(value.resets_at) === named.resetAt) return;
    const reading = value.weekly_scoped ?? { ...value, utilization: value.percent ?? value.utilization };
    windows.push(windowReading(`limits:${index}`, `additional limit ${index}`, reading, { kind: "unknown" }, undefined, "claude-oauth-usage", now, true));
  });
  // Inventory completeness is separate from row validity: an unreadable known
  // Sonnet-only row need not stop Opus when both all-model windows are present.
  const complete = root.five_hour != null && root.seven_day != null && (root.limits == null || Array.isArray(root.limits));
  const partial = !complete || windows.some((window) => window.evidence === "unavailable" || window.scope.kind === "unknown");
  return { account, windows, complete, issue: partial ? "partial" : undefined, observedAt: now.toISOString(), source: "claude-oauth-usage", revision: now.toISOString() };
}
async function fetchUsage(url: string, headers: Record<string, string>, fetchFn: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetchFn(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }); }
  catch { throw new TelemetryError("network", "Quota telemetry network request failed or was cancelled."); }
  if (!response.ok) {
    const issue = response.status === 401 ? "authentication" : response.status === 403 ? "permission" : response.status === 429 ? "throttled" : "network";
    throw new TelemetryError(issue, `Quota telemetry ${issue} (HTTP ${response.status}); ${issue === "permission" ? "check telemetry permission" : issue === "authentication" ? "repair authentication" : "retry later"}.`);
  }
  try { const body = await response.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new TelemetryError("malformed", "Quota telemetry returned malformed data."); }
}
export interface CodexCredentials { access?: string; accountId?: string }
export class WhamUsageSource implements QuotaSource, WeeklyUsageSource {
  readonly name = "codex-wham";
  constructor(private readonly options: { authFile?: string; credentials?: () => Promise<CodexCredentials>; fetchFn?: typeof fetch } = {}) {}
  async getObservation(signal?: AbortSignal): Promise<AccountObservation> {
    let credentials: CodexCredentials;
    try { credentials = this.options.credentials ? await this.options.credentials() : JSON.parse(await readFile(this.options.authFile ?? DEFAULT_AUTH_FILE, "utf8"))["openai-codex"]; }
    catch { throw new TelemetryError("authentication", "Codex credentials are unavailable."); }
    if (!credentials?.access) throw new TelemetryError("authentication", "Codex access credential is unavailable.");
    if (!credentials.accountId?.trim()) throw new TelemetryError("authentication", "Codex stable account binding is unavailable; repair authentication.");
    const account = { provider: "openai-codex", accountId: credentials.accountId };
    const body = await fetchUsage("https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${credentials.access}`, "ChatGPT-Account-Id": credentials.accountId }, this.options.fetchFn ?? fetch, signal);
    return parseWhamUsage(body, account);
  }
  async getUsage(signal?: AbortSignal): Promise<WeeklyUsageSnapshot> {
    const snapshot = projectWeekly(await this.getObservation(signal));
    if (!snapshot) throw new TelemetryError("partial", "Codex API did not publish one complete all-model weekly-length quota window.");
    return snapshot;
  }
}
export interface ClaudeTelemetryCredentials { accessToken: string; account: AccountBinding; verified: true; scopes: string[] }
/** Verify the existing grant's profile permission and subscription identity.
 * A quota belongs to an account in an organization, not to a bearer token. */
export async function claudeProfileCredentials(accessToken: string | undefined, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<ClaudeTelemetryCredentials> {
  if (!accessToken) throw new TelemetryError("authentication", "Existing Claude OAuth credential is unavailable.");
  const body = object(await fetchUsage("https://api.anthropic.com/api/oauth/profile",
    { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" }, fetchFn, signal));
  const accountId = object(body.account).uuid, organizationId = object(body.organization).uuid;
  if (typeof accountId !== "string" || !accountId.trim() || typeof organizationId !== "string" || !organizationId.trim()) {
    throw new TelemetryError("malformed", "Claude profile did not verify a stable account and organization binding.");
  }
  // Successful profile access is the permission evidence; no token introspection.
  return { accessToken, account: { provider: "anthropic", accountId: JSON.stringify([accountId, organizationId]) }, verified: true, scopes: ["user:profile"] };
}
/** Opt-in observer only. Caller supplies existing authorized credentials and verified binding.
 * No cookies, client impersonation or inference/billing integration. */
export class ClaudeUsageSource implements QuotaSource {
  readonly name = "claude-oauth-usage";
  constructor(private readonly options: { enabled: boolean; credentials: (signal?: AbortSignal) => Promise<ClaudeTelemetryCredentials>; fetchFn?: typeof fetch }) {}
  async getObservation(signal?: AbortSignal): Promise<AccountObservation> {
    if (!this.options.enabled) throw new TelemetryError("permission", "Claude telemetry is not enabled.");
    const credentials = await this.options.credentials(signal);
    validateBinding(credentials.account);
    if (credentials.verified !== true || credentials.account.provider !== "anthropic" || !credentials.accessToken) throw new TelemetryError("authentication", "Explicit verified Claude telemetry credentials/binding are required.");
    if (!credentials.scopes.includes("user:profile")) throw new TelemetryError("permission", "Claude telemetry requires user:profile permission.");
    const body = await fetchUsage("https://api.anthropic.com/api/oauth/usage", { Authorization: `Bearer ${credentials.accessToken}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" }, this.options.fetchFn ?? fetch, signal);
    return parseClaudeUsage(body, credentials.account);
  }
}
/** Existing weekly callback compatibility; not a separate admission domain. */
export class CallbackUsageSource implements WeeklyUsageSource {
  constructor(readonly name: string, private readonly callback: (signal?: AbortSignal) => Promise<WeeklyUsageSnapshot | null>) {}
  getUsage(signal?: AbortSignal) { return this.callback(signal); }
}
export class FallbackUsageSource implements WeeklyUsageSource {
  readonly name = "fallback";
  constructor(private readonly sources: WeeklyUsageSource[]) {}
  async getUsage(signal?: AbortSignal): Promise<WeeklyUsageSnapshot | null> {
    const failures: string[] = [];
    for (const source of this.sources) {
      try { const result = await source.getUsage(signal); if (result) return result; failures.push(`${source.name}: no quota snapshot returned`); }
      catch (error) { failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    throw new Error(failures.join("; ") || "No quota source is configured.");
  }
}
