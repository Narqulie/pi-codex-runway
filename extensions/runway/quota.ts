import type { WeeklyUsageSnapshot } from "./types";

/** A stable subscription binding, never a model name, bearer token or display email. */
export interface AccountBinding { provider: string; accountId: string }
export const accountKey = (account: AccountBinding) => JSON.stringify([account.provider, account.accountId]);
export function validateBinding(account: AccountBinding): AccountBinding {
  if (!account?.provider?.trim() || !account?.accountId?.trim()) throw new Error("A verified stable account binding is required.");
  return { provider: account.provider, accountId: account.accountId };
}
export type WindowScope = { kind: "all" } | { kind: "models"; families: string[] }
  | { kind: "features"; features: string[] } | { kind: "unknown" };
export interface QuotaWindow {
  id: string;
  label: string;
  scope: WindowScope;
  durationSeconds?: number;
  usedPct?: number;
  resetAt?: string;
  observedAt: string;
  source: string;
  revision: string;
  evidence: "published" | "reconstructed" | "unavailable" | "provider-refusal";
  /** Original provider role, not an interpretation of its duration. */
  providerLabel?: string;
}
export type TelemetryIssue = "authentication" | "permission" | "throttled" | "network" | "malformed" | "partial";
export interface AccountObservation {
  account: AccountBinding;
  observedAt: string;
  source: string;
  revision: string;
  windows: QuotaWindow[];
  /** False when the adapter cannot establish a complete protected-window inventory.
   * Individual unreadable scoped rows are evaluated only for applicable requests. */
  complete: boolean;
  issue?: TelemetryIssue;
}
export interface QuotaSource {
  readonly name: string;
  getObservation(signal?: AbortSignal): Promise<AccountObservation>;
}
export interface QuotaRequest { account: AccountBinding; modelFamily?: string; feature?: string }
export interface AdmissionPolicy { protected: boolean; maxAgeMs: number; stopUsedPct?: number }
export interface AdmissionDecision {
  action: "admit" | "hold" | "advisory";
  reasons: Array<{ windowId?: string; reason: "exhausted" | "unknown" | "stale" | "partial" }>;
}
export function applicable(scope: WindowScope, request: QuotaRequest): boolean | undefined {
  if (scope.kind === "all") return true;
  if (scope.kind === "unknown") return undefined;
  if (scope.kind === "models") return request.modelFamily ? scope.families.includes(request.modelFamily) : undefined;
  return request.feature ? scope.features.includes(request.feature) : undefined;
}
export function freshWindow(window: QuotaWindow, now: Date, maxAgeMs: number): boolean {
  const age = now.getTime() - Date.parse(window.observedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
export function knownWindow(window: QuotaWindow): boolean {
  return typeof window.usedPct === "number" && Number.isFinite(window.usedPct) && window.usedPct >= 0 && window.usedPct <= 100
    && !!window.resetAt && Number.isFinite(Date.parse(window.resetAt))
    && (window.evidence === "published" || window.evidence === "reconstructed");
}
/** Merge same-account telemetry without allowing missing/invalid rows to erase known evidence.
 * This is advisory state, not a cross-process admission authority. */
export function mergeObservation(previous: AccountObservation | undefined, next: AccountObservation, now = new Date(), maxAgeMs = 600000, stopUsedPct = 99): AccountObservation {
  validateBinding(next.account);
  if (!previous || accountKey(previous.account) !== accountKey(next.account)) return next;
  if (Date.parse(next.observedAt) < Date.parse(previous.observedAt)) return previous;
  if (next.issue && next.issue !== "partial") return { ...next, windows: previous.windows };
  const windows = new Map(previous.windows.map((window) => [window.id, window]));
  for (const window of next.windows) {
    const old = windows.get(window.id);
    const oldBlocker = old && (old.evidence === "provider-refusal" || knownWindow(old) && old.usedPct! >= stopUsedPct);
    const resetProof = knownWindow(window) && freshWindow(window, now, maxAgeMs) && Date.parse(window.resetAt!) > now.getTime();
    if (oldBlocker && !resetProof && window.evidence !== "provider-refusal") continue;
    if (!old || Date.parse(window.observedAt) >= Date.parse(old.observedAt)) {
      const scopeChanged = old && old.scope.kind !== "unknown" && JSON.stringify(old.scope) !== JSON.stringify(window.scope);
      windows.set(window.id, scopeChanged ? { ...window, scope: { kind: "unknown" } } : window);
    }
  }
  return { ...next, windows: [...windows.values()] };
}
/** Pure candidate evaluation only. No hook veto, permit, routing or runtime wait. */
export function evaluateAdmission(request: QuotaRequest, observation: AccountObservation | undefined, policy: AdmissionPolicy, now = new Date(), previous?: AccountObservation): AdmissionDecision {
  if (!policy.protected) return { action: "advisory", reasons: [] };
  if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0 || !Number.isFinite(policy.stopUsedPct ?? 99) || (policy.stopUsedPct ?? 99) <= 0 || (policy.stopUsedPct ?? 99) > 100) throw new Error("Invalid admission policy.");
  const matching = (value?: AccountObservation) => value && accountKey(value.account) === accountKey(request.account) ? value : undefined;
  const current = matching(observation);
  const prior = matching(previous);
  const effective = current ? mergeObservation(prior, current, now, policy.maxAgeMs, policy.stopUsedPct ?? 99) : prior;
  const reasons: AdmissionDecision["reasons"] = [];
  if (!current || !effective?.complete || effective.issue && effective.issue !== "partial") reasons.push({ reason: !current || effective?.issue && effective.issue !== "partial" ? "unknown" : "partial" });
  if (!effective?.windows.length) reasons.push({ reason: "unknown" });
  for (const window of effective?.windows ?? []) {
    const applies = applicable(window.scope, request);
    if (applies === false) continue;
    if (applies === undefined || !knownWindow(window)) reasons.push({ windowId: window.id, reason: "unknown" });
    if (window.evidence === "provider-refusal" || knownWindow(window) && window.usedPct! >= (policy.stopUsedPct ?? 99)) reasons.push({ windowId: window.id, reason: "exhausted" });
    // A reset schedules a probe; elapsed time does not grant new allowance.
    if (!freshWindow(window, now, policy.maxAgeMs) || !window.resetAt || Date.parse(window.resetAt) <= now.getTime()) reasons.push({ windowId: window.id, reason: "stale" });
    const old = prior?.windows.find((entry) => entry.id === window.id);
    if (old && (old.evidence === "provider-refusal" || knownWindow(old) && old.usedPct! >= (policy.stopUsedPct ?? 99))
      && !(knownWindow(window) && freshWindow(window, now, policy.maxAgeMs) && Date.parse(window.resetAt!) > now.getTime() && window.usedPct! < (policy.stopUsedPct ?? 99))) {
      if (!reasons.some((entry) => entry.windowId === window.id && entry.reason === "exhausted")) reasons.push({ windowId: window.id, reason: "exhausted" });
    }
  }
  return { action: reasons.length ? "hold" : "admit", reasons };
}
/** Only one known all-model seven-day window can drive a weekly forecast. */
export function projectWeekly(observation: AccountObservation): WeeklyUsageSnapshot | null {
  if (!["openai-codex", "anthropic"].includes(observation.account.provider)) return null;
  const windows = observation.windows.filter((window) => window.scope.kind === "all" && window.durationSeconds === 604800 && knownWindow(window));
  if (windows.length !== 1) return null;
  const window = windows[0]!;
  return { remainingPct: 100 - window.usedPct!, resetTimestamp: window.resetAt!, fetchedAt: window.observedAt, source: window.source, account: observation.account };
}
export function formatQuotaOverview(observations: AccountObservation[], now = new Date(), maxAgeMs = 600000): string[] {
  return ["RUNWAY · QUOTA OVERVIEW", "Quota observations are advisory unless the installed provider guard reports an enrolled account.", "No automatic routing or paid fallback.",
    ...(observations.length ? observations.flatMap((observation) => [
      `${observation.account.provider} · ${observation.account.accountId}${observation.issue || !observation.complete ? ` · telemetry ${observation.issue ?? "partial"}` : ""}`,
      ...observation.windows.map((window) => `  ${window.label} [${window.scope.kind}${window.scope.kind === "models" ? `: ${window.scope.families.join(", ")}` : window.scope.kind === "features" ? `: ${window.scope.features.join(", ")}` : ""}] · ${window.usedPct == null ? "unknown" : `${window.usedPct}% used`} · reset ${window.resetAt ?? "unknown"} · ${freshWindow(window, now, maxAgeMs) && Date.parse(window.resetAt ?? "") > now.getTime() ? window.evidence : "stale"}${window.usedPct != null && window.usedPct >= 99 || window.evidence === "provider-refusal" ? " · observed blocker" : ""}`),
    ]) : ["No bound account observations yet."])];
}
