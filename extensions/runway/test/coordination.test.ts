import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { QuotaCoordinatorStore } from "../coordination";
import type { PollLease, Ticket } from "../coordination";
import { QuotaController } from "../controller";
import { account, limits, observation, policy, START } from "./coordination-fixture";

function setup(t: { after(fn: () => void): void }, storeLimits = limits) {
  const dir = mkdtempSync(join(tmpdir(), "runway-quota-"));
  const path = join(dir, "quota.sqlite"); let now = START;
  const store = new QuotaCoordinatorStore(path, storeLimits, () => now);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.enroll(account, policy);
  const publish = (value = observation(10, now), binding = account) => {
    const lease = store.acquirePoll(binding); assert.ok(lease); assert.equal(store.publish(lease, value), true);
  };
  const enqueue = (binding = account, modelFamily?: string) => {
    const ticket = store.enqueue({ account: binding, modelFamily }); assert.ok(!("kind" in ticket)); return ticket as Ticket;
  };
  return { store, path, publish, enqueue, advance: (ms: number) => { now += ms; return now; } };
}

test("SQLite observations survive restart: 99 hold, fresh five-hour clear leaves weekly blocked; reset alone holds", t => {
  const f = setup(t); f.publish(observation(99)); const ticket = f.enqueue();
  const held = f.store.attempt(ticket); assert.equal(held.kind, "wait");
  const next = observation(99, f.advance(21)); next.windows[0]!.usedPct = 0; f.publish(next);
  const after = f.store.attempt(ticket); assert.equal(after.kind, "wait");
  if (after.kind === "wait") assert.deepEqual(after.decision.reasons, [{ windowId: "week", reason: "exhausted" }]);
  const restarted = new QuotaCoordinatorStore(f.path, limits, () => START + 21000);
  try {
    const state = restarted.snapshot(account); assert.equal(state?.observation?.windows[1]?.usedPct, 99);
    assert.equal(restarted.attempt(restarted.enqueue({ account }) as Ticket).kind, "wait");
  } finally { restarted.close(); }
});

test("partial, stale, failed, malformed publications retain blockers and surface faults", t => {
  const f = setup(t); f.publish(observation(99));
  const partial = observation(0, f.advance(21)); partial.windows = [partial.windows[0]!]; partial.complete = false;
  f.publish(partial); assert.equal(f.store.snapshot(account)?.observation?.windows[1]?.usedPct, 99);
  const staleNow = f.advance(policy.maxAgeMs + 1); const stale = observation(0, START); stale.observedAt = new Date(staleNow).toISOString(); f.publish(stale);
  assert.equal(f.store.snapshot(account)?.observation?.windows[1]?.usedPct, 99);
  f.advance(41); let lease = f.store.acquirePoll(account)!;
  assert.equal(f.store.publishFailure(lease, "throttled"), true);
  assert.equal(f.store.snapshot(account)?.observation?.issue, "throttled");
  assert.equal(f.store.snapshot(account)?.observation?.windows[1]?.usedPct, 99);
  f.advance(41); lease = f.store.acquirePoll(account)!;
  assert.throws(() => f.store.publish(lease, { ...observation(0), windows: [{ ...observation().windows[0]!, usedPct: NaN }] }), /Invalid quota window/);
  const held = f.store.attempt(f.enqueue());
  assert.equal(held.kind, "wait"); if (held.kind === "wait") { assert.equal(held.blocker, "quota"); assert.ok(held.decision.reasons.some(r => r.reason === "exhausted")); }
  assert.equal(f.store.snapshot(account)?.observation?.issue, "malformed");
});

test("near-bound publication preserves readable failure metadata and cached blockers", t => {
  const packed = observation(99);
  packed.windows[0]!.label = "x".repeat(64);
  const bounded = { ...limits, maxMetadataChars: JSON.stringify(packed).length };
  const f = setup(t, bounded); f.publish(observation(99));
  f.advance(21); const lease = f.store.acquirePoll(account)!;
  assert.throws(() => f.store.publish(lease, packed), /failure metadata/);
  assert.equal(f.store.snapshot(account)?.observation?.issue, "malformed");
  assert.equal(f.store.snapshot(account)?.observation?.windows[0]?.usedPct, 99);
  f.advance(41);
  assert.equal(f.store.publishFailure(f.store.acquirePoll(account)!, "authentication"), true);
  const restarted = new QuotaCoordinatorStore(f.path, bounded, () => START + 62);
  try {
    assert.equal(restarted.snapshot(account)?.observation?.issue, "authentication");
    assert.equal(restarted.snapshot(account)?.observation?.windows[0]?.usedPct, 99);
  } finally { restarted.close(); }
});

test("renewable poll fences reject takeover and obsolete generation/publication; interval bounds explicit", t => {
  const f = setup(t); const old = f.store.acquirePoll(account)!;
  assert.equal(f.store.acquirePoll(account), undefined);
  f.advance(90); assert.equal(f.store.renewPoll(old), true);
  f.advance(101); const fresh = f.store.acquirePoll(account)!; assert.ok(fresh.fence > old.fence);
  assert.equal(f.store.renewPoll(old), false); assert.equal(f.store.publish(old, observation(0)), false);
  assert.equal(f.store.publish(fresh, observation(99, START + 191)), true);
  assert.equal(f.store.publish(fresh, observation(0)), false); assert.equal(f.store.acquirePoll(account), undefined);
  f.advance(21); const obsolete = f.store.acquirePoll(account)!; f.store.enroll(account, policy);
  assert.equal(f.store.publish(obsolete, observation(0)), false); assert.equal(f.store.snapshot(account)?.observation?.windows[0]?.usedPct, 99);
});

test("fair eligible FIFO, guard capacity is not exhaustion, and reacquisition joins the tail", t => {
  const f = setup(t); f.publish(observation(95));
  const first = f.enqueue(), second = f.enqueue();
  const outOfOrder = f.store.attempt(second); assert.equal(outOfOrder.kind, "wait");
  if (outOfOrder.kind === "wait") { assert.equal(outOfOrder.blocker, "capacity"); assert.deepEqual(outOfOrder.decision.reasons, []); }
  assert.equal(f.store.attempt(first).kind, "permit"); assert.equal(f.store.attempt(second).kind, "wait");
  assert.equal(f.store.release(first), true); assert.equal(f.store.release(first), false);
  const again = f.enqueue(); assert.equal(f.store.attempt(again).kind, "wait"); assert.equal(f.store.attempt(second).kind, "permit");
  assert.equal(f.store.renewPermit(second), true); f.advance(1001);
  assert.equal(f.store.valid(second), false); assert.equal(f.store.renewPermit(second), false); assert.equal(f.store.attempt(second).kind, "invalid");
  assert.equal(f.store.attempt(again).kind, "permit");
});

test("blocked scoped head does not stop eligible follower; independent provider/account pools", t => {
  const f = setup(t); const next = observation();
  next.windows.push({ ...next.windows[0]!, id: "sonnet", usedPct: 99, scope: { kind: "models", families: ["sonnet"] } });
  f.publish(next);
  assert.equal(f.store.attempt(f.enqueue(account, "sonnet")).kind, "wait");
  assert.equal(f.store.attempt(f.enqueue(account, "opus")).kind, "permit");
  for (const separate of [{ ...account, provider: "other-provider" }, { ...account, accountId: "other-account" }]) {
    f.store.enroll(separate, policy); f.publish(observation(10, START, separate), separate);
    assert.equal(f.store.attempt(f.enqueue(separate)).kind, "permit");
  }
  assert.deepEqual(f.store.enqueue({ account: { ...account, accountId: "unenrolled" } }), { kind: "advisory" });
});

test("generation fences grants while old in-flight occupancy remains renewable until terminal release", t => {
  const f = setup(t); f.store.enroll(account, { ...policy, concurrency: 1 }); f.publish();
  const active = f.enqueue(); assert.equal(f.store.attempt(active).kind, "permit");
  assert.equal(f.store.markDispatched(active), true); assert.equal(f.store.markDispatched(active), false); assert.equal(f.store.valid(active), false);
  const waiting = f.enqueue(); f.store.enroll(account, { ...policy, concurrency: 1 });
  assert.equal(f.store.attempt(waiting).kind, "invalid"); assert.equal(f.store.renewPermit(active), true);
  const fresh = f.enqueue(); const attempt = f.store.attempt(fresh); assert.equal(attempt.kind, "wait");
  if (attempt.kind === "wait") assert.equal(attempt.blocker, "capacity");
  assert.equal(f.store.release(active), true); assert.equal(f.store.attempt(fresh).kind, "permit");
  f.store.enroll(account, policy); assert.equal(f.store.valid(fresh), false); assert.equal(f.store.markDispatched(fresh), false);
});

test("fresh guard-zone telemetry fences excess pre-dispatch grants without cancelling in-flight calls", t => {
  const f = setup(t); f.publish();
  const first = f.enqueue(), second = f.enqueue();
  assert.equal(f.store.attempt(first).kind, "permit");
  assert.equal(f.store.attempt(second).kind, "permit");
  f.advance(21); f.publish(observation(95, START + 21));
  assert.equal(f.store.valid(first), true);
  assert.equal(f.store.valid(second), false);
  const held = f.store.attempt(second);
  assert.equal(held.kind, "wait");
  if (held.kind === "wait") assert.equal(held.blocker, "capacity");
  assert.equal(f.store.markDispatched(first), true);
  assert.equal(f.store.markDispatched(second), false);
  assert.equal(f.store.renewPermit(first), true);
  f.store.release(first);
  assert.equal(f.store.valid(second), true);
  assert.equal(f.store.markDispatched(second), true);
});

test("final validity rechecks exhaustion; no invented usage reservation; terminal cancellation cannot revive", t => {
  const f = setup(t); f.publish(); const ticket = f.enqueue(); assert.equal(f.store.attempt(ticket).kind, "permit");
  const before = f.store.snapshot(account)?.observation;
  assert.deepEqual(before?.windows.map(w => w.usedPct), [10, 10]);
  f.advance(21); f.publish(observation(99, START + 21)); assert.equal(f.store.valid(ticket), false); assert.equal(f.store.markDispatched(ticket), false);
  assert.equal(f.store.release(ticket), true); f.advance(21); f.publish(observation(0, START + 42));
  assert.equal(f.store.attempt(ticket).kind, "invalid"); assert.equal(f.store.markDispatched(ticket), false);
});

test("explicit account, observation, queue retention and input projection; damaged DB is never replaced", t => {
  const f = setup(t); f.store.enroll(account, { ...policy, maxQueue: 1 });
  const raw = { ...observation(), secret: "not-domain-metadata", windows: observation().windows.map(w => ({ ...w, prompt: "not-domain-metadata" })) };
  f.publish(raw); assert.doesNotMatch(JSON.stringify(f.store.snapshot(account)), /not-domain-metadata/);
  const ticket = f.enqueue(); assert.throws(() => f.enqueue(), /retention limit/);
  f.advance(5001); assert.equal(f.store.attempt(ticket).kind, "invalid"); assert.ok(f.enqueue());
  const corrupt = join(tmpdir(), `runway-damaged-${process.pid}.sqlite`); const bytes = Buffer.from("not a SQLite database");
  try { writeFileSync(corrupt, bytes); assert.throws(() => new QuotaCoordinatorStore(corrupt, limits)); assert.deepEqual(readFileSync(corrupt), bytes); }
  finally { rmSync(corrupt, { force: true }); }
  const tamper = new DatabaseSync(f.path);
  try { tamper.prepare("UPDATE accounts SET data=?").run('{"generation":1}'); }
  finally { tamper.close(); }
  assert.throws(() => f.store.snapshot(account)); assert.throws(() => new QuotaCoordinatorStore(f.path, limits));
});

test("accepted expiry durations cannot commit unreadable SQLite integers", t => {
  const f = setup(t);
  assert.throws(() => f.store.enroll(account, { ...policy, queueTtlMs: Number.MAX_SAFE_INTEGER }), /expiry/);
  assert.deepEqual(f.store.snapshot(account)?.policy, policy);
  f.publish();
  assert.equal(f.store.attempt(f.enqueue()).kind, "permit");
  assert.ok(f.store.snapshot(account));
});

test("controller requires every explicit timing bound", t => {
  const f = setup(t);
  const incomplete = { wakeIntervalMs: 5, maxWaitMs: 40 } as ConstructorParameters<typeof QuotaController>[1];
  assert.throws(() => new QuotaController(f.store, incomplete), /Invalid controller bounds/);
});

test("controller cancellation wins reset race and bounded timeout removes queue; timer wake is never permission", async t => {
  const f = setup(t); f.publish(observation(99));
  const controller = new QuotaController(f.store, { wakeIntervalMs: 5, maxWaitMs: 40, sourceTimeoutMs: 20 });
  const abort = new AbortController(); const cancelled = controller.acquire({ account }, abort.signal);
  const now = f.advance(21); f.publish(observation(0, now)); abort.abort(new Error("cancel-wins"));
  await assert.rejects(cancelled, /cancel-wins/);
  const next = f.enqueue(); assert.equal(f.store.attempt(next).kind, "permit"); f.store.release(next);
  f.advance(21); f.publish(observation(99, START + 42));
  await assert.rejects(controller.acquire({ account }), /wait expired/);
  f.advance(21); f.publish(observation(0, START + 63));
  const permit = await controller.acquire({ account }); assert.equal(permit.kind, "permit");
  if (permit.kind === "permit") {
    abort.abort();
    assert.throws(() => controller.markDispatched(permit.ticket, abort.signal), /cancel-wins/);
    assert.equal(f.store.valid(permit.ticket), false);
  }
});

test("controller polling is one source call, timeout-bounded outside DB locks and preserves failures", async t => {
  const f = setup(t); const controller = new QuotaController(f.store, { wakeIntervalMs: 5, maxWaitMs: 40, sourceTimeoutMs: 20 });
  let resolveReading!: (value: ReturnType<typeof observation>) => void; let calls = 0;
  const source = { name: "fixture", getObservation: () => { calls++; return new Promise<ReturnType<typeof observation>>(resolve => { resolveReading = resolve; }); } };
  const poll = controller.poll(account, source);
  assert.equal(await controller.poll(account, source), "not-due");
  const ticket = f.enqueue(); const unknown = f.store.attempt(ticket); // DB usable during network wait
  assert.equal(unknown.kind, "wait"); if (unknown.kind === "wait") { assert.equal(unknown.blocker, "telemetry"); assert.ok(!unknown.decision.reasons.some(r => r.reason === "exhausted")); }
  resolveReading(observation(99)); assert.equal(await poll, "published"); assert.equal(calls, 1);
  f.advance(21);
  await assert.rejects(controller.poll(account, { name: "ignores-abort", getObservation: () => new Promise(() => {}) }), /timed out/);
  assert.equal(f.store.snapshot(account)?.observation?.issue, "network"); assert.equal(f.store.snapshot(account)?.observation?.windows[0]?.usedPct, 99);
});

async function child(path: string) {
  const process = fork(resolve("extensions/runway/test/coordination-fixture.ts"), ["child", path], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; process.stderr?.on("data", chunk => { stderr += chunk; });
  let seq = 0; const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const ready = new Promise<void>((resolve, reject) => {
    process.on("message", (m: any) => { if (m.ready) resolve(); else { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(m.error)) : p?.resolve(m.result); } });
    process.on("exit", code => { if (code !== 0) { const error = new Error(`Child exited ${code}: ${stderr}`); reject(error); for (const p of pending.values()) p.reject(error); } });
    process.on("error", reject);
  });
  await ready;
  const call = (op: string, data: object = {}) => new Promise<any>((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); process.send({ id, op, ...data }); });
  return { call, async close() { const exited = once(process, "exit"); await call("close"); await exited; }, kill() { process.kill(); } };
}

test("synchronous source abort and throw has no unhandled polling rejection", async t => {
  const f = setup(t); const abort = new AbortController();
  const controller = new QuotaController(f.store, { wakeIntervalMs: 5, maxWaitMs: 50, sourceTimeoutMs: 20 });
  await assert.rejects(controller.poll(account, {
    name: "synchronous-failure",
    getObservation: () => { abort.abort(new Error("source cancellation")); throw new Error("synchronous source failure"); }
  }, abort.signal));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.snapshot(account)?.observation?.issue, "network");
});

test("controller wait deadline includes SQLite lock contention and removes late grants", { timeout: 5000 }, async t => {
  for (const transaction of ["enqueue", "attempt"]) {
    const f = setup(t); f.store.enroll(account, { ...policy, concurrency: 1 }); f.publish();
    const enqueue = f.store.enqueue;
    if (transaction === "attempt") {
      const queued = f.enqueue();
      f.store.enqueue = () => queued; // Isolate the grant transaction with a real, already-queued ticket.
    }
    const locker = await child(f.path); t.after(() => locker.kill());
    await locker.call("lock", { duration: 100 });
    const controller = new QuotaController(f.store, { wakeIntervalMs: 5, maxWaitMs: 20, sourceTimeoutMs: 10 });
    await assert.rejects(controller.acquire({ account }), /wait expired/);
    f.store.enqueue = enqueue;
    await locker.close();
    assert.equal(f.store.attempt(f.enqueue()).kind, "permit");
  }
});

test("two genuine processes share one poller, fenced takeover, durable holds, independent account and FIFO permits", { timeout: 15000 }, async t => {
  const f = setup(t); f.publish(observation(99)); f.advance(21);
  const one = await child(f.path), two = await child(f.path);
  t.after(() => { one.kill(); two.kill(); });
  await Promise.all([one.call("now", { value: START + 21 }), two.call("now", { value: START + 21 })]);
  const leases = await Promise.all([one.call("poll"), two.call("poll")]); assert.equal(leases.filter(Boolean).length, 1);
  const old: PollLease = leases.find(Boolean);
  const [a, b] = await Promise.all([one.call("enqueue"), two.call("enqueue")]);
  for (const [driver, ticket] of [[one, a], [two, b]] as const) { const held = await driver.call("attempt", { ticket }); assert.equal(held.kind, "wait"); assert.equal(held.blocker, "quota"); }
  await Promise.all([one.call("now", { value: START + 122 }), two.call("now", { value: START + 122 })]);
  const replacement = await two.call("poll"); assert.ok(replacement);
  assert.equal(await one.call("publish", { lease: old, observation: observation(0, START + 122) }), false);
  const onlyFive = observation(99, START + 122); onlyFive.windows[0]!.usedPct = 0;
  assert.equal(await two.call("publish", { lease: replacement, observation: onlyFive }), true);
  assert.equal((await one.call("attempt", { ticket: a })).kind, "wait");
  assert.equal((await one.call("snapshot")).observation.windows[1].usedPct, 99);
  const independent = { ...account, accountId: "independent" }; f.store.enroll(independent, policy); f.publish(observation(10, START + 21, independent), independent);
  const independentTicket = await one.call("enqueue", { account: independent }); assert.equal((await one.call("attempt", { ticket: independentTicket })).kind, "permit");
  await Promise.all([one.call("now", { value: START + 143 }), two.call("now", { value: START + 143 })]);
  const clear = await one.call("poll"); assert.equal(await one.call("publish", { lease: clear, observation: observation(95, START + 143) }), true);
  await Promise.all([one.call("release", { ticket: a }), two.call("release", { ticket: b })]);
  const first = await one.call("enqueue"), second = await two.call("enqueue");
  const blocked = await two.call("attempt", { ticket: second }); assert.equal(blocked.kind, "wait"); assert.equal(blocked.blocker, "capacity");
  assert.equal((await one.call("attempt", { ticket: first })).kind, "permit");
  assert.equal((await two.call("attempt", { ticket: second })).kind, "wait");
  await one.call("release", { ticket: first }); assert.equal((await two.call("attempt", { ticket: second })).kind, "permit");
  await Promise.all([one.close(), two.close()]);
});
