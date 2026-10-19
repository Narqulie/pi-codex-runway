export type CodexModel = "Astra" | "Sol" | "Terra" | "Luna" | "Spark" | "Other";
export type ForecastStatus = "FREE" | "ON TRACK" | "TIGHT" | "OVER BUDGET" | "INSUFFICIENT DATA";
export type RunwayHealth = "FREE" | "HEALTHY" | "ON BUDGET" | "TAKE CARE" | "SLOW DOWN" | "INSUFFICIENT DATA";
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

/** A known all-model weekly reading, bound to its provider subscription. */
export interface WeeklyUsageSnapshot {
  remainingPct: number;
  resetTimestamp: string;
  fetchedAt: string;
  source: string;
  /** Present only for observations captured with a stable account binding. Legacy readings stay unbound. */
  account?: import("./quota").AccountBinding;
  /** Model active when the reading was captured, if Pi knows it. */
  activeModel?: string;
}

/** Retained for migration and secondary model diagnostics from the v1 extension. */
export interface UsageObservation {
  id: string;
  accountingPeriodId: string;
  timestamp: string;
  weeklyPctBefore: number;
  weeklyPctAfter: number;
  activeHours: number;
  model: CodexModel;
  resetTimestamp: string;
  source: string;
}

export interface AccountingPeriod {
  id: string;
  resetTimestamp: string;
  startedAt: string;
  openingRemainingPct: number;
}

export interface DailyUsage {
  localDate: string;
  weekday: number;
  openingRemainingPct: number;
  closingRemainingPct: number;
  burnPct: number;
  workWeight: number;
  elapsedWorkFraction: number;
  confidence: Confidence;
  /** Burn observed with no Pi model active, e.g. Codex CLI/browser use. */
  unattributedBurnPct: number;
}

export interface RunwayConfig {
  reservePct: number;
  ewmaAlpha: number;
  /** Sunday through Saturday. Default is a strict Monday–Friday work week. */
  weekdayWeights: [number, number, number, number, number, number, number];
  workdayStartHour: number;
  workdayEndHour: number;
  expensiveModelPattern: string;
  minimumForecastSamples: number;
  /** A quota reading older than this cannot drive an alert. */
  staleSnapshotMinutes: number;
}

/** A compact audit record of what the extension advised at a point in time. */
export interface ForecastHistoryEntry {
  timestamp: string;
  accountingPeriodId?: string;
  remainingPct: number;
  resetTimestamp: string;
  spentTodayPct: number;
  burnPerWorkday?: number;
  sustainableBurnPerWorkday: number;
  paceRatio?: number;
  projectedRemainingAtReset?: number;
  runwayRatio?: number;
  health: RunwayHealth;
  confidence: Confidence;
  samples: number;
  snapshotAgeMinutes: number;
  reason: "initial" | "heartbeat" | "quota-change" | "status-change";
}

export interface RunwayStore {
  version: 1 | 2 | 3;
  config?: Partial<RunwayConfig>;
  currentPeriod?: AccountingPeriod;
  lastSnapshot?: WeeklyUsageSnapshot;
  /** Chronological quota history; contains heartbeat polls and percentage changes. */
  snapshots?: WeeklyUsageSnapshot[];
  /** Compact decision history: status changes, quota changes, and 30-minute heartbeats. */
  forecastHistory?: ForecastHistoryEntry[];
  /** v1 records retained rather than discarded during migration. */
  observations: UsageObservation[];
}

export interface Forecast {
  now: string;
  resetTimestamp: string;
  currentRemainingPct: number;
  reservePct: number;
  usableBudget: number;
  todayRemainingWorkWeight: number;
  totalRemainingWorkWeight: number;
  /** Advisory amount available for the remainder of today; it continuously rebalances. */
  nominalTodayBudget: number;
  spentTodayPct: number;
  /** Empirical % burned per weighted workday. */
  burnPerWorkday?: number;
  sustainableBurnPerWorkday: number;
  expectedFutureBurn?: number;
  projectedRemainingAtReset?: number;
  runwayRatio?: number;
  paceRatio?: number;
  status: ForecastStatus;
  health: RunwayHealth;
  confidence: Confidence;
  dailyUsage: DailyUsage[];
  samples: number;
  snapshotAgeMinutes: number;
}

export interface WeeklyUsageSource {
  readonly name: string;
  getUsage(signal?: AbortSignal): Promise<WeeklyUsageSnapshot | null>;
}
