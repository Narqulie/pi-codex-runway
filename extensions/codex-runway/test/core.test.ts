import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, applySnapshot, calculateForecast, dailyUsage, emptyStore, isQuotaReset, remainingWork } from "../core";
import type { CodexUsageSnapshot, RunwayStore } from "../types";

const local = (day: number, hour: number, minute = 0) => new Date(2025, 0, day, hour, minute);
const snap = (remainingPct: number, at: Date, reset = local(13, 16)): CodexUsageSnapshot => ({ remainingPct, resetTimestamp: reset.toISOString(), fetchedAt: at.toISOString(), source: "test" });
function storeWith(...snapshots: CodexUsageSnapshot[]): RunwayStore { return snapshots.reduce((store, s) => applySnapshot(store, s).store, emptyStore()); }

test("strict five-day plan assigns zero weekend work", () => {
  const work = remainingWork(local(11, 12), local(13, 12), DEFAULT_CONFIG); // Sat noon → Mon noon
  assert.equal(work.todayWeight, 0);
  assert.equal(work.totalWeight, 3 / 7); // Monday 09:00–12:00 only
});

test("midday weekday prorates remaining work", () => {
  const work = remainingWork(local(6, 12), local(7, 16), DEFAULT_CONFIG);
  assert.equal(work.todayWeight, 4 / 7);
  assert.equal(work.totalWeight, 11 / 7);
});

test("quota reset detection tolerates normal reset-time jitter", () => {
  const before = snap(70, local(6, 9), local(13, 16));
  assert.equal(isQuotaReset(before, snap(69, local(6, 9, 2), local(13, 16, 0, 2))), false);
  assert.equal(isQuotaReset(before, snap(98, local(6, 9), local(20, 16))), true);
});

test("daily buckets derive workday percentage burn from snapshots", () => {
  const snapshots = [snap(90, local(6, 9)), snap(86, local(6, 15)), snap(86, local(7, 9)), snap(82, local(7, 16))];
  const result = dailyUsage(snapshots, local(8, 12), DEFAULT_CONFIG);
  assert.deepEqual(result.map((d) => d.burnPct), [4, 4]);
  assert.equal(result[0]!.localDate, "2025-01-06");
  assert.equal(result[0]!.confidence, "HIGH");
});

test("forecast uses percentage per workday, not model response minutes", () => {
  // Two complete Mon/Tue workdays burn 4% each. Wednesday noon has 82% left.
  const store = storeWith(snap(90, local(6, 9)), snap(86, local(6, 16)), snap(86, local(7, 9)), snap(82, local(7, 16)), snap(82, local(8, 9)), snap(82, local(8, 12)));
  const result = calculateForecast(store, local(8, 12))!;
  assert.equal(result.burnPerWorkday, 4);
  assert.equal(result.sustainableBurnPerWorkday, 72 / (4 / 7 + 1 + 1 + 1));
  assert.equal(result.health, "FREE");
  assert.ok(result.projectedRemainingAtReset! > 65);
});

test("forecast remains insufficient without two daily pace samples", () => {
  const store = storeWith(snap(90, local(6, 9)), snap(86, local(6, 16)), snap(86, local(7, 9)));
  const result = calculateForecast(store, local(7, 12))!;
  assert.equal(result.health, "INSUFFICIENT DATA");
  assert.equal(result.projectedRemainingAtReset, undefined);
});

test("current-day burn is observed as unattributed when no Pi model was active", () => {
  const result = dailyUsage([snap(90, local(6, 9)), snap(87, local(6, 12))], local(6, 12), DEFAULT_CONFIG);
  assert.equal(result[0]!.unattributedBurnPct, 3);
});

test("runway health drives take-care and slow-down thresholds", () => {
  const reset = local(15, 16); // five-plus future workdays makes the pace comparison meaningful
  let store = storeWith(snap(100, local(6, 9), reset), snap(86, local(6, 16), reset), snap(86, local(7, 9), reset), snap(72, local(7, 16), reset), snap(72, local(8, 9), reset), snap(72, local(8, 12), reset));
  let result = calculateForecast(store, local(8, 12))!;
  assert.equal(result.health, "TAKE CARE");
  store = storeWith(snap(100, local(6, 9), reset), snap(80, local(6, 16), reset), snap(80, local(7, 9), reset), snap(60, local(7, 16), reset), snap(60, local(8, 9), reset), snap(60, local(8, 12), reset));
  result = calculateForecast(store, local(8, 12))!;
  assert.equal(result.health, "SLOW DOWN");
});

test("stale snapshots cannot drive alerts", () => {
  const store = storeWith(snap(100, local(6, 9)), snap(96, local(6, 16)), snap(96, local(7, 9)), snap(92, local(7, 16)));
  const result = calculateForecast(store, local(8, 12))!;
  assert.equal(result.health, "INSUFFICIENT DATA");
  assert.ok(result.snapshotAgeMinutes > 10);
});
