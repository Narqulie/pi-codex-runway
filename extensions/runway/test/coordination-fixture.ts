import { DatabaseSync } from "node:sqlite";
import { QuotaCoordinatorStore } from "../coordination";
import type { AccountObservation } from "../quota";
export const START = Date.parse("2026-10-07T08:00:00Z");
export const account = { provider: "anthropic", accountId: "synthetic-pool" };
export const limits = { busyTimeoutMs: 1000, maxAccounts: 8, maxWindows: 8, maxMetadataChars: 16384 };
export const policy = { protected: true, maxAgeMs: 10000, stopUsedPct: 99, concurrency: 2, guardUsedPct: 90, guardConcurrency: 1,
  maxQueue: 8, queueTtlMs: 5000, permitLeaseMs: 1000, pollLeaseMs: 100, pollIntervalMs: 20, pollFailureDelayMs: 40 };
export function observation(used = 10, now = START, binding = account): AccountObservation {
  const stamp = new Date(now).toISOString();
  return { account: binding, observedAt: stamp, source: "fixture", revision: stamp, complete: true,
    windows: ["five", "week"].map(id => ({ id, label: id, scope: { kind: "all" as const }, usedPct: used, resetAt: new Date(now + 20000).toISOString(), observedAt: stamp, source: "fixture", revision: stamp, evidence: "published" as const })) };
}
// This file is a genuine separate-process fixture, not a test runner or model runtime.
if (process.argv[2] === "child") {
  let now = START;
  const store = new QuotaCoordinatorStore(process.argv[3]!, limits, () => now);
  process.on("message", (m: any) => {
    try {
      let result: unknown;
      switch (m.op) {
        case "now": now = m.value; result = true; break;
        case "poll": result = store.acquirePoll(m.account ?? account) ?? null; break;
        case "publish": result = store.publish(m.lease, m.observation); break;
        case "enqueue": result = store.enqueue({ account: m.account ?? account }); break;
        case "attempt": result = store.attempt(m.ticket); break;
        case "release": result = store.release(m.ticket); break;
        case "snapshot": result = store.snapshot(m.account ?? account); break;
        case "lock": {
          const lock = new DatabaseSync(process.argv[3]!);
          lock.exec("BEGIN IMMEDIATE");
          setTimeout(() => { lock.exec("COMMIT"); lock.close(); }, m.duration);
          result = true; break;
        }
        case "close": store.close(); process.send?.({ id: m.id, result: true }); process.disconnect(); return;
        default: throw new Error("Unknown fixture operation.");
      }
      process.send?.({ id: m.id, result });
    } catch (error) { process.send?.({ id: m.id, error: String(error) }); }
  });
  process.send?.({ ready: true });
}
