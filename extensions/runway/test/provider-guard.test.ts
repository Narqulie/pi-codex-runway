import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import { SubscriptionQuotaGuard, DEFAULT_PROTECTION_POLICY } from "../provider-guard";
import { codexDispatchAccount } from "../codex-proof";
import { observation, START } from "./coordination-fixture";

import { codexAccount, token, codexModel, message, done, fakeProvider } from "./provider-fixture";
function fixture(t: any, extra: Partial<ConstructorParameters<typeof SubscriptionQuotaGuard>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "runway-provider-")); let now = START, reading = observation(10, now, codexAccount), polls = 0;
  const guard = new SubscriptionQuotaGuard({ path: join(dir, "quota.sqlite"), now: () => now, source: () => ({ name: "fixture", async getObservation() { polls++; return reading; } }), ...extra });
  guard.start(); t.after(() => { guard.close(); rmSync(dir, { recursive: true, force: true }); });
  return { guard, dir, polls: () => polls, protect: () => guard.enroll(codexAccount),
    update(used: number, modify?: (value: typeof reading) => void) { now += 120001; reading = observation(used, now, codexAccount); modify?.(reading); },
    setReading(value: typeof reading) { reading = value; }, advance(ms: number) { now += ms; }, now: () => now };
}
const context = { messages: [] };
const options = { apiKey: token() };

test("off is transparent: preserves provider, models, auth, options and both stream modes; no telemetry", async t => {
  const f = fixture(t); let full = 0, simple = 0;
  const base = fakeProvider((_m, c, o) => { full++; assert.equal(c, context); assert.equal((o as any).reasoningEffort, "high"); return done(); }, () => { simple++; return done(); });
  const provider = f.guard.protect(base);
  assert.equal(provider.id, base.id); assert.equal(provider.auth, base.auth); assert.equal(provider.getModels, base.getModels);
  assert.equal((await provider.stream(codexModel, context, { ...options, reasoningEffort: "high" } as any).result()).stopReason, "stop");
  assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "stop");
  assert.deepEqual([full, simple, f.polls()], [1, 1, 0]); assert.equal(f.guard.store.accounts().length, 0);
});
test("99% holds full and simple without delegating; fresh lower readings permit only a new request", async t => {
  const f = fixture(t); f.protect(); f.update(99); let calls = 0;
  const provider = f.guard.protect(fakeProvider(() => { calls++; return done(); }));
  for (const stream of [provider.stream, provider.streamSimple]) {
    const held = await stream(codexModel, context, options).result();
    assert.equal(held.stopReason, "error"); assert.match(held.errorMessage!, /99% stop threshold/); assert.equal(isRetryableAssistantError(held), false);
  }
  assert.equal(calls, 0); assert.equal(f.polls(), 1);
  f.update(10); assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "stop"); assert.equal(calls, 1);
  assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "stop"); assert.equal(calls, 2);
  assert.equal(f.polls(), 2); // One fenced poll shared across logical calls, not a probe for every stream.
  assert.equal(readFileSync(join(f.dir, "quota.sqlite")).includes(Buffer.from(token())), false);
});
test("stale, missing, partial and failed telemetry fail closed and are not Pi retryable errors", async t => {
  for (const kind of ["stale", "missing", "partial", "failure"]) {
    const f = fixture(t, kind === "failure" ? { source: () => ({ name: "fixture", async getObservation() { throw new Error("synthetic failure"); } }) } : {});
    f.protect(); if (kind === "stale") f.setReading(observation(10, START - 300001, codexAccount));
    if (kind === "missing") f.setReading({ ...observation(10, START, codexAccount), windows: [], complete: false });
    if (kind === "partial") f.setReading({ ...observation(10, START, codexAccount), complete: false });
    let calls = 0; const provider = f.guard.protect(fakeProvider(() => { calls++; return done(); }));
    const held = await provider.streamSimple(codexModel, context, options).result();
    assert.equal(calls, 0, kind); assert.equal(held.stopReason, "error", kind); assert.equal(isRetryableAssistantError(held), false, kind);
  }
});
test("resolved identity is authoritative: another enrolled account holds, independent account remains unguarded", async t => {
  const f = fixture(t); f.protect(); f.update(99); const other = { ...codexAccount, accountId: "other" }; f.guard.enroll(other);
  let calls = 0; const provider = f.guard.protect(fakeProvider(() => { calls++; return done(); }));
  const held = await provider.streamSimple(codexModel, context, { apiKey: token("other") }).result(); assert.equal(held.stopReason, "error"); assert.equal(calls, 0);
  const independent = await provider.streamSimple(codexModel, context, { apiKey: token("independent") }).result(); assert.equal(independent.stopReason, "stop"); assert.equal(calls, 1);
});
test("unknown token, arbitrary endpoint, custom fetch and virtual host cannot bypass an enrolled guard", async t => {
  const f = fixture(t); f.protect(); let calls = 0; const provider = f.guard.protect(fakeProvider(() => { calls++; return done(); }));
  for (const overrides of [{ apiKey: "invalid" }, { fetch: () => { throw new Error("must not call"); } }, { headers: { Host: "unproved.test" } }]) {
    assert.equal((await provider.streamSimple(codexModel, context, { ...options, ...overrides }).result()).stopReason, "error");
  }
  assert.equal((await provider.streamSimple({ ...codexModel, baseUrl: "https://unproved.test" }, context, options).result()).stopReason, "error"); assert.equal(calls, 0);
  for (const baseUrl of [codexModel.baseUrl, `${codexModel.baseUrl}/codex/`, `${codexModel.baseUrl}/codex/responses`]) assert.deepEqual(codexDispatchAccount({ ...codexModel, baseUrl }, { ...options, headers: { Authorization: "ignored", "chatgpt-account-id": "ignored" } }), codexAccount);
});
test("capacity holds immediately; terminal error releases occupancy before result resolves", async t => {
  const f = fixture(t); f.guard.enroll(codexAccount, { ...DEFAULT_PROTECTION_POLICY, concurrency: 1 });
  const pending = createAssistantMessageEventStream(); let calls = 0;
  const provider = f.guard.protect(fakeProvider(() => { calls++; return calls === 1 ? pending : done(); }));
  const first = provider.streamSimple(codexModel, context, options);
  while (!calls) await new Promise(resolve => setImmediate(resolve));
  const blocked = await provider.streamSimple(codexModel, context, options).result(); assert.match(blocked.errorMessage!, /concurrency/); assert.equal(calls, 1);
  const error = { ...message(), stopReason: "error" as const, errorMessage: "fixture failure" }; pending.push({ type: "error", reason: "error", error }); pending.end(error);
  await first.result(); assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "stop"); assert.equal(calls, 2);
});
test("abort during telemetry and shutdown prevent dispatch; closed/reloading guard is not a bypass", async t => {
  let pollStarted = false;
  const f = fixture(t, { source: () => ({ name: "fixture", async getObservation(signal) { pollStarted = true; await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); throw new Error("never"); } }) });
  f.protect(); let calls = 0; const provider = f.guard.protect(fakeProvider(() => { calls++; return done(); }));
  const controller = new AbortController(), pending = provider.streamSimple(codexModel, context, { ...options, signal: controller.signal });
  while (!pollStarted) await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal((await pending.result()).stopReason, "aborted"); assert.equal(calls, 0);
  f.guard.close(); assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "error"); assert.equal(calls, 0);
});
test("shutdown aborts in-flight transport and settles held occupancy", async t => {
  const f = fixture(t); f.protect(); let calls = 0;
  const provider = f.guard.protect(fakeProvider((_m, _c, o) => { calls++; const stream = createAssistantMessageEventStream(); o!.signal!.addEventListener("abort", () => { const error = { ...message(), stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error }); stream.end(error); }, { once: true }); return stream; }));
  const pending = provider.streamSimple(codexModel, context, options); while (!calls) await new Promise(resolve => setImmediate(resolve));
  f.guard.close(); assert.equal((await pending.result()).stopReason, "aborted");
});
test("storage failure fails closed even before enrollment can be read; never silently recreates a corrupt database", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-corrupt-")), path = join(dir, "quota.sqlite"); writeFileSync(path, "not sqlite");
  const guard = new SubscriptionQuotaGuard({ path }); t.after(() => { guard.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => guard.start()); let calls = 0; const provider = guard.protect(fakeProvider(() => { calls++; return done(); }));
  assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "error"); assert.equal(calls, 0); assert.equal(readFileSync(path, "utf8"), "not sqlite");
});
test("the dispatched credential is rechecked after asynchronous telemetry; a changed identity cannot use the old permit", async t => {
  const f = fixture(t, { source: (_account, actual) => ({ name: "fixture", async getObservation() { actual.apiKey = token("changed"); return observation(10, START, codexAccount); } }) });
  f.protect(); let calls = 0; const provider = f.guard.protect(fakeProvider(() => { calls++; return done(); }));
  const held = await provider.streamSimple(codexModel, context, options).result();
  assert.match(held.errorMessage!, /account or route changed/); assert.equal(calls, 0);
  assert.equal((await provider.streamSimple(codexModel, context, options).result()).stopReason, "stop"); assert.equal(calls, 1);
});
test("shutdown cancels an owned overview poll and waits for it before closing SQLite", async t => {
  const f = fixture(t); f.protect(); let started = false;
  const pending = f.guard.refreshSource({ name: "codex-wham", async getObservation(signal) { started = true; await new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); throw new Error("never"); } }, codexAccount);
  while (!started) await new Promise(resolve => setImmediate(resolve));
  f.guard.close(); await assert.rejects(pending, /session closed/); assert.equal(f.guard.phase, "closed");
});
