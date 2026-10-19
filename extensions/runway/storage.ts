import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { emptyStore, migrateStore, resolvedConfig } from "./core";
import { accountKey, validateBinding } from "./quota";
import type { AccountObservation } from "./quota";
import type { RunwayConfig, RunwayStore } from "./types";

/** Advisory persistence only. NOT transactional admission/coordination state. */
export interface RunwayState {
  version: 2;
  legacyImport: "absent" | "imported";
  config?: Partial<RunwayConfig>;
  accounts: AccountObservation[];
  forecasts: Record<string, RunwayStore>;
  /** Account-less records cannot be assigned to the next authenticated user. */
  legacyForecast?: RunwayStore;
}
export const emptyState = (): RunwayState => ({ version: 2, legacyImport: "absent", accounts: [], forecasts: {} });
const validDate = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const pct = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const object = (value: any) => !!value && typeof value === "object" && !Array.isArray(value);
function validateConfig(value?: Partial<RunwayConfig>) {
  if (value != null && !object(value)) throw new Error("Invalid forecast configuration.");
  const config = resolvedConfig(value);
  if (!pct(config.reservePct) || config.reservePct >= 100 || !Number.isFinite(config.ewmaAlpha) || config.ewmaAlpha <= 0 || config.ewmaAlpha > 1
    || !Array.isArray(config.weekdayWeights) || config.weekdayWeights.length !== 7 || !config.weekdayWeights.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    || !Number.isFinite(config.workdayStartHour) || !Number.isFinite(config.workdayEndHour) || config.workdayStartHour < 0 || config.workdayEndHour > 24 || config.workdayStartHour >= config.workdayEndHour
    || !Number.isInteger(config.minimumForecastSamples) || config.minimumForecastSamples < 1 || !Number.isFinite(config.staleSnapshotMinutes) || config.staleSnapshotMinutes <= 0 || typeof config.expensiveModelPattern !== "string") throw new Error("Invalid forecast configuration.");
  new RegExp(config.expensiveModelPattern);
}
export function validateForecast(value: any): RunwayStore {
  if (!object(value) || ![1, 2, 3].includes(value.version) || !Array.isArray(value.observations)) throw new Error("Invalid legacy forecast store.");
  validateConfig(value.config);
  const validSnapshot = (entry: any) => object(entry) && pct(entry.remainingPct) && validDate(entry.resetTimestamp) && validDate(entry.fetchedAt) && typeof entry.source === "string";
  if (value.lastSnapshot != null && !validSnapshot(value.lastSnapshot)
    || value.snapshots != null && (!Array.isArray(value.snapshots) || !value.snapshots.every(validSnapshot))
    || !value.observations.every((entry: any) => object(entry) && typeof entry.id === "string" && typeof entry.accountingPeriodId === "string" && validDate(entry.timestamp) && validDate(entry.resetTimestamp) && pct(entry.weeklyPctBefore) && pct(entry.weeklyPctAfter) && Number.isFinite(entry.activeHours) && entry.activeHours >= 0 && typeof entry.model === "string" && typeof entry.source === "string")
    || value.currentPeriod != null && (!object(value.currentPeriod) || typeof value.currentPeriod.id !== "string" || !validDate(value.currentPeriod.resetTimestamp) || !validDate(value.currentPeriod.startedAt) || !pct(value.currentPeriod.openingRemainingPct))
    || value.forecastHistory != null && (!Array.isArray(value.forecastHistory) || !value.forecastHistory.every((entry: any) => object(entry) && validDate(entry.timestamp) && pct(entry.remainingPct) && validDate(entry.resetTimestamp) && typeof entry.health === "string" && typeof entry.reason === "string"))) throw new Error("Invalid forecast records; original file preserved.");
  return migrateStore(value);
}
export function validateState(value: any): RunwayState {
  const legacy = object(value) && value.version === 1;
  if (legacy) {
    const { codexForecasts, ...rest } = value;
    value = { ...rest, version: 2, forecasts: codexForecasts };
  }
  if (!object(value) || value.version !== 2 || !["absent", "imported"].includes(value.legacyImport) || !Array.isArray(value.accounts) || !object(value.forecasts)) throw new Error("Invalid Runway state; original file preserved.");
  validateConfig(value.config);
  const keys = new Set<string>();
  for (const observation of value.accounts) {
    validateBinding(observation.account);
    const key = accountKey(observation.account);
    if (keys.has(key) || !validDate(observation.observedAt) || typeof observation.source !== "string" || typeof observation.revision !== "string" || typeof observation.complete !== "boolean" || !Array.isArray(observation.windows)) throw new Error("Invalid account observations.");
    keys.add(key);
    const ids = new Set<string>();
    for (const window of observation.windows) {
      if (!object(window) || typeof window.id !== "string" || ids.has(window.id) || typeof window.label !== "string" || !validDate(window.observedAt) || typeof window.source !== "string" || typeof window.revision !== "string"
        || !["published", "reconstructed", "unavailable", "provider-refusal"].includes(window.evidence)
        || window.usedPct != null && !pct(window.usedPct) || window.resetAt != null && !validDate(window.resetAt)
        || window.durationSeconds != null && (!Number.isFinite(window.durationSeconds) || window.durationSeconds <= 0)
        || !object(window.scope) || !["all", "unknown", "models", "features"].includes(window.scope.kind)
        || window.scope.kind === "models" && (!Array.isArray(window.scope.families) || !window.scope.families.every((v: unknown) => typeof v === "string"))
        || window.scope.kind === "features" && (!Array.isArray(window.scope.features) || !window.scope.features.every((v: unknown) => typeof v === "string"))) throw new Error("Invalid quota window.");
      ids.add(window.id);
    }
  }
  for (const [key, forecast] of Object.entries(value.forecasts)) {
    const account = JSON.parse(key);
    if (!Array.isArray(account) || account.length !== 2 || !(legacy ? account[0] === "openai-codex" : ["openai-codex", "anthropic"].includes(account[0])) || typeof account[1] !== "string" || !account[1].trim()) throw new Error("Invalid forecast account key.");
    validateForecast(forecast);
    // No account-less or foreign samples are permitted in bound forecast history.
    for (const snapshot of [...((forecast as RunwayStore).snapshots ?? []), ...((forecast as RunwayStore).lastSnapshot ? [(forecast as RunwayStore).lastSnapshot!] : [])]) {
      if (!snapshot.account || accountKey(snapshot.account) !== key) throw new Error("Unbound or foreign account forecast sample.");
    }
  }
  if (value.legacyForecast != null) validateForecast(value.legacyForecast);
  return value;
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
async function atomicWrite(state: RunwayState, path: string, createOnly = false) {
  validateState(state);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    validateState(JSON.parse(await readFile(temporary, "utf8")));
    if (createOnly) await link(temporary, path); else await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}
export async function readState(path: string, legacyPath: string): Promise<RunwayState> {
  try { return validateState(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if (!missing(error)) throw error; }
  let state = emptyState();
  try {
    const legacyForecast = validateForecast(JSON.parse(await readFile(legacyPath, "utf8")));
    state = { ...state, legacyImport: "imported", legacyForecast, config: legacyForecast.config };
  } catch (error) { if (!missing(error)) throw error; }
  // Exclusive publication prevents concurrent first launches overwriting an import.
  try { await atomicWrite(state, path, true); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; return validateState(JSON.parse(await readFile(path, "utf8"))); }
  return state;
}
export const writeState = (state: RunwayState, path: string) => atomicWrite(state, path);
export function forecastFor(state: RunwayState, key?: string): RunwayStore {
  return key ? state.forecasts[key] ?? { ...emptyStore(), config: state.config } : state.legacyForecast ?? { ...emptyStore(), config: state.config };
}
