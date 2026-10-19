import assert from "node:assert/strict";
import test from "node:test";
import { accountKey, evaluateAdmission, formatQuotaOverview, mergeObservation } from "../quota";
import type { AccountObservation, QuotaWindow } from "../quota";
import { parseClaudeUsage, parseWhamUsage } from "../sources";
const now = new Date("2026-10-07T08:00:00Z");
const account = { provider: "anthropic", accountId: "synthetic-account-a" };
const policy = { protected: true, maxAgeMs: 600000 };
const window = (id: string, usedPct = 10): QuotaWindow => ({ id, label: id, usedPct, resetAt: "2026-10-08T08:00:00Z", observedAt: now.toISOString(), source: "fixture", revision: "1", evidence: "published", scope: { kind: "all" } });
const observation = (...windows: QuotaWindow[]): AccountObservation => ({ account, observedAt: now.toISOString(), source: "fixture", revision: "1", complete: true, windows });
const request = { account, modelFamily: "sonnet" };

test("stable account key includes provider and account, not model or rotating token", () => {
  assert.notEqual(accountKey(account), accountKey({ ...account, provider: "another" }));
  assert.notEqual(accountKey(account), accountKey({ ...account, accountId: "synthetic-account-b" }));
});
test("all applicable fresh windows must be below observed 99%; reset alone never clears weekly", () => {
  const five = window("five", 99), week = window("week", 99);
  const before = observation(five, week);
  assert.equal(evaluateAdmission(request, before, policy, now).action, "hold");
  const after = observation({ ...five, usedPct: 0 }, week);
  const decision = evaluateAdmission(request, after, policy, now, before);
  assert.deepEqual(decision.reasons, [{ windowId: "week", reason: "exhausted" }]);
  assert.equal(evaluateAdmission(request, observation({ ...five, usedPct: 98 }, { ...week, usedPct: 98 }), policy, now, before).action, "admit");
  assert.equal(evaluateAdmission(request, before, policy, new Date("2026-10-09T00:00:00Z")).action, "hold");
});
test("unknown, stale, future, partial, failed and foreign telemetry hold; unenrolled stays advisory", () => {
  const good = observation(window("week"));
  for (const raw of [undefined, observation(), { ...good, complete: false }, { ...good, account: { ...account, accountId: "different" } }, observation({ ...window("week"), usedPct: undefined, evidence: "unavailable" }), observation({ ...window("week"), observedAt: "2026-10-07T07:00:00Z" }), observation({ ...window("week"), observedAt: "2026-10-07T09:00:00Z" })]) {
    assert.equal(evaluateAdmission(request, raw, policy, now).action, "hold");
  }
  assert.equal(evaluateAdmission(request, undefined, { ...policy, protected: false }, now).action, "advisory");
  assert.equal(evaluateAdmission(request, good, policy, now).action, "admit");
});
test("partial/missing/invalid refresh and restart retention cannot erase known blocker", () => {
  const before = observation(window("weekly", 100), window("five"));
  const next = { ...observation(window("five", 0)), complete: false };
  const merged = mergeObservation(before, next, now);
  assert.equal(merged.windows.find((entry) => entry.id === "weekly")?.usedPct, 100);
  assert.equal(evaluateAdmission(request, JSON.parse(JSON.stringify(merged)), policy, now).reasons.some((entry) => entry.windowId === "weekly" && entry.reason === "exhausted"), true);
  const invalid = observation({ ...window("weekly"), usedPct: undefined, evidence: "unavailable" });
  assert.equal(mergeObservation(before, invalid, now).windows[0]?.usedPct, 100);
  assert.equal(evaluateAdmission(request, undefined, policy, now, before).reasons.some((entry) => entry.reason === "exhausted"), true);
  const staleLow = observation({ ...window("weekly", 0), observedAt: "2026-10-07T08:01:00Z" });
  const later = new Date("2026-10-07T09:00:00Z");
  assert.equal(mergeObservation(before, staleLow, later).windows[0]?.usedPct, 100);
  assert.equal(evaluateAdmission(request, staleLow, policy, later, before).action, "hold");
});
test("model-specific block does not stop unrelated family; unknown scope is not ignored", () => {
  const scoped = { ...window("sonnet", 100), scope: { kind: "models" as const, families: ["sonnet"] } };
  const raw = observation(window("all"), scoped);
  assert.equal(evaluateAdmission(request, raw, policy, now).action, "hold");
  assert.equal(evaluateAdmission({ ...request, modelFamily: "opus" }, raw, policy, now).action, "admit");
  assert.equal(evaluateAdmission({ account }, raw, policy, now).action, "hold");
  assert.equal(evaluateAdmission(request, observation({ ...scoped, scope: { kind: "unknown" } }), policy, now).action, "hold");
  const feature = observation({ ...window("feature", 100), scope: { kind: "features" as const, features: ["routines"] } });
  assert.equal(evaluateAdmission({ ...request, feature: "chat" }, feature, policy, now).action, "admit");
});
test("confirmed provider refusal persists until fresh allowance, not HTTP telemetry throttling", () => {
  const before = observation({ ...window("weekly"), usedPct: undefined, evidence: "provider-refusal" });
  assert.equal(evaluateAdmission(request, before, policy, now).action, "hold");
  const failed = { ...observation(), complete: false, issue: "throttled" as const };
  assert.equal(evaluateAdmission(request, failed, policy, now, before).reasons.some((entry) => entry.reason === "exhausted"), true);
  assert.equal(evaluateAdmission(request, observation(window("weekly")), policy, now, before).action, "admit");
});
test("adapter-to-policy fixtures preserve five-hour and weekly independently", () => {
  const raw = (utilization: number) => ({ utilization, resets_at: "2026-10-09T08:00:00Z" });
  const claude = parseClaudeUsage({ five_hour: raw(0), seven_day: raw(99), seven_day_sonnet: raw(99) }, account, now);
  assert.equal(evaluateAdmission({ ...request, modelFamily: "opus" }, claude, policy, now).action, "hold");
  const codexAccount = { provider: "openai-codex", accountId: "synthetic-codex" };
  const wham = parseWhamUsage({ rate_limit: { primary_window: { used_percent: 99, reset_after_seconds: 3600, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, reset_after_seconds: 7200, limit_window_seconds: 604800 } } }, codexAccount, now);
  assert.equal(evaluateAdmission({ account: codexAccount }, wham, policy, now).reasons[0]?.windowId, "rate_limit:18000");
});
test("obsolete observations rejected and scope changes cannot conceal a blocker", () => {
  const before = observation(window("weekly", 99));
  assert.equal(mergeObservation(before, { ...observation(window("weekly", 0)), observedAt: "2026-10-07T07:59:00Z" }, now), before);
  const changed = observation({ ...window("weekly"), scope: { kind: "models", families: ["opus"] } });
  assert.equal(evaluateAdmission(request, changed, policy, now, before).action, "hold");
});
test("overview names windows, account, reset, freshness and separates observations from installed guard status", () => {
  const lines = formatQuotaOverview([observation(window("weekly", 99), { ...window("five"), usedPct: undefined, evidence: "unavailable" })], now).join("\n");
  assert.match(lines, /advisory unless the installed provider guard reports an enrolled account/);
  assert.match(lines, /synthetic-account-a/);
  assert.match(lines, /weekly.*99% used.*observed blocker/);
  assert.match(lines, /five.*unknown/);
});

test("partial known model-scoped telemetry does not block a request outside that scope", () => {
  const raw = { utilization: 20, resets_at: "2026-10-09T08:00:00Z" };
  const parsed = parseClaudeUsage({ five_hour: raw, seven_day: raw, seven_day_sonnet: { utilization: null, resets_at: raw.resets_at } }, account, now);
  assert.equal(parsed.issue, "partial");
  assert.equal(evaluateAdmission(request, parsed, policy, now).action, "hold");
  assert.equal(evaluateAdmission({ ...request, modelFamily: "opus" }, parsed, policy, now).action, "admit");
});

test("a newer unavailable scoped row replaces healthy history without blocking unrelated models", () => {
  const raw = { utilization: 20, resets_at: "2026-10-09T08:00:00Z" };
  const before = parseClaudeUsage({ five_hour: raw, seven_day: raw, seven_day_sonnet: raw }, account, new Date(now.getTime() - 1000));
  const next = parseClaudeUsage({ five_hour: raw, seven_day: raw, seven_day_sonnet: { ...raw, utilization: null } }, account, now);
  const merged = mergeObservation(before, next, now);
  assert.equal(merged.windows.find((entry) => entry.id === "seven_day_sonnet")?.evidence, "unavailable");
  assert.equal(evaluateAdmission(request, next, policy, now, before).action, "hold");
  assert.equal(evaluateAdmission(request, merged, policy, now).action, "hold");
  assert.equal(evaluateAdmission({ ...request, modelFamily: "opus" }, merged, policy, now).action, "admit");
});

test("a malformed additive container does not invent a permanent quota window", () => {
  const raw = { utilization: 20, resets_at: "2026-10-09T08:00:00Z" };
  const malformed = parseClaudeUsage({ five_hour: raw, seven_day: raw, limits: {} }, account, new Date(now.getTime() - 1000));
  assert.equal(evaluateAdmission(request, malformed, policy, now).action, "hold");
  const clean = parseClaudeUsage({ five_hour: raw, seven_day: raw, limits: [] }, account, now);
  const recovered = mergeObservation(malformed, clean, now);
  assert.equal(evaluateAdmission(request, recovered, policy, now).action, "admit");
});

test("an obsolete healthy observation cannot supersede a newer telemetry failure", () => {
  const clean = { ...observation({ ...window("weekly", 20), observedAt: new Date(now.getTime() - 1000).toISOString() }), observedAt: new Date(now.getTime() - 1000).toISOString() };
  const failed = { ...clean, observedAt: now.toISOString(), complete: false, issue: "network" as const };
  assert.equal(mergeObservation(failed, clean, now), failed);
  assert.equal(evaluateAdmission(request, clean, policy, now, failed).action, "hold");
});

test("explicit telemetry failure cannot use a nominally complete low reading to clear exhaustion", () => {
  const before = observation(window("weekly", 99));
  const failed = { ...observation(window("weekly", 0)), issue: "permission" as const };
  const merged = mergeObservation(before, failed, now);
  assert.equal(merged.windows[0]?.usedPct, 99);
  assert.equal(evaluateAdmission(request, failed, policy, now, before).reasons.some((entry) => entry.reason === "exhausted"), true);
  assert.equal(evaluateAdmission(request, failed, policy, now).action, "hold");
});
