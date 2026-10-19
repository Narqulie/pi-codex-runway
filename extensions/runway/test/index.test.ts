import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDashboard, formatUsageBars, registerRunway } from "../index";
import { applySnapshot, calculateForecast, emptyStore } from "../core";
import { finishReceipt, newReceiptDraft, recordAssistant } from "../receipt";
import { accountKey } from "../quota";
import type { QuotaSource } from "../quota";
import { emptyState, writeState } from "../storage";
import { codexModel, codexAccount, token, fakeProvider } from "./provider-fixture";

test("package discovery uses renamed entry point and retains the actual repository URL", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  assert.equal(manifest.name, "pi-runway");
  assert.equal(lock.name, "pi-runway");
  assert.deepEqual(manifest.pi.extensions, ["./extensions/runway/index.ts"]);
  assert.equal(manifest.repository.url, "git+https://github.com/Narqulie/pi-codex-runway.git");
});
test("primary command and transitional alias read legacy and neutral receipts without rewriting history", async () => {
  const commands = new Map<string, any>(), events = new Map<string, any>();
  registerRunway({ registerProvider: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => events.set(name, handler) } as any, []);
  assert.deepEqual([...commands.keys()], ["runway", "codex-runway"]);
  assert.equal(commands.get("runway").handler, commands.get("codex-runway").handler);
  assert.equal(events.has("before_provider_request"), false);
  assert.equal(events.has("before_provider_headers"), false);
  const draft = newReceiptDraft();
  recordAssistant(draft, { role: "assistant", provider: "anthropic", model: "fixture", usage: { input: 10, output: 5 } });
  const receipt = finishReceipt(draft, undefined, null);
  for (const customType of ["codex-runway-receipt", "runway-receipt"]) {
    const branch = [{ type: "custom", customType, data: receipt }];
    const original = JSON.stringify(branch), notices: string[] = [], panels: string[] = [];
    const ctx = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => branch }, ui: {
      theme: { fg: (_style: string, text: string) => text }, setStatus: () => {},
      setWidget: () => assert.fail("Commands must not create persistent widgets"),
      notify: (text: string) => notices.push(text),
      custom: async (factory: Function) => {
        const panel = factory({ terminal: { rows: 100 }, requestRender: () => {} }, ctx.ui.theme, {}, () => {});
        panels.push(panel.render(160).join("\n"));
        panel.handleInput("\r");
      },
    } };
    await commands.get("runway").handler("receipt", ctx);
    assert.match(panels[0]!, /RUNWAY · LAST TASK/);
    assert.match(panels[0]!, /anthropic\/fixture/);
    assert.equal(JSON.stringify(branch), original);
    await commands.get("codex-runway").handler("", ctx);
    assert.match(panels[1]!, /Codex guard UNAVAILABLE/);
    assert.doesNotMatch(panels[1]!, /pending native admission integration/);
    assert.deepEqual(notices, []);
  }
});

test("supported provider registration replaces ABI integration; enrollment verifies prepared auth and is explicit/bounded", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-extension-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commands = new Map<string, any>(), events = new Map<string, any>(), notices: string[] = [];
  let provider: any, credential = token();
  const registry = { getProvider: () => fakeProvider(), getRegisteredNativeProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: credential }) };
  const api = { registerProvider: (value: any) => { provider = value; }, unregisterProvider: () => { provider = undefined; }, registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => events.set(name, handler) };
  registerRunway(api as any, [], { coordinationPath: join(dir, "quota.sqlite"), currentAccount: async () => codexAccount });
  const ctx: any = { model: codexModel, modelRegistry: {}, hasUI: true, sessionManager: { getBranch: () => [] }, ui: { theme: { fg: (_style: string, text: string) => text }, setWidget: () => {}, setStatus: () => {}, notify: (text: string) => notices.push(text) } };
  t.after(async () => events.get("session_shutdown")({}, ctx));
  const handler = commands.get("runway").handler;
  assert.equal(provider, undefined); // Install through the supported bound registry, not loader aliases.
  assert.deepEqual(commands.get("runway").getArgumentCompletions("blocking o").map((item: any) => item.value), ["blocking on", "blocking off"]);
  await handler("blocking on", ctx); assert.match(notices.at(-1)!, /public provider registry unavailable/);
  ctx.modelRegistry = registry;
  await handler("protect 999999 9", ctx); assert.match(notices.at(-1)!, /Protection bounds/);
  await handler("blocking status", ctx); assert.match(notices.at(-1)!, /Codex guard OFF/);
  assert.doesNotMatch(notices.at(-1)!, /ABI|native admission/);
  await handler("protect 300000 2", ctx); assert.match(notices.at(-1)!, /Codex guard ON.*1 enrolled account.*stop 99%/);
  const registration = provider;
  await handler("blocking status", ctx); assert.equal(provider, registration);
  await handler("blocking off", ctx); assert.match(notices.at(-1)!, /Codex guard OFF/);
  await handler("blocking on", ctx); assert.match(notices.at(-1)!, /Codex guard ON/);
  await handler("alerts off", ctx); assert.match(notices.at(-1)!, /forecast alerts OFF/);
  await handler("blocking status", ctx); assert.match(notices.at(-1)!, /Codex guard ON/);
  assert.equal(provider, registration);
  await handler("blocking off extra", ctx); assert.match(notices.at(-1)!, /Usage: \/runway blocking/);
  await handler("blocking status", ctx); assert.match(notices.at(-1)!, /Codex guard ON/);
  await handler("disable", ctx); assert.match(notices.at(-1)!, /Codex guard OFF/);
  credential = token("other"); await handler("blocking on", ctx); assert.match(notices.at(-1)!, /does not match/);
  ctx.model = { provider: "anthropic", id: "fixture" };
  await handler("blocking on", ctx); assert.match(notices.at(-1)!, /Enable runway.claudeTelemetry/);
});

test("default sources select the active provider, bind Claude quota, and keep forecasts separate", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-provider-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commands = new Map<string, any>(), events = new Map<string, any>(), statuses: string[] = [], entries: any[] = [], calls: string[] = [];
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const reset = new Date(Date.now() + 7 * 86400000).toISOString();
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.includes("ecb.europa.eu")) return new Response("", { status: 503 });
    calls.push(endpoint);
    assert.equal((init?.headers as any).Authorization, "Bearer synthetic");
    const body = endpoint.endsWith("/profile") ? { account: { uuid: "claude-account" }, organization: { uuid: "claude-organization" } }
      : endpoint.endsWith("/usage") && endpoint.includes("anthropic.com") ? { five_hour: { utilization: 18, resets_at: reset }, seven_day: { utilization: 30, resets_at: reset }, seven_day_breakdown: { rows: [{ key: "claude_code", percent: 100 }] }, limits: [{ kind: "session", percent: 18, resets_at: reset, scope: null }, { kind: "weekly_all", percent: 30, resets_at: reset, scope: null }] }
      : { rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: Date.parse(reset) / 1000 }, secondary_window: null }, additional_rate_limits: null };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const providers = new Map<string, any>();
  const api = { registerProvider: (value: any) => { providers.set(value.id, value); }, unregisterProvider: (id: string) => { providers.delete(id); }, registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => events.set(name, handler), appendEntry: (_type: string, receipt: any) => entries.push(receipt) };
  registerRunway(api as any, undefined, { claudeTelemetry: true, coordinationPath: join(dir, "quota.sqlite"), statePath: join(dir, "state.json"), legacyStatePath: join(dir, "absent.json"), currentAccount: async () => ({ provider: "openai-codex", accountId: "codex-account" }) });
  const ctx = { model: { provider: "anthropic", id: "claude-sonnet-fixture" }, modelRegistry: { getProvider: (id: string) => ({ ...fakeProvider(), id }), getRegisteredNativeProvider: (id: string) => providers.get(id), isUsingOAuth: () => true, getApiKeyForProvider: async () => "synthetic" }, hasUI: true,
    ui: { theme: { fg: (_style: string, text: string) => text }, setStatus: (_key: string, text: string) => statuses.push(text), setWidget: () => {}, notify: () => {} } };
  t.after(async () => { await events.get("session_shutdown")({}, ctx); });
  await events.get("session_start")({}, ctx);
  assert.deepEqual(calls, ["https://api.anthropic.com/api/oauth/profile", "https://api.anthropic.com/api/oauth/usage"]);
  assert.match(statuses.at(-1)!, /RUNWAY learning/);
  assert.doesNotMatch(statuses.at(-1)!, /degraded|unavailable:/i);
  await events.get("agent_start")({}, ctx);
  // No token usage is necessary to exercise the bound before/after quota receipt.
  await events.get("message_end")({ message: { role: "assistant", provider: "anthropic", model: ctx.model.id, usage: {} } });
  await events.get("agent_settled")({}, ctx);
  assert.equal(entries[0].quotaBefore.remainingPct, 70);
  assert.equal(entries[0].quotaAfter.remainingPct, 70);
  assert.equal(entries[0].quotaAfter.account.provider, "anthropic");
  ctx.model = { provider: "openai-codex", id: "codex-fixture" };
  await events.get("model_select")({}, ctx);
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(state.version, 2);
  assert.equal(Object.keys(state.forecasts).length, 2);
  assert.deepEqual(state.accounts.find((a: any) => a.account.provider === "anthropic").windows.map((w: any) => w.durationSeconds), [18000, 604800]);
  assert.equal(state.accounts.find((a: any) => a.account.provider === "openai-codex").complete, true);
  assert.doesNotMatch(statuses.at(-1)!, /telemetry degraded/);
  assert.equal(JSON.stringify(state).includes("synthetic"), false);
  const disabledEvents = new Map<string, any>();
  registerRunway({ ...api, on: (name: string, handler: any) => disabledEvents.set(name, handler) } as any, undefined, { coordinationPath: join(dir, "disabled.sqlite"), statePath: join(dir, "disabled.json"), legacyStatePath: join(dir, "absent.json") });
  const before = calls.length;
  ctx.model = { provider: "anthropic", id: "claude-sonnet-fixture" };
  await disabledEvents.get("session_start")({}, ctx);
  assert.equal(calls.length, before);
  assert.match(statuses.at(-1)!, /Claude telemetry disabled/);
  await disabledEvents.get("session_shutdown")({}, ctx);
});

test("read commands use temporary panels; refresh and forecast changes only confirm briefly", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-command-ui-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const commands = new Map<string, any>(), panels: string[] = [], notices: string[] = [];
  registerRunway({ registerProvider: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: () => {} } as any, [], { statePath: join(dir, "state.json") });
  const ctx: any = { mode: "tui", hasUI: true, sessionManager: { getBranch: () => [] }, ui: {
    theme: { fg: (_style: string, text: string) => text }, setStatus: () => {},
    setWidget: () => assert.fail("Commands must not create persistent widgets"),
    notify: (text: string) => notices.push(text),
    custom: async (factory: Function, options: any) => {
      assert.equal(options.overlay, true);
      let closed = false;
      const panel = factory({ terminal: { rows: 100 }, requestRender: () => {} }, ctx.ui.theme, {}, () => { closed = true; });
      panels.push(panel.render(120).join("\n"));
      panel.handleInput("\x1b");
      assert.equal(closed, true);
    },
  } };
  const handler = commands.get("runway").handler;
  for (const args of ["", "receipt", "history", ""]) await handler(args, ctx);
  assert.equal(panels.length, 4);
  assert.deepEqual(notices, []);
  for (const args of ["refresh", "reserve 15", "clear", "blocking status"]) await handler(args, ctx);
  assert.equal(panels.length, 4);
  assert.equal(notices.length, 4);
  assert.ok(notices.every(text => !text.includes("QUOTA OVERVIEW") && !text.includes("\n")));
  assert.equal(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).config.reservePct, 15);
});

test("session alert toggle suppresses forecast prompts and warnings, preserves receipts, and resets on startup", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-alerts-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = new Date(), resetTimestamp = new Date(now.getTime() + 7 * 86400000).toISOString();
  const day = new Date(now); day.setDate(day.getDate() - 1);
  while (day.getDay() === 0 || day.getDay() === 6) day.setDate(day.getDate() - 1);
  day.setHours(9, 0, 0, 0);
  const sample = (remainingPct: number, fetchedAt: string) => ({ remainingPct, fetchedAt, resetTimestamp, source: "fixture", account: codexAccount });
  let store = emptyStore(); store.config = { minimumForecastSamples: 1 };
  store = applySnapshot(store, sample(65, day.toISOString())).store;
  day.setHours(16);
  store = applySnapshot(store, sample(40, day.toISOString())).store;
  store = applySnapshot(store, sample(40, now.toISOString())).store;
  assert.equal(calculateForecast(store, now)!.health, "SLOW DOWN");
  const state = emptyState(); state.forecasts[accountKey(codexAccount)] = store;
  await writeState(state, join(dir, "state.json"));
  const source: QuotaSource = { name: "fixture", getObservation: async () => ({ account: codexAccount, observedAt: now.toISOString(), source: "fixture", revision: "1", complete: true,
    windows: [{ id: "weekly", label: "Weekly", scope: { kind: "all" }, durationSeconds: 604800, usedPct: 60, resetAt: resetTimestamp, observedAt: now.toISOString(), source: "fixture", revision: "1", evidence: "published" }] }) };
  const commands = new Map<string, any>(), events = new Map<string, any>(), notices: Array<{ text: string; level: string }> = [], statuses: string[] = [], entries: string[] = [];
  let confirmations = 0;
  registerRunway({ registerProvider: () => {}, registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => events.set(name, handler), appendEntry: (type: string) => entries.push(type) } as any,
    [source], { statePath: join(dir, "state.json"), legacyStatePath: join(dir, "absent.json") });
  const ctx: any = { model: { ...codexModel, id: "gpt-6.1-sol" }, modelRegistry: {}, hasUI: true, ui: {
    theme: { fg: (_style: string, text: string) => text }, setStatus: (_key: string, text: string) => statuses.push(text),
    notify: (text: string, level: string) => notices.push({ text, level }), confirm: async () => { confirmations++; return false; },
  } };
  t.after(async () => events.get("session_shutdown")({}, ctx));
  const handler = commands.get("runway").handler, input = () => events.get("input")({ text: "fixture", source: "interactive" }, ctx);
  await events.get("session_start")({}, ctx);
  await handler("alerts status", ctx); assert.match(notices.at(-1)!.text, /forecast alerts ON/);
  assert.deepEqual(commands.get("runway").getArgumentCompletions("alerts o").map((item: any) => item.value), ["alerts on", "alerts off"]);
  assert.deepEqual(await input(), { action: "handled" }); assert.equal(confirmations, 1);
  await events.get("agent_settled")({}, ctx); assert.match(notices.at(-1)!.text, /slow down/);
  await commands.get("codex-runway").handler("alerts off", ctx);
  assert.match(statuses.at(-1)!, /alerts OFF/);
  assert.deepEqual(await input(), { action: "continue" }); assert.equal(confirmations, 1);
  const count = notices.length;
  await events.get("agent_settled")({}, ctx); assert.equal(notices.length, count);
  for (const args of ["alerts banana", "alerts on extra"]) {
    await handler(args, ctx); assert.match(notices.at(-1)!.text, /Usage: \/runway alerts/);
  }
  await handler("alerts", ctx); assert.match(notices.at(-1)!.text, /forecast alerts OFF/);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("", { status: 503 });
  await events.get("agent_start")({}, ctx);
  events.get("message_end")({ message: { role: "assistant", provider: "openai-codex", model: ctx.model.id, usage: { input: 10, output: 5 } } });
  await events.get("agent_settled")({}, ctx);
  assert.deepEqual(entries, ["runway-receipt"]); assert.equal(notices.at(-1)!.level, "info");
  await handler("alerts on", ctx); assert.doesNotMatch(statuses.at(-1)!, /alerts OFF/);
  assert.deepEqual(await input(), { action: "handled" }); assert.equal(confirmations, 2);
  await handler("alerts off", ctx);
  await events.get("session_start")({}, ctx);
  await handler("alerts status", ctx); assert.match(notices.at(-1)!.text, /forecast alerts ON/);
  assert.deepEqual(await input(), { action: "handled" }); assert.equal(confirmations, 3);
});

test("insufficient forecast data is shown as unknown advisory budget, not exhausted quota", () => {
  const now = new Date("2026-01-12T10:00:00.000Z");
  const store = applySnapshot(emptyStore(), { remainingPct: 88, resetTimestamp: "2026-01-19T10:00:00.000Z", fetchedAt: now.toISOString(), source: "fixture" }).store;
  const forecast = calculateForecast(store, now)!;
  assert.equal(forecast.confidence, "INSUFFICIENT");
  const dashboard = formatDashboard(forecast, now).join("\n");
  assert.match(dashboard, /88.0% left/);
  assert.match(dashboard, /— advisory remaining/);
});

test("usage bars show all-model 5h and weekly windows only", () => {
  const window = (id: string, durationSeconds: number | undefined, usedPct: number, kind: "all" | "unknown" = "all") =>
    ({ id, label: id, scope: { kind }, durationSeconds, usedPct, observedAt: "", source: "", revision: "", evidence: "published" as const });
  const observation: any = { windows: [window("five_hour", 18000, 50), window("seven_day", 604800, 5), window("limits:2", undefined, 90, "unknown")] };
  assert.equal(formatUsageBars(observation), "5h ████░░░░ 50% · wk ░░░░░░░░ 5%");
  assert.equal(formatUsageBars(undefined), "");
});
