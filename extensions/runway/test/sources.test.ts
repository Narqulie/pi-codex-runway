import assert from "node:assert/strict";
import test from "node:test";
import { claudeProfileCredentials, ClaudeUsageSource, parseClaudeUsage, parseWhamUsage, TelemetryError, WhamUsageSource } from "../sources";
import { evaluateAdmission, projectWeekly } from "../quota";

const now = new Date("2026-10-07T08:00:00Z");
const codex = { provider: "openai-codex", accountId: "synthetic-codex-account" };
const claude = { provider: "anthropic", accountId: "synthetic-claude-account" };
const window = (duration: number, used = 18) => ({ used_percent: used, reset_after_seconds: 7200, limit_window_seconds: duration });
const fetchBody = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 });

test("WHAM selects both windows by actual duration even when primary is weekly", () => {
  for (const [primary, secondary] of [[604800, 18000], [18000, 604800]]) {
    const observation = parseWhamUsage({ rate_limit: { primary_window: window(primary), secondary_window: window(secondary) } }, codex, now);
    assert.equal(observation.complete, true);
    assert.deepEqual(observation.windows.map((entry) => entry.durationSeconds).sort(), [18000, 604800]);
    assert.equal(projectWeekly(observation)?.remainingPct, 82);
    assert.deepEqual(projectWeekly(observation)?.account, codex);
  }
});
test("WHAM accepts the published weekly-only inventory, but not an omitted second field", () => {
  const rate_limit = { primary_window: window(604800, 40), secondary_window: null };
  const observation = parseWhamUsage({ rate_limit, additional_rate_limits: null }, codex, now);
  assert.equal(observation.complete, true);
  assert.equal(observation.issue, undefined);
  assert.equal(observation.windows.length, 1);
  assert.equal(projectWeekly(observation)?.remainingPct, 60);
  assert.equal(parseWhamUsage({ rate_limit: { primary_window: rate_limit.primary_window } }, codex, now).complete, false);
});
test("no role-based weekly guesses: short/durationless secondary cannot become weekly", () => {
  for (const secondary of [window(18000), { used_percent: 18, reset_after_seconds: 7200 }]) {
    assert.equal(projectWeekly(parseWhamUsage({ rate_limit: { secondary_window: secondary } }, codex, now)), null);
  }
  assert.equal(projectWeekly(parseWhamUsage({ rate_limit: { primary_window: window(604800) } }, codex, now))?.remainingPct, 82);
});
test("WHAM prefers absolute reset and exposes scoped/unknown pools without guessing", () => {
  const absolute = Date.parse("2026-10-08T12:00:00Z") / 1000;
  const observation = parseWhamUsage({ rate_limit: { primary_window: { ...window(604800), reset_at: absolute }, secondary_window: window(18000) }, additional_rate_limits: [{ limit_name: "special-model", rate_limit: { primary_window: window(604800, 99) } }] }, codex, now);
  assert.equal(projectWeekly(observation)?.resetTimestamp, "2026-10-08T12:00:00.000Z");
  assert.equal(observation.windows[0]?.evidence, "published");
  assert.equal(observation.windows[2]?.scope.kind, "unknown");
  assert.equal(observation.complete, false);
});
test("malformed percentages and duplicate weekly durations do not create free allowance", () => {
  for (const used of [null, "0", -1, 101]) {
    const observation = parseWhamUsage({ rate_limit: { primary_window: { ...window(604800), used_percent: used } } }, codex, now);
    assert.equal(observation.windows[0]?.evidence, "unavailable");
    assert.equal(projectWeekly(observation), null);
  }
  const duplicate = parseWhamUsage({ rate_limit: { primary_window: window(604800), secondary_window: window(604800, 99) } }, codex, now);
  assert.equal(duplicate.complete, false);
  assert.equal(projectWeekly(duplicate), null); // Conflicting roles are not blended.
});
test("WHAM transport uses injected credentials and requires stable binding before calling", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async (_url, init) => { calls++; assert.deepEqual(init?.headers, { Authorization: "Bearer synthetic", "ChatGPT-Account-Id": codex.accountId }); return fetchBody({ rate_limit: { primary_window: window(604800) } })(_url, init); };
  const source = new WhamUsageSource({ credentials: async () => ({ access: "synthetic", accountId: codex.accountId }), fetchFn });
  assert.equal((await source.getUsage()).remainingPct, 82);
  assert.equal(calls, 1);
  await assert.rejects(new WhamUsageSource({ credentials: async () => ({ access: "synthetic" }), fetchFn }).getUsage(), /stable account binding/);
  assert.equal(calls, 1);
  await assert.rejects(new WhamUsageSource({ credentials: async () => ({ access: "synthetic", accountId: codex.accountId }), fetchFn: fetchBody({ rate_limit: { primary_window: window(18000) } }) }).getUsage(), /weekly-length/);
});
test("Claude keeps all-model 5h/weekly and model-specific weekly distinct; spend is excluded", () => {
  const raw = { utilization: 64, resets_at: "2026-10-09T08:00:00Z" };
  const observation = parseClaudeUsage({ five_hour: { ...raw, utilization: 99 }, seven_day: raw, seven_day_sonnet: { ...raw, utilization: 100 }, seven_day_opus: null, seven_day_breakdown: { as_of: now.toISOString(), rows: [{ key: "claude_code", percent: 100 }] }, extra_usage: { utilization: 100 } }, claude, now);
  assert.equal(observation.complete, true);
  assert.deepEqual(observation.windows.map((entry) => entry.id), ["five_hour", "seven_day", "seven_day_sonnet"]);
  assert.deepEqual(observation.windows[2]?.scope, { kind: "models", families: ["sonnet"] });
  assert.equal(projectWeekly(observation)?.remainingPct, 36);
  assert.deepEqual(projectWeekly(observation)?.account, claude);
  const partial = parseClaudeUsage({ seven_day: raw, seven_day_future: raw, limits: [{ weekly_scoped: raw }] }, claude, now);
  assert.equal(partial.complete, false);
  assert.equal(partial.windows[0]?.usedPct, undefined);
  assert.equal(partial.windows[2]?.scope.kind, "unknown");
  assert.equal(partial.windows[3]?.scope.kind, "unknown");
});
test("Claude published limit aliases are deduplicated only when they agree with named windows", () => {
  const raw = { utilization: 36, resets_at: "2026-10-12T00:00:00.426000+00:00" };
  const body = { five_hour: { ...raw, utilization: 92 }, seven_day: raw, limits: [
    { kind: "session", group: "session", percent: 92, resets_at: raw.resets_at, scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 36, resets_at: raw.resets_at, scope: null, is_active: false },
  ] };
  const observation = parseClaudeUsage(body, claude, now);
  assert.deepEqual(observation.windows.map(window => window.id), ["five_hour", "seven_day"]);
  assert.equal(observation.complete, true);
  assert.equal(observation.issue, undefined);
  const disagreement = parseClaudeUsage({ ...body, limits: [{ ...body.limits[1], percent: 99 }] }, claude, now);
  assert.equal(disagreement.windows.at(-1)?.scope.kind, "unknown");
  assert.equal(disagreement.windows.at(-1)?.usedPct, 99);
  assert.equal(disagreement.issue, "partial");
  assert.equal(evaluateAdmission({ account: claude, modelFamily: "sonnet" }, disagreement, { protected: true, maxAgeMs: 300000 }, now).action, "hold");
});
test("Claude profile permission verifies the subscription binding without retaining tokens", async () => {
  const fetchFn: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/profile");
    assert.deepEqual(init?.headers, { Authorization: "Bearer synthetic", Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" });
    return fetchBody({ account: { uuid: "account" }, organization: { uuid: "organization" } })(url, init);
  };
  const credential = await claudeProfileCredentials("synthetic", fetchFn);
  assert.deepEqual(credential.account, { provider: "anthropic", accountId: '["account","organization"]' });
  assert.deepEqual(credential.scopes, ["user:profile"]);
  await assert.rejects(claudeProfileCredentials("synthetic", fetchBody({ account: { uuid: "account" } })), /stable account and organization/);
});
test("Claude is opt-in, requires explicit verified profile credentials and never spoofs identity", async () => {
  let credentialCalls = 0, fetchCalls = 0;
  const credentials = async () => { credentialCalls++; return { accessToken: "synthetic", account: claude, verified: true as const, scopes: ["user:profile"] }; };
  const fetchFn: typeof fetch = async (url, init) => {
    fetchCalls++;
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    assert.deepEqual(init?.headers, { Authorization: "Bearer synthetic", Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" });
    return fetchBody({ five_hour: { utilization: 2, resets_at: "2026-10-09T08:00:00Z" }, seven_day: { utilization: 3, resets_at: "2026-10-09T08:00:00Z" } })(url, init);
  };
  await assert.rejects(new ClaudeUsageSource({ enabled: false, credentials, fetchFn }).getObservation(), /not enabled/);
  assert.equal(credentialCalls, 0);
  await assert.rejects(new ClaudeUsageSource({ enabled: true, credentials: async () => ({ ...(await credentials()), scopes: ["user:inference"] }), fetchFn }).getObservation(), /user:profile/);
  assert.equal(fetchCalls, 0);
  assert.equal((await new ClaudeUsageSource({ enabled: true, credentials, fetchFn }).getObservation()).account.accountId, claude.accountId);
  assert.equal(fetchCalls, 1);
});
test("malformed published additive inventories cannot be treated as complete allowance", () => {
  const base = { rate_limit: { primary_window: window(18000), secondary_window: window(604800) } };
  for (const additional_rate_limits of [{}, [{}], [{ limit_name: "special-model", rate_limit: {} }]]) {
    const observation = parseWhamUsage({ ...base, additional_rate_limits }, codex, now);
    assert.equal(observation.complete, false);
    assert.equal(evaluateAdmission({ account: codex }, observation, { protected: true, maxAgeMs: 600000 }, now).action, "hold");
  }
  const raw = { utilization: 20, resets_at: "2026-10-09T08:00:00Z" };
  const observation = parseClaudeUsage({ five_hour: raw, seven_day: raw, limits: {} }, claude, now);
  assert.equal(observation.complete, false);
  assert.equal(evaluateAdmission({ account: claude, modelFamily: "sonnet" }, observation, { protected: true, maxAgeMs: 600000 }, now).action, "hold");
});

test("HTTP telemetry errors are classified, never inference refusal or zero consumption", async () => {
  for (const [status, issue] of [[401, "authentication"], [403, "permission"], [429, "throttled"], [500, "network"]]) {
    await assert.rejects(new WhamUsageSource({ credentials: async () => ({ access: "synthetic", accountId: codex.accountId }), fetchFn: async () => new Response("not echoed", { status: status as number }) }).getObservation(), (error: unknown) => error instanceof TelemetryError && error.issue === issue && !error.message.includes("not echoed"));
  }
});
