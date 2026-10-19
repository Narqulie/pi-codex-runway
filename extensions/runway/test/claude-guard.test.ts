import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionQuotaGuard } from "../provider-guard";
import { claudeDispatchCredential } from "../claude-proof";
import { parseClaudeUsage } from "../sources";
import { START } from "./coordination-fixture";
import { codexModel, done, fakeProvider } from "./provider-fixture";

export const claudeModel = { ...codexModel, provider: "anthropic", api: "anthropic-messages" as const, baseUrl: "https://api.anthropic.com", id: "claude-sonnet-fixture" };
export const claudeToken = ["sk", "ant", "oat", "fixture"].join("-");
export const claudeAccount = { provider: "anthropic", accountId: JSON.stringify(["fixture-account", "fixture-org"]) };
const context = { messages: [] };
function fixture(t: any, overrides: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runway-claude-")); let now = START, profiles = 0, polls = 0, calls = 0;
  let body: any = { five_hour: { utilization: 10, resets_at: new Date(now + 18000000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(now + 604800000).toISOString() } };
  const guard = new SubscriptionQuotaGuard({ path: join(dir, "quota.sqlite"), provider: "anthropic", claudeTelemetry: true, now: () => now,
    claudeCredentials: async token => { profiles++; return { accessToken: token, account: token === claudeToken ? claudeAccount : { ...claudeAccount, accountId: "other-profile" }, verified: true, scopes: ["user:profile"] }; },
    source: () => ({ name: "claude-oauth-usage", async getObservation() { polls++; return parseClaudeUsage(body, claudeAccount, new Date(now)); } }), ...overrides });
  guard.start(); t.after(() => { guard.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = { ...fakeProvider(() => { calls++; return done(); }), id: "anthropic", getModels: () => [claudeModel] };
  const provider = guard.protect(base), run = (options: any = { apiKey: claudeToken }, model = claudeModel) => provider.streamSimple(model, context, options).result();
  return { guard, dir, base, provider, run, counts: () => ({ profiles, polls, calls }), body: () => body,
    update(change: (body: any) => void) { now += 120001; change(body); } };
}
test("Claude is transparent while off and preserves the existing provider without request shaping", async t => {
  const f = fixture(t); assert.equal(f.provider.auth, f.base.auth); assert.equal(f.provider.getModels, f.base.getModels);
  assert.equal((await f.run()).stopReason, "stop"); assert.deepEqual(f.counts(), { profiles: 0, polls: 0, calls: 1 });
  assert.deepEqual(f.guard.store.accounts(), []);
});
test("either all-model five-hour or weekly limit holds both stream modes at99%, never delegating", async t => {
  for (const window of ["five_hour", "seven_day"]) {
    const f = fixture(t); f.guard.enroll(claudeAccount); f.body()[window].utilization = 99;
    for (const stream of [f.provider.stream, f.provider.streamSimple]) {
      const held = await stream(claudeModel, context, { apiKey: claudeToken }).result();
      assert.match(held.errorMessage!, /99% stop threshold/);
    }
    assert.deepEqual(f.counts(), { profiles: 1, polls: 1, calls: 0 });
    f.update(body => { body[window].utilization = 10; });
    assert.equal((await f.run()).stopReason, "stop"); assert.equal(f.counts().calls, 1);
    assert.equal(readFileSync(join(f.dir, "quota.sqlite")).includes(Buffer.from(claudeToken)), false);
  }
});
test("Claude model-specific pools apply to the dispatched family, not unrelated models", async t => {
  const f = fixture(t); f.guard.enroll(claudeAccount);
  f.body().seven_day_opus = { utilization: 99, resets_at: f.body().seven_day.resets_at };
  assert.equal((await f.run()).stopReason, "stop");
  assert.match((await f.run({ apiKey: claudeToken }, { ...claudeModel, id: "claude-opus-fixture" })).errorMessage!, /99% stop threshold/);
  assert.equal(f.counts().calls, 1);
});
test("opaque credential profile is authoritative; changed token cannot borrow another profile or permit", async t => {
  const f = fixture(t); f.guard.enroll(claudeAccount); f.body().five_hour.utilization = 99;
  assert.equal((await f.run()).stopReason, "error");
  assert.equal((await f.run({ apiKey: claudeToken + "-other" })).stopReason, "stop");
  assert.equal(f.counts().calls, 1);
  const mutated = fixture(t, { source: (_account: any, options: any) => ({ name: "fixture", async getObservation() { options.apiKey = claudeToken + "-changed"; return parseClaudeUsage({ five_hour: { utilization: 10, resets_at: new Date(START + 18000000).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(START + 604800000).toISOString() } }, claudeAccount, new Date(START)); } }) });
  mutated.guard.enroll(claudeAccount);
  assert.match((await mutated.run()).errorMessage!, /account or route changed/); assert.equal(mutated.counts().calls, 0);
});
test("missing windows, profile failure and explicit telemetry opt-out hold protected Claude requests", async t => {
  const missing = fixture(t); missing.guard.enroll(claudeAccount); delete missing.body().five_hour;
  assert.equal((await missing.run()).stopReason, "error"); assert.equal(missing.counts().calls, 0);
  const failed = fixture(t, { claudeCredentials: async () => { throw new Error("profile permission unavailable"); } }); failed.guard.enroll(claudeAccount);
  assert.equal((await failed.run()).stopReason, "error"); assert.equal(failed.counts().calls, 0);
  const disabled = fixture(t, { claudeTelemetry: false }); disabled.guard.enroll(claudeAccount);
  assert.match((await disabled.run()).errorMessage!, /telemetry disabled/); assert.equal(disabled.counts().calls, 0);
});
test("unsupported routes/auth/header overrides cannot bypass an enrolled Claude guard", async t => {
  const f = fixture(t); f.guard.enroll(claudeAccount);
  for (const options of [{ apiKey: "not" + "-oauth" }, { apiKey: claudeToken, headers: { Authorization: "Bearer different" } }, { apiKey: claudeToken, headers: { "x-api-key": "different" } }, { apiKey: claudeToken, headers: { Host: "other.test" } }, { apiKey: claudeToken, fetch: () => {} }]) {
    assert.equal((await f.run(options as any)).stopReason, "error");
  }
  assert.equal(claudeDispatchCredential({ ...claudeModel, baseUrl: "https://other.test" }, { apiKey: claudeToken }), undefined);
  assert.equal(f.counts().calls, 0);
});
test("profile verification timeout holds without suggesting a local storage repair", async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(1));
  const keepAlive = setTimeout(() => {}, 100); t.after(() => clearTimeout(keepAlive));
  const f = fixture(t, { claudeCredentials: async () => new Promise(() => {}) }); f.guard.enroll(claudeAccount);
  const held = await f.run();
  assert.equal(held.stopReason, "error"); assert.match(held.errorMessage!, /profile verification unavailable/);
  assert.equal(f.counts().calls, 0);
});
test("owned profile verification is cancelled on shutdown, including an injected source that ignores abort", async t => {
  let started = false;
  const f = fixture(t, { claudeCredentials: async () => { started = true; return new Promise(() => {}); } }); f.guard.enroll(claudeAccount);
  const pending = f.run(); while (!started) await new Promise(resolve => setImmediate(resolve));
  f.guard.close(); assert.equal((await pending).stopReason, "aborted"); assert.equal(f.counts().calls, 0); assert.equal(f.guard.phase, "closed");
});
