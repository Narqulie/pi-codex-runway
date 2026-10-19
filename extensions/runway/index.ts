import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { SubscriptionQuotaGuard, DEFAULT_PROTECTION_POLICY, registeredQuotaGuard } from "./provider-guard";
import type { GuardedProvider, GuardOptions } from "./provider-guard";
import { currentCodexAccount } from "./codex-proof";
import type { AccountBinding } from "./quota";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendForecastHistory, applySnapshot, calculateForecast, emptyStore, formatDuration, resolvedConfig } from "./core";
import { claudeProfileCredentials, ClaudeUsageSource, TelemetryError, WhamUsageSource } from "./sources";
import { accountKey, formatQuotaOverview, mergeObservation, projectWeekly } from "./quota";
import type { AccountObservation, QuotaSource } from "./quota";
import { emptyState, forecastFor, readState, writeState } from "./storage";
import { fetchEcbRate, finishReceipt, formatCompactReceipt, formatDetailedReceipt, newReceiptDraft, recordAssistant, recordManagedResult } from "./receipt";
import type { EurUsdRate, ReceiptDraft, TaskReceipt } from "./receipt";
import type { WeeklyUsageSnapshot, Forecast, RunwayStore } from "./types";
import { showRunwayDetails } from "./ui";

const STATUS_KEY = "runway";
const USAGE_STATUS_KEY = "runway-usage";
const STORE_PATH = join(homedir(), ".pi", "agent", "runway.json");
const LEGACY_STORE_PATH = join(homedir(), ".pi", "agent", "codex-runway.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const isCodexModel = (model: { provider?: string } | undefined) => model?.provider?.startsWith("openai-codex") ?? false;
const pct = (value: number | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;
const usedPct = (remainingPct: number | undefined) => pct(remainingPct == null ? undefined : 100 - remainingPct);
const ratio = (value: number | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(2)}x`;

/** Compact all-model 5h and weekly usage bars from the latest provider observation. */
export function formatUsageBars(observation: AccountObservation | undefined, width = 8): string {
  return ([[18000, "5h"], [604800, "wk"]] as const).flatMap(([seconds, label]) => {
    const used = observation?.windows.find(w => w.scope.kind === "all" && w.durationSeconds === seconds)?.usedPct;
    if (used == null) return [];
    const filled = Math.round(used / 100 * width);
    return [`${label} ${"█".repeat(filled)}${"░".repeat(width - filled)} ${Math.round(used)}%`];
  }).join(" · ");
}

export function formatDashboard(forecast: Forecast | null, now = new Date()): string[] {
  if (!forecast) return ["RUNWAY", "Usage unavailable — waiting for an account's weekly quota snapshot."];
  const resetMs = new Date(forecast.resetTimestamp).getTime() - now.getTime();
  const action = forecast.health === "SLOW DOWN" ? `SLOW DOWN about ${Math.round(((forecast.paceRatio ?? 1) - 1) * 100)}%`
    : forecast.health === "TAKE CARE" ? "TAKE CARE — favour a lighter model for suitable work"
    : forecast.health === "ON BUDGET" ? "ON BUDGET — monitor pace" : forecast.health;
  return [
    "RUNWAY",
    `Weekly: ${pct(forecast.currentRemainingPct)} left · reset ${formatDuration(resetMs)} · reserve ${pct(forecast.reservePct)}`,
    `Today: ${pct(forecast.spentTodayPct)} used · ${pct(forecast.confidence === "INSUFFICIENT" ? undefined : forecast.nominalTodayBudget)} advisory remaining`,
    `Pace: ${pct(forecast.burnPerWorkday)} / workday · sustainable ${pct(forecast.sustainableBurnPerWorkday)} / workday`,
    `Expected at reset: ${usedPct(forecast.projectedRemainingAtReset)} used · runway ${ratio(forecast.runwayRatio)}`,
    `Action: ${action} · confidence ${forecast.confidence}${forecast.snapshotAgeMinutes > 10 ? ` · data ${Math.round(forecast.snapshotAgeMinutes)}m old` : ""}`,
  ];
}

export interface RunwayOptions {
  coordinationPath?: string;
  currentAccount?: () => Promise<AccountBinding | undefined>;
  claudeTelemetry?: boolean;
  statePath?: string;
  legacyStatePath?: string;
  codexProvider?: Provider;
  claudeProvider?: Provider;
  claudeCredentials?: GuardOptions["claudeCredentials"];
}
export function registerRunway(pi: ExtensionAPI, sources?: QuotaSource[], options: RunwayOptions = {}) {
  const scopes = new Map<GuardedProvider, { guard: SubscriptionQuotaGuard; provider: Provider; release: () => void }>();
  const protectionIssues = new Map<GuardedProvider, string>();
  const lifetime = new AbortController();
  const currentAccount = options.currentAccount ?? currentCodexAccount;
  function activate(ctx: ExtensionContext, id: GuardedProvider) {
    let scope = scopes.get(id);
    if (!scope) {
      const inherited = ctx.modelRegistry?.getRegisteredNativeProvider?.(id);
      const shared = registeredQuotaGuard(inherited);
      const guard = shared?.guard ?? new SubscriptionQuotaGuard({ provider: id,
        path: options.coordinationPath ?? join(homedir(), ".pi", "agent", "runway-provider-quota.sqlite"),
        claudeCredentials: options.claudeCredentials, claudeTelemetry: options.claudeTelemetry === true });
      let provider = inherited;
      if (!shared) {
        const base = (id === "anthropic" ? options.claudeProvider : options.codexProvider) ?? ctx.modelRegistry?.getProvider?.(id);
        if (!base) throw new Error("Runway provider guard cannot initialize: public provider registry unavailable.");
        const legacy = ctx.modelRegistry?.getRegisteredProviderConfig?.(id);
        provider = guard.protect(base, inherited ? { kind: "native", provider: inherited } : legacy ? { kind: "legacy", config: legacy } : { kind: "builtin" });
      }
      scope = { guard, provider: provider!, release: guard.retain() };
      scopes.set(id, scope); pi.registerProvider(scope.provider);
    }
    if (ctx.modelRegistry?.getRegisteredNativeProvider?.(id) !== scope.provider) throw new Error("Runway provider guard was replaced; reload and check conflicting provider extensions.");
    scope.guard.start(); protectionIssues.delete(id);
    return scope.guard;
  }
  function protectionStatus(): string {
    const id: GuardedProvider = context?.model?.provider === "anthropic" ? "anthropic" : "openai-codex";
    const label = id === "anthropic" ? "Claude" : "Codex", scope = scopes.get(id);
    if (protectionIssues.has(id)) return `${label} guard UNAVAILABLE: ${protectionIssues.get(id)}`;
    if (!scope || context?.modelRegistry?.getRegisteredNativeProvider?.(id) !== scope.provider) return `${label} guard UNAVAILABLE: provider was not initialized or was replaced; reload and check extension conflicts`;
    try {
      const enrolled = scope.guard.store.accounts().filter(a => a.account.provider === id && a.policy.protected);
      return enrolled.length ? `${label} guard ON · ${enrolled.length} enrolled account(s) · stop 99% · local participating streams only`
        : `${label} guard OFF · /runway blocking on to enable`;
    } catch { return `${label} guard not ready · check /runway blocking status`; }
  }
  async function selectedBinding(ctx: ExtensionContext, service: SubscriptionQuotaGuard) {
    if (!ctx.model) throw new Error("Select a Claude or Codex model first.");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth.ok) throw new Error("Request credentials unavailable; repair authentication.");
    const account = await service.resolveAccount({ ...ctx.model, baseUrl: auth.baseUrl ?? ctx.model.baseUrl }, auth);
    if (!account) throw new Error("Resolved OAuth credential or endpoint cannot be verified for enrollment.");
    if (account.provider === "openai-codex") {
      const metadata = await currentAccount();
      if (!metadata || metadata.accountId !== account.accountId) throw new Error("Resolved Codex credential/endpoint does not match the login selected for enrollment. Repair authentication or endpoint configuration.");
    }
    return account;
  }
  let state = emptyState();
  let store: RunwayStore = emptyStore();
  let selectedAccount: string | undefined;
  let storageIssue: string | undefined;
  let alertsEnabled = true;
  let context: any;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<WeeklyUsageSnapshot | null> | undefined;
  let sourceIssue: string | undefined;
  let telemetryFailed = false;
  let activeAgentModel: string | undefined;
  let receiptDraft: ReceiptDraft | undefined;
  let eurUsd: EurUsdRate | undefined;
  let lastFxAttempt = 0;
  const forecast = () => calculateForecast(store, new Date());
  const configuredSources = sources ?? [
    new WhamUsageSource({ credentials: async () => {
      const access = await context.modelRegistry.getApiKeyForProvider("openai-codex");
      const account = await currentAccount();
      return { access, accountId: account?.accountId };
    } }),
    ...(options.claudeTelemetry ? [new ClaudeUsageSource({ enabled: true, credentials: async signal => {
      if (!context.modelRegistry.isUsingOAuth(context.model)) throw new TelemetryError("authentication", "Claude quota requires the existing OAuth login, not an API key.");
      return claudeProfileCredentials(await context.modelRegistry.getApiKeyForProvider("anthropic"), fetch, signal);
    } })] : []),
  ];

  async function save() {
    if (storageIssue) return; // Do not overwrite failed/corrupt migration input.
    await writeState(state, options.statePath ?? STORE_PATH);
  }
  function updateUi() {
    if (!context?.hasUI) return;
    const data = forecast();
    const alerts = alertsEnabled ? "" : " · alerts OFF";
    // Separate status item so bars stay readable beside long telemetry issues; the last good reading survives a failed poll.
    const observation = state.accounts.filter(entry => selectedAccount ? accountKey(entry.account) === selectedAccount : entry.account.provider === context?.model?.provider)
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const usage = formatUsageBars(observation);
    context.ui.setStatus(USAGE_STATUS_KEY, usage ? context.ui.theme.fg("dim", usage) : undefined);
    // Footer stays short: details live in /runway; only failures and an active guard are surfaced.
    const status = protectionStatus();
    const guard = status.includes("guard ON") ? " · guard ON" : status.includes("guard OFF") ? "" : " · guard ⚠";
    if (!data) {
      const text = sourceIssue ? `RUNWAY ⚠ ${sourceIssue}` : "RUNWAY loading…";
      context.ui.setStatus(STATUS_KEY, context.ui.theme.fg(sourceIssue ? "warning" : "dim", `${text}${alerts}${guard}`)); return;
    }
    const color = data.health === "SLOW DOWN" ? "error" : data.health === "TAKE CARE" || data.health === "ON BUDGET" ? "warning" : data.health === "INSUFFICIENT DATA" ? "muted" : "success";
    const compact = data.health === "INSUFFICIENT DATA"
      ? "RUNWAY learning"
      : `RUNWAY ${data.health} · ${ratio(data.paceRatio)} pace · ${usedPct(data.projectedRemainingAtReset)} @ reset`;
    // Partial inventory (e.g. an unclassified extra limit) is not a failure; it is listed in /runway.
    const issue = storageIssue ? " · ⚠ storage" : telemetryFailed ? " · ⚠ telemetry" : "";
    context.ui.setStatus(STATUS_KEY, context.ui.theme.fg(issue ? "warning" : color, `${compact}${issue}${alerts}${guard}`));
  }
  async function refresh(signal?: AbortSignal): Promise<WeeklyUsageSnapshot | null> {
    if (lifetime.signal.aborted) return null;
    signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      let snapshot: WeeklyUsageSnapshot | null = null;
      const provider = context?.model?.provider;
      if (store.lastSnapshot?.account?.provider !== provider) {
        selectedAccount = undefined;
        store = { ...emptyStore(), config: state.config };
      }
      const activeSources = sources ?? configuredSources.filter(source =>
        provider === "openai-codex" ? source.name === "codex-wham" : provider === "anthropic" && source.name === "claude-oauth-usage");
      const issues: string[] = [];
      let failed = false;
      if (!sources && provider === "anthropic" && !options.claudeTelemetry) { failed = true; issues.push("Claude telemetry disabled; enable runway.claudeTelemetry in personal settings."); }
      for (const source of activeSources) {
        try {
          const id: GuardedProvider = source.name === "claude-oauth-usage" ? "anthropic" : "openai-codex";
          const service = scopes.get(id)?.guard;
          let enrolledAccount: AccountBinding | undefined;
          if (service && !protectionIssues.has(id) && service.store.accounts().some(a => a.account.provider === id && a.policy.protected)) {
            enrolledAccount = id === "openai-codex" ? await currentAccount() : await selectedBinding(context, service);
          }
          const raw = await (service && !protectionIssues.has(id) ? service.refreshSource(source, enrolledAccount, signal) : undefined) ?? await source.getObservation(signal);
          signal.throwIfAborted();
          const key = accountKey(raw.account);
          const previous = state.accounts.find((entry) => accountKey(entry.account) === key);
          const observation = mergeObservation(previous, raw);
          state.accounts = [...state.accounts.filter((entry) => accountKey(entry.account) !== key), observation];
          const weekly = projectWeekly(raw);
          const selected = raw.account.provider === context?.model?.provider;
          let accountStore = forecastFor(state, key);
          if (weekly) {
            const sample = selected && activeAgentModel ? { ...weekly, activeModel: activeAgentModel } : weekly;
            accountStore = applySnapshot(accountStore, sample).store;
            const data = calculateForecast(accountStore);
            if (data) accountStore = appendForecastHistory(accountStore, data);
            state.forecasts[key] = accountStore;
            if (selected) snapshot = sample;
          }
          if (selected) { selectedAccount = key; store = accountStore; }
          if (raw.issue && raw.issue !== "partial") failed = true;
          if (!raw.complete || raw.issue) issues.push(`${source.name}: ${raw.issue ?? "partial"} telemetry`);
        } catch (error) {
          if (signal.aborted) return null;
          failed = true;
          const issue = error instanceof TelemetryError ? error.issue : "malformed";
          issues.push(error instanceof Error ? error.message : "Quota source failed.");
          state.accounts = state.accounts.map((entry) => entry.source === source.name ? { ...entry, complete: false, issue } : entry);
        }
      }
      if (signal.aborted) return null;
      sourceIssue = issues.length ? issues.join("; ") : undefined;
      telemetryFailed = failed;
      await save(); if (!signal.aborted) updateUi(); return snapshot;
    })().catch((error) => { if (lifetime.signal.aborted) return null; telemetryFailed = true; sourceIssue = error instanceof Error ? error.message : "Quota refresh failed."; updateUi(); return null; })
      .finally(() => { refreshInFlight = undefined; });
    return refreshInFlight;
  }
  async function exchangeRate(): Promise<EurUsdRate | undefined> {
    if (Date.now() - lastFxAttempt >= 60 * 60_000) {
      lastFxAttempt = Date.now();
      try { eurUsd = await fetchEcbRate() ?? eurUsd; } catch { /* show USD if ECB is unavailable */ }
    }
    return eurUsd && Date.now() - Date.parse(eurUsd.date) < 7 * 86_400_000 ? eurUsd : undefined;
  }
  function maybeWarn(data: Forecast | null) {
    if (!alertsEnabled || !context?.hasUI || !data || data.health === "INSUFFICIENT DATA") return;
    if (data.health === "SLOW DOWN") context.ui.notify(`Runway forecast: slow down. Current pace is ${ratio(data.paceRatio)} of sustainable pace.`, "warning");
    else if (data.health === "TAKE CARE") context.ui.notify(`Runway forecast: take care; current pace is ${ratio(data.paceRatio)} of sustainable pace.`, "warning");
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx; receiptDraft = undefined; alertsEnabled = true;
    for (const id of ["openai-codex", "anthropic"] as const) {
      try { activate(ctx, id); } catch (error) { protectionIssues.set(id, error instanceof Error ? error.message : "Provider guard initialization failed."); }
    }
    try { state = await readState(options.statePath ?? STORE_PATH, options.legacyStatePath ?? LEGACY_STORE_PATH); storageIssue = undefined; }
    catch (error) {
      storageIssue = error instanceof Error ? error.message : "State migration failed.";
      if (ctx.hasUI) ctx.ui.notify(`Runway storage disabled: ${storageIssue} Original files preserved.`, "warning");
    }
    selectedAccount = undefined; store = { ...emptyStore(), config: state.config }; updateUi(); await refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer); timer = undefined; receiptDraft = undefined; lifetime.abort();
    for (const [id, { guard, provider, release }] of scopes) {
      release();
      if ((guard.phase === "closing" || guard.phase === "closed") && ctx.modelRegistry.getRegisteredNativeProvider(id) === provider) {
        const origin = registeredQuotaGuard(provider)!.origin;
        if (origin.kind === "native") pi.registerProvider(origin.provider);
        else if (origin.kind === "legacy") pi.registerProvider(id, origin.config);
        else pi.unregisterProvider(id);
      }
    }
    scopes.clear();
    if (ctx.hasUI) { ctx.ui.setStatus(STATUS_KEY, undefined); ctx.ui.setStatus(USAGE_STATUS_KEY, undefined); }
  });
  pi.on("agent_start", async (_event, ctx) => {
    context = ctx;
    activeAgentModel = ctx.model?.id;
    const firstStart = !receiptDraft;
    if (firstStart) receiptDraft = newReceiptDraft();
    const snapshot = await refresh(ctx.signal);
    if (firstStart && receiptDraft) { receiptDraft.quotaBefore = snapshot ?? undefined; receiptDraft.healthBefore = snapshot ? forecast()?.health : undefined; }
  });
  pi.on("message_end", (event) => { if (receiptDraft) recordAssistant(receiptDraft, event.message); });
  pi.on("tool_result", (event) => { if (receiptDraft) recordManagedResult(receiptDraft, event.toolName, event.details, event.toolCallId); });
  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx;
    const endedAt = new Date();
    const snapshot = await refresh();
    activeAgentModel = undefined;
    const data = forecast();
    const draft = receiptDraft; receiptDraft = undefined;
    if (!draft || (!draft.parent.turns && !draft.children.size && !draft.pendingRunIds.size)) { maybeWarn(data); return; }
    const receipt = finishReceipt(draft, snapshot ?? undefined, data, await exchangeRate(), endedAt);
    pi.appendEntry("runway-receipt", receipt);
    if (ctx.hasUI) ctx.ui.notify(formatCompactReceipt(receipt), alertsEnabled && (data?.health === "SLOW DOWN" || data?.health === "TAKE CARE") ? "warning" : "info");
  });
  pi.on("model_select", async (_event, ctx) => { context = ctx; await refreshInFlight; await refresh(); });

  // Forecast advice is separate from quota policy. Provider dispatch owns the guard.
  pi.on("input", async (event, ctx) => {
    context = ctx;
    if (!alertsEnabled || !isCodexModel(ctx.model)) return { action: "continue" as const };
    const data = forecast(); const expensive = new RegExp(resolvedConfig(store.config).expensiveModelPattern, "i").test(ctx.model?.id ?? "");
    if (!data || !expensive || data.health === "INSUFFICIENT DATA") return { action: "continue" as const };
    if (data.health === "TAKE CARE") ctx.ui.notify("Runway forecast: take care. Luna is recommended when the task permits.", "warning");
    if (data.health === "SLOW DOWN" && ctx.hasUI) {
      const approved = await ctx.ui.confirm("Runway forecast: slow down", `Current pace is ${ratio(data.paceRatio)} sustainable pace; projected ${pct(data.projectedRemainingAtReset)} at reset. Continue with ${ctx.model?.id}?`);
      if (!approved) return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });

  const command: Parameters<ExtensionAPI["registerCommand"]>[1] = { description: "Quota overview · alerts on|off|status · blocking on|off|status · receipt · refresh",
    getArgumentCompletions: prefix => ["alerts on", "alerts off", "alerts status", "blocking on", "blocking off", "blocking status", "receipt", "refresh", "history", "reserve", "clear"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
    context = ctx; let [command, raw, concurrencyRaw]: (string | undefined)[] = args.trim().split(/\s+/);
    if (command === "alerts") {
      if (concurrencyRaw || raw && !["on", "off", "status"].includes(raw)) { ctx.ui.notify("Usage: /runway alerts on|off|status (this session only; quota blocking unchanged).", "error"); return; }
      if (raw === "on" || raw === "off") alertsEnabled = raw === "on";
      updateUi(); ctx.ui.notify(`Runway forecast alerts ${alertsEnabled ? "ON" : "OFF"} for this session; quota blocking unchanged.`, "info"); return;
    }
    if (command === "blocking") {
      if (concurrencyRaw || raw && !["on", "off", "status"].includes(raw)) { ctx.ui.notify("Usage: /runway blocking on|off|status (current Claude or Codex account; stop at 99%).", "error"); return; }
      command = raw === "on" ? "protect" : raw === "off" ? "disable" : "status";
      raw = undefined; concurrencyRaw = undefined;
    }
    if (command === "protect" || command === "disable") {
      try {
        const id = ctx.model?.provider;
        if (id !== "openai-codex" && id !== "anthropic") throw new Error("Select a Claude or Codex model before changing its guard.");
        if (id === "anthropic" && !options.claudeTelemetry) throw new Error("Enable runway.claudeTelemetry before changing Claude protection. This quota guard is not an extra-usage spending cap.");
        const service = activate(ctx, id);
        const account = await selectedBinding(ctx, service);
        if (command === "disable") service.disable(account);
        else {
          const maxAgeMs = raw == null ? DEFAULT_PROTECTION_POLICY.maxAgeMs : Number(raw);
          const concurrency = concurrencyRaw == null ? DEFAULT_PROTECTION_POLICY.concurrency : Number(concurrencyRaw);
          if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 120_000 || maxAgeMs > 300_000 || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Protection bounds: maxAgeMs 120000–300000, concurrency 1–8; threshold fixed at 99%.");
          service.enroll(account, { ...DEFAULT_PROTECTION_POLICY, maxAgeMs, concurrency });
        }
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Protection command failed.", "error"); return; }
      updateUi(); ctx.ui.notify(protectionStatus(), "info"); return;
    } else if (command === "status") {
      updateUi(); ctx.ui.notify(protectionStatus(), "info"); return;
    } else if (command === "refresh") {
      await refresh();
      ctx.ui.notify(sourceIssue ? `Runway refresh failed: ${sourceIssue}` : storageIssue ? `Runway refreshed; storage disabled: ${storageIssue}` : "Runway refreshed.", sourceIssue || storageIssue ? "warning" : "info");
      return;
    } else if (command === "receipt") {
      const entry = [...ctx.sessionManager.getBranch()].reverse().find((item) => item.type === "custom" && (item.customType === "runway-receipt" || item.customType === "codex-runway-receipt"));
      const receipt = entry?.type === "custom" ? entry.data as TaskReceipt : undefined;
      const lines = receipt ? formatDetailedReceipt(receipt) : ["RUNWAY · LAST TASK", "No completed task receipt in this session yet."];
      await showRunwayDetails(ctx, lines);
      return;
    } else if (command === "history") {
      const lines = (store.forecastHistory ?? []).slice(-8).reverse().map((entry) =>
        `${new Date(entry.timestamp).toLocaleString()} · ${entry.health} · ${ratio(entry.paceRatio)} pace · ${pct(entry.projectedRemainingAtReset)} @ reset · ${entry.reason}`,
      );
      await showRunwayDetails(ctx, ["RUNWAY HISTORY", ...(lines.length ? lines : ["No forecast records yet."])]);
      return;
    } else if (command === "reserve") {
      const reservePct = Number(raw);
      if (!Number.isFinite(reservePct) || reservePct < 0 || reservePct >= 100) { ctx.ui.notify("Reserve must be 0–99.9%.", "error"); return; }
      state.config = { ...state.config, reservePct };
      store = { ...store, config: { ...store.config, reservePct } };
      for (const forecastStore of Object.values(state.forecasts)) forecastStore.config = { ...forecastStore.config, reservePct };
      if (state.legacyForecast) state.legacyForecast.config = { ...state.legacyForecast.config, reservePct };
      await save(); updateUi();
      ctx.ui.notify(storageIssue ? `Reserve changed for this session; storage disabled: ${storageIssue}` : `Runway reserve set to ${reservePct}%.`, storageIssue ? "warning" : "info");
      return;
    } else if (command === "clear") {
      store = { ...emptyStore(), config: store.config };
      if (selectedAccount) state.forecasts[selectedAccount] = store;
      else state.legacyForecast = store;
      await save(); await refresh();
      ctx.ui.notify(storageIssue ? `Forecast history cleared for this session; storage disabled: ${storageIssue}` : sourceIssue ? `Runway forecast history cleared; telemetry unavailable: ${sourceIssue}` : "Runway forecast history cleared.", storageIssue || sourceIssue ? "warning" : "info");
      return;
    }
    let displayedAccounts = state.accounts;
    const enrollmentLines: string[] = [];
    const ready = [...scopes.values()].find(s => s.guard.phase === "ready");
    if (ready) {
      try {
        for (const enrolled of ready.guard.store.accounts().filter(a => a.policy.protected)) {
          enrollmentLines.push(`Enrolled ${enrolled.account.provider} · ${enrolled.account.accountId} · generation ${enrolled.generation} · ${enrolled.policy.maxAgeMs}ms freshness · concurrency ${enrolled.policy.concurrency}${enrolled.observation ? "" : " · telemetry unavailable (HOLD)"}`);
          // Display protected evidence from its authority, not a possibly stale advisory JSON copy.
          displayedAccounts = displayedAccounts.filter(a => accountKey(a.account) !== accountKey(enrolled.account));
          if (enrolled.observation) displayedAccounts = [...displayedAccounts, enrolled.observation];
        }
      } catch { enrollmentLines.push("Coordination unavailable: guarded subscription streams cannot start."); }
    }
    const overview = formatQuotaOverview(displayedAccounts);
    overview.splice(1, 2, protectionStatus(), "Forecasts advisory. Guard covers participating Claude/Codex provider streams; not direct HTTP or provider-internal retries. Claude plan quota is not an extra-usage spending cap. Holds are terminal, not automatic reset waits. No routing/paid fallback.", ...enrollmentLines);
    const lines = [...overview, `Forecast alerts: ${alertsEnabled ? "ON" : "OFF"} for this session · /runway alerts on|off`, ...(sourceIssue ? [`Telemetry: ${sourceIssue}`] : []), ...(storageIssue ? [`Storage: ${storageIssue}; persistence disabled, original preserved.`] : []), selectedAccount ? `Forecast account: ${selectedAccount}` : "Legacy forecast: account unbound (not admission evidence)", ...formatDashboard(forecast()).slice(1)]; updateUi(); await showRunwayDetails(ctx, lines);
  }};
  pi.registerCommand("runway", command);
  pi.registerCommand("codex-runway", { ...command, description: "Transitional alias for /runway" });
}

export default async function runway(pi: ExtensionAPI) {
  let settings: { runway?: { claudeTelemetry?: boolean } } = {};
  try { settings = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "settings.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  registerRunway(pi, undefined, { claudeTelemetry: settings.runway?.claudeTelemetry === true });
}
