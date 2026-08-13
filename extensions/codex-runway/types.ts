export type CodexModel = "Sol" | "Terra" | "Luna" | "Spark" | "Other";
export type ForecastStatus = "FREE" | "ON TRACK" | "TIGHT" | "OVER BUDGET" | "INSUFFICIENT DATA";
export type RunwayHealth = "FREE" | "HEALTHY" | "ON BUDGET" | "TAKE CARE" | "SLOW DOWN" | "INSUFFICIENT DATA";
export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

/** A single authoritative quota reading. Percentages are whole-number WHAM values. */
export interface CodexUsageSnapshot {
  remainingPct: number;
  resetTimestamp: string;
  fetchedAt: string;
  source: string;
  /** Model active when the reading was captured, if Pi knows it. */
  activeModel?: CodexModel;
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

export interface RunwayStore {
  version: 1 | 2;
  config?: Partial<RunwayConfig>;
  currentPeriod?: AccountingPeriod;
  lastSnapshot?: CodexUsageSnapshot;
  /** Chronological quota history; contains heartbeat polls and percentage changes. */
  snapshots?: CodexUsageSnapshot[];
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

export interface CodexUsageSource {
  readonly name: string;
  getUsage(signal?: AbortSignal): Promise<CodexUsageSnapshot | null>;
}
