import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendForecastHistory, applySnapshot, calculateForecast, emptyStore, formatDuration, migrateStore, normalizeModel, resolvedConfig } from "./core";
import { FallbackUsageSource, WhamUsageSource } from "./sources";
import type { CodexModel, CodexUsageSnapshot, Forecast, RunwayStore } from "./types";

const STATUS_KEY = "codex-runway";
const WIDGET_KEY = "codex-runway-detail";
const STORE_PATH = join(homedir(), ".pi", "agent", "codex-runway.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const isCodexModel = (model: { provider?: string } | undefined) => model?.provider?.startsWith("openai-codex") ?? false;
async function readStore(path = STORE_PATH): Promise<RunwayStore> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RunwayStore;
    if (Array.isArray(parsed?.observations)) return migrateStore(parsed);
  } catch { /* first launch */ }
  return emptyStore();
}
async function writeStore(store: RunwayStore, path = STORE_PATH) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}
const pct = (value: number | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;
const ratio = (value: number | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(2)}x`;

export function formatDashboard(forecast: Forecast | null, now = new Date()): string[] {
  if (!forecast) return ["CODEX RUNWAY", "Usage unavailable — waiting for a Codex weekly quota snapshot."];
  const resetMs = new Date(forecast.resetTimestamp).getTime() - now.getTime();
  const action = forecast.health === "SLOW DOWN" ? `SLOW DOWN about ${Math.round(((forecast.paceRatio ?? 1) - 1) * 100)}%`
    : forecast.health === "TAKE CARE" ? "TAKE CARE — favour Terra or Luna for expensive work"
    : forecast.health === "ON BUDGET" ? "ON BUDGET — monitor pace" : forecast.health;
  return [
    "CODEX RUNWAY",
    `Weekly: ${pct(forecast.currentRemainingPct)} left · reset ${formatDuration(resetMs)} · reserve ${pct(forecast.reservePct)}`,
    `Today: ${pct(forecast.spentTodayPct)} used · ${pct(forecast.nominalTodayBudget)} advisory remaining`,
    `Pace: ${pct(forecast.burnPerWorkday)} / workday · sustainable ${pct(forecast.sustainableBurnPerWorkday)} / workday`,
    `Projected: ${pct(forecast.projectedRemainingAtReset)} left · runway ${ratio(forecast.runwayRatio)}`,
    `Action: ${action} · confidence ${forecast.confidence}${forecast.snapshotAgeMinutes > 10 ? ` · data ${Math.round(forecast.snapshotAgeMinutes)}m old` : ""}`,
  ];
}

export default function codexRunway(pi: ExtensionAPI) {
  let store: RunwayStore = emptyStore();
  let context: any;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<CodexUsageSnapshot | null> | undefined;
  let sourceIssue: string | undefined;
  let activeAgentModel: CodexModel | undefined;
  const source = new FallbackUsageSource([new WhamUsageSource()]);
  const forecast = () => calculateForecast(store, new Date());

  function updateUi() {
    if (!context?.hasUI) return;
    const data = forecast();
    if (!data) {
      const text = sourceIssue ? `CODEX RUNWAY unavailable: ${sourceIssue}` : "CODEX RUNWAY loading…";
      context.ui.setStatus(STATUS_KEY, context.ui.theme.fg(sourceIssue ? "warning" : "dim", text)); return;
    }
    const color = data.health === "SLOW DOWN" ? "error" : data.health === "TAKE CARE" || data.health === "ON BUDGET" ? "warning" : data.health === "INSUFFICIENT DATA" ? "muted" : "success";
    const compact = data.health === "INSUFFICIENT DATA"
      ? `CODEX RUNWAY learning · ${pct(data.spentTodayPct)} today`
      : `CODEX RUNWAY ${data.health} · ${ratio(data.paceRatio)} pace · ${pct(data.projectedRemainingAtReset)} @ reset`;
    context.ui.setStatus(STATUS_KEY, context.ui.theme.fg(color, compact));
  }
  async function refresh(signal?: AbortSignal): Promise<CodexUsageSnapshot | null> {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = source.getUsage(signal).then(async (raw) => {
      if (!raw) return null;
      sourceIssue = undefined;
      const snapshot = activeAgentModel ? { ...raw, activeModel: activeAgentModel } : raw;
      store = applySnapshot(store, snapshot).store;
      const data = forecast();
      if (data) store = appendForecastHistory(store, data);
      await writeStore(store); updateUi(); return snapshot;
    }).catch((error) => { sourceIssue = error instanceof Error ? error.message.replace(/^codex-wham:\s*/i, "") : "quota source failed"; updateUi(); return null; })
      .finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }
  function maybeWarn(data: Forecast | null) {
    if (!context?.hasUI || !data || data.health === "INSUFFICIENT DATA") return;
    if (data.health === "SLOW DOWN") context.ui.notify(`Codex runway: slow down. Current pace is ${ratio(data.paceRatio)} of sustainable pace.`, "warning");
    else if (data.health === "TAKE CARE") context.ui.notify(`Codex runway: take care; current pace is ${ratio(data.paceRatio)} of sustainable pace.`, "warning");
  }

  pi.on("session_start", async (_event, ctx) => { context = ctx; store = await readStore(); updateUi(); await refresh(); if (timer) clearInterval(timer); timer = setInterval(() => void refresh(), POLL_INTERVAL_MS); });
  pi.on("session_shutdown", async (_event, ctx) => { if (timer) clearInterval(timer); timer = undefined; if (ctx.hasUI) { ctx.ui.setStatus(STATUS_KEY, undefined); ctx.ui.setWidget(WIDGET_KEY, undefined); } });
  pi.on("agent_start", async (_event, ctx) => { context = ctx; activeAgentModel = isCodexModel(ctx.model) ? normalizeModel(ctx.model?.id) : undefined; await refresh(ctx.signal); });
  pi.on("agent_settled", async (_event, ctx) => { context = ctx; await refresh(); activeAgentModel = undefined; maybeWarn(forecast()); });
  pi.on("model_select", async (_event, ctx) => { context = ctx; updateUi(); });

  // Alerts are runway/pace driven. They advise on TIGHT and request explicit
  // confirmation only for an expensive model while SLOW DOWN; ordinary work is never blocked.
  pi.on("input", async (event, ctx) => {
    context = ctx;
    if (!isCodexModel(ctx.model)) return { action: "continue" as const };
    const data = forecast(); const expensive = new RegExp(resolvedConfig(store.config).expensiveModelPattern, "i").test(ctx.model?.id ?? "");
    if (!data || !expensive || data.health === "INSUFFICIENT DATA") return { action: "continue" as const };
    if (data.health === "TAKE CARE") ctx.ui.notify("Codex runway: take care. Terra or Luna is recommended for this expensive request.", "warning");
    if (data.health === "SLOW DOWN" && ctx.hasUI) {
      const approved = await ctx.ui.confirm("Codex runway: slow down", `Current pace is ${ratio(data.paceRatio)} sustainable pace; projected ${pct(data.projectedRemainingAtReset)} at reset. Continue with ${ctx.model?.id}?`);
      if (!approved) return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });

  pi.registerCommand("codex-runway", { description: "Show/configure Codex runway (/codex-runway [refresh|history|reserve <pct>|clear])", handler: async (args, ctx) => {
    context = ctx; const [command, raw] = args.trim().split(/\s+/, 2);
    if (command === "refresh") await refresh();
    else if (command === "history") {
      const lines = (store.forecastHistory ?? []).slice(-8).reverse().map((entry) =>
        `${new Date(entry.timestamp).toLocaleString()} · ${entry.health} · ${ratio(entry.paceRatio)} pace · ${pct(entry.projectedRemainingAtReset)} @ reset · ${entry.reason}`,
      );
      if (ctx.hasUI) { ctx.ui.setWidget(WIDGET_KEY, ["CODEX RUNWAY HISTORY", ...(lines.length ? lines : ["No forecast records yet."])].map((line) => ctx.ui.theme.fg("muted", line))); ctx.ui.notify(lines.length ? lines.join("\n") : "No forecast records yet.", "info"); }
      return;
    } else if (command === "reserve") { const reservePct = Number(raw); if (!Number.isFinite(reservePct) || reservePct < 0 || reservePct >= 100) { ctx.ui.notify("Reserve must be 0–99.9%.", "error"); return; } store = { ...store, config: { ...store.config, reservePct } }; await writeStore(store); }
    else if (command === "clear") { store = { ...emptyStore(), config: store.config }; await writeStore(store); await refresh(); }
    const lines = formatDashboard(forecast()); updateUi(); if (ctx.hasUI) { ctx.ui.setWidget(WIDGET_KEY, lines.map((line) => ctx.ui.theme.fg(line.startsWith("Action:") ? "accent" : "muted", line))); ctx.ui.notify(lines.join(" · "), "info"); }
  }});
}
