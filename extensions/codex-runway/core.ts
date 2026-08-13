import type { AccountingPeriod, CodexModel, CodexUsageSnapshot, Confidence, DailyUsage, Forecast, ForecastStatus, RunwayConfig, RunwayHealth, RunwayStore } from "./types";

export const DEFAULT_CONFIG: RunwayConfig = {
  reservePct: 10,
  ewmaAlpha: 0.3,
  // JS Date.getDay(): Sunday through Saturday. Captain's strict five-day plan.
  weekdayWeights: [0, 1, 1, 1, 1, 1, 0],
  workdayStartHour: 9,
  workdayEndHour: 16,
  expensiveModelPattern: "(?:sol|fast)",
  minimumForecastSamples: 2,
  staleSnapshotMinutes: 10,
};

export const resolvedConfig = (config?: Partial<RunwayConfig>): RunwayConfig => ({ ...DEFAULT_CONFIG, ...config });
export const clampPct = (value: number) => Math.max(0, Math.min(100, value));
export function normalizeModel(model?: string | null): CodexModel {
  const value = (model ?? "").toLowerCase();
  if (value.includes("sol")) return "Sol";
  if (value.includes("terra")) return "Terra";
  if (value.includes("luna")) return "Luna";
  if (value.includes("spark")) return "Spark";
  return "Other";
}
export function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => { const copy = new Date(date); copy.setDate(copy.getDate() + days); return copy; };

/** Stable despite WHAM's reconstructed reset instant jittering by milliseconds. */
function periodId(snapshot: CodexUsageSnapshot): string {
  const reset = parseDate(snapshot.resetTimestamp)?.getTime() ?? Date.now();
  return `period-${Math.round(reset / 3_600_000)}`;
}
export function newPeriod(snapshot: CodexUsageSnapshot): AccountingPeriod {
  return { id: periodId(snapshot), resetTimestamp: snapshot.resetTimestamp, startedAt: snapshot.fetchedAt, openingRemainingPct: snapshot.remainingPct };
}
export function isQuotaReset(previous: CodexUsageSnapshot | undefined, next: CodexUsageSnapshot): boolean {
  if (!previous) return false;
  const oldReset = parseDate(previous.resetTimestamp)?.getTime();
  const newReset = parseDate(next.resetTimestamp)?.getTime();
  const deadlineAdvanced = oldReset != null && newReset != null && newReset - oldReset >= 5 * 86_400_000;
  const restored = next.remainingPct >= 95 && next.remainingPct - previous.remainingPct >= 20;
  return deadlineAdvanced || restored;
}

/** Persist every heartbeat/change. This is the authoritative history, not agent duration. */
export function applySnapshot(store: RunwayStore, raw: CodexUsageSnapshot): { reset: boolean; store: RunwayStore } {
  const reset = !store.currentPeriod || isQuotaReset(store.lastSnapshot, raw);
  const period = reset ? newPeriod(raw) : store.currentPeriod!;
  const snapshot = { ...raw };
  const previous = store.lastSnapshot;
  // Keep the exact latest reset for display, while period identity remains stable.
  const duplicate = previous && previous.remainingPct === snapshot.remainingPct
    && previous.fetchedAt === snapshot.fetchedAt;
  const snapshots = reset ? [snapshot] : [...(store.snapshots ?? []), ...(duplicate ? [] : [snapshot])].slice(-5_500);
  return { reset, store: { ...store, version: 2, currentPeriod: period, lastSnapshot: snapshot, snapshots } };
}

export function ewma(values: number[], alpha = DEFAULT_CONFIG.ewmaAlpha): number | undefined {
  if (!values.length) return undefined;
  return values.slice(1).reduce((result, value) => alpha * value + (1 - alpha) * result, values[0]!);
}

function dayWorkFraction(day: Date, from: Date, until: Date, config: RunwayConfig): number {
  const weight = config.weekdayWeights[day.getDay()] ?? 0;
  if (weight <= 0) return 0;
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), config.workdayStartHour).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), config.workdayEndHour).getTime();
  const span = end - start;
  return span > 0 ? weight * Math.max(0, Math.min(1, (Math.min(end, until.getTime()) - Math.max(start, from.getTime())) / span)) : 0;
}
export function remainingWork(now: Date, reset: Date, config: RunwayConfig) {
  let totalWeight = 0; let todayWeight = 0;
  for (let day = midnight(now); day.getTime() < reset.getTime(); day = addDays(day, 1)) {
    const contribution = dayWorkFraction(day, now, reset, config);
    totalWeight += contribution;
    if (dateKey(day) === dateKey(now)) todayWeight += contribution;
  }
  return { totalWeight, todayWeight };
}

/** Derive daily percentage buckets from quota snapshots, including external/unattributed activity. */
export function dailyUsage(snapshots: CodexUsageSnapshot[], now: Date, config: RunwayConfig): DailyUsage[] {
  const groups = new Map<string, CodexUsageSnapshot[]>();
  for (const snapshot of snapshots) {
    const date = parseDate(snapshot.fetchedAt); if (!date) continue;
    const key = dateKey(date); const group = groups.get(key) ?? []; group.push(snapshot); groups.set(key, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    group.sort((a, b) => (parseDate(a.fetchedAt)?.getTime() ?? 0) - (parseDate(b.fetchedAt)?.getTime() ?? 0));
    const first = group[0]!; const last = group.at(-1)!; const date = parseDate(first.fetchedAt)!;
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), config.workdayStartHour);
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), config.workdayEndHour);
    const until = key === dateKey(now) ? now : end;
    const elapsed = dayWorkFraction(date, start, until, config);
    const burn = Math.max(0, first.remainingPct - last.remainingPct);
    let unattributed = 0;
    for (let i = 1; i < group.length; i++) {
      const delta = Math.max(0, group[i - 1]!.remainingPct - group[i]!.remainingPct);
      if (!group[i]!.activeModel) unattributed += delta;
    }
    const early = (parseDate(first.fetchedAt)?.getTime() ?? Infinity) <= start.getTime() + 90 * 60_000;
    const late = (parseDate(last.fetchedAt)?.getTime() ?? 0) >= Math.min(end.getTime(), now.getTime()) - 90 * 60_000;
    const confidence: Confidence = group.length < 2 || elapsed <= 0 ? "LOW" : early && late ? "HIGH" : "MEDIUM";
    return { localDate: key, weekday: date.getDay(), openingRemainingPct: first.remainingPct, closingRemainingPct: last.remainingPct, burnPct: burn, workWeight: config.weekdayWeights[date.getDay()] ?? 0, elapsedWorkFraction: elapsed, confidence, unattributedBurnPct: unattributed };
  });
}

function healthFor(paceRatio: number | undefined): RunwayHealth {
  if (paceRatio == null || !Number.isFinite(paceRatio)) return "INSUFFICIENT DATA";
  if (paceRatio < .75) return "FREE";
  if (paceRatio < .9) return "HEALTHY";
  if (paceRatio <= 1.1) return "ON BUDGET";
  if (paceRatio <= 1.3) return "TAKE CARE";
  return "SLOW DOWN";
}
function statusFor(projected: number | undefined): ForecastStatus {
  if (projected == null) return "INSUFFICIENT DATA";
  return projected > 25 ? "FREE" : projected >= 10 ? "ON TRACK" : projected >= 3 ? "TIGHT" : "OVER BUDGET";
}

export function calculateForecast(store: RunwayStore, now = new Date()): Forecast | null {
  const snapshot = store.lastSnapshot; if (!snapshot) return null;
  const reset = parseDate(snapshot.resetTimestamp); if (!reset || reset <= now) return null;
  const config = resolvedConfig(store.config);
  const buckets = dailyUsage(store.snapshots ?? [snapshot], now, config);
  const today = buckets.find((entry) => entry.localDate === dateKey(now));
  // Completed observed weekdays, normalized to a full weighted workday.
  const completed = buckets.filter((entry) => entry.localDate !== dateKey(now) && entry.workWeight > 0 && entry.elapsedWorkFraction >= entry.workWeight && entry.confidence !== "LOW")
    .map((entry) => entry.burnPct / entry.workWeight);
  // Current day can be a recent directional sample only after a meaningful portion of it elapsed.
  const currentRate = today && today.workWeight > 0 && today.elapsedWorkFraction >= .25 && today.burnPct > 0
    ? today.burnPct / today.elapsedWorkFraction : undefined;
  const rates = [...completed, ...(currentRate == null ? [] : [currentRate])];
  const burnPerWorkday = rates.length >= config.minimumForecastSamples ? ewma(rates, config.ewmaAlpha) : undefined;
  const work = remainingWork(now, reset, config);
  const usableBudget = Math.max(0, snapshot.remainingPct - config.reservePct);
  const sustainable = work.totalWeight > 0 ? usableBudget / work.totalWeight : 0;
  const expected = burnPerWorkday == null ? undefined : burnPerWorkday * work.totalWeight;
  const projected = expected == null ? undefined : clampPct(snapshot.remainingPct - expected);
  const runway = expected == null || expected <= 0 ? undefined : usableBudget / expected;
  const pace = burnPerWorkday == null || sustainable <= 0 ? undefined : burnPerWorkday / sustainable;
  const age = Math.max(0, (now.getTime() - (parseDate(snapshot.fetchedAt)?.getTime() ?? now.getTime())) / 60_000);
  const confidence: Confidence = burnPerWorkday == null ? "INSUFFICIENT" : age > config.staleSnapshotMinutes ? "LOW" : completed.length >= 4 ? "HIGH" : "MEDIUM";
  const health = confidence === "INSUFFICIENT" || age > config.staleSnapshotMinutes ? "INSUFFICIENT DATA" : healthFor(pace);
  return { now: now.toISOString(), resetTimestamp: snapshot.resetTimestamp, currentRemainingPct: snapshot.remainingPct, reservePct: config.reservePct, usableBudget,
    todayRemainingWorkWeight: work.todayWeight, totalRemainingWorkWeight: work.totalWeight,
    nominalTodayBudget: work.totalWeight ? usableBudget * work.todayWeight / work.totalWeight : 0,
    spentTodayPct: today?.burnPct ?? 0, burnPerWorkday, sustainableBurnPerWorkday: sustainable,
    expectedFutureBurn: expected, projectedRemainingAtReset: projected, runwayRatio: runway, paceRatio: pace,
    status: statusFor(projected), health, confidence, dailyUsage: buckets, samples: rates.length, snapshotAgeMinutes: age };
}

export function emptyStore(): RunwayStore { return { version: 2, observations: [], snapshots: [] }; }
export function migrateStore(store: RunwayStore): RunwayStore {
  if (store.version === 2) return { ...store, snapshots: store.snapshots ?? (store.lastSnapshot ? [store.lastSnapshot] : []) };
  return { ...store, version: 2, snapshots: store.lastSnapshot ? [store.lastSnapshot] : [] };
}
export function formatDuration(ms: number): string { const sec = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(sec / 86400); const h = Math.floor(sec % 86400 / 3600); const m = Math.floor(sec % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
