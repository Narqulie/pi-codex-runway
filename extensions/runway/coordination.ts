import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { accountKey, applicable, evaluateAdmission, mergeObservation, validateBinding } from "./quota";
import type { AccountBinding, AccountObservation, AdmissionDecision, AdmissionPolicy, QuotaRequest, TelemetryIssue } from "./quota";
import { emptyState, validateState } from "./storage";

/** All timing/capacity choices belong to the verified account integration, not universal defaults. */
export interface CoordinationPolicy extends AdmissionPolicy {
  concurrency: number;
  guardUsedPct: number;
  guardConcurrency: number;
  maxQueue: number;
  queueTtlMs: number;
  permitLeaseMs: number;
  pollLeaseMs: number;
  pollIntervalMs: number;
  pollFailureDelayMs: number;
}
export interface StoreLimits { busyTimeoutMs: number; maxAccounts: number; maxWindows: number; maxMetadataChars: number }
export interface AccountState {
  account: AccountBinding; generation: number; revision: number; policy: CoordinationPolicy;
  observation?: AccountObservation;
  pollFence: number; pollOwner: string | null; pollExpires: number; pollNotBefore: number;
}
export interface PollLease { account: AccountBinding; generation: number; fence: number; owner: string }
/** Random coordination identity only; no runtime request payload or owner credentials. */
export interface Ticket { account: AccountBinding; generation: number; id: string }
export type Attempt =
  | { kind: "permit"; ticket: Ticket; revision: number; expiresAt: number }
  | { kind: "wait"; revision: number; blocker: "quota" | "telemetry" | "capacity"; decision: AdmissionDecision }
  | { kind: "invalid"; revision: number };
type QueueRow = { seq: number; id: string; account: string; generation: number; family: string | null; feature: string | null; state: "waiting" | "granted" | "inflight"; expires: number };
const issues: TelemetryIssue[] = ["authentication", "permission", "throttled", "network", "malformed", "partial"];
const integer = (v: number, min = 1) => Number.isSafeInteger(v) && v >= min;
function checkPolicy(p: CoordinationPolicy): CoordinationPolicy {
  if (!p || typeof p.protected !== "boolean" || !integer(p.maxAgeMs) || !integer(p.concurrency) || !integer(p.guardConcurrency)
    || p.guardConcurrency > p.concurrency || !integer(p.maxQueue) || !integer(p.queueTtlMs) || !integer(p.permitLeaseMs)
    || !integer(p.pollLeaseMs) || !integer(p.pollIntervalMs) || !integer(p.pollFailureDelayMs)
    || !Number.isFinite(p.stopUsedPct ?? 99) || (p.stopUsedPct ?? 99) <= 0 || (p.stopUsedPct ?? 99) > 100
    || !Number.isFinite(p.guardUsedPct) || p.guardUsedPct < 0 || p.guardUsedPct >= (p.stopUsedPct ?? 99)) throw new Error("Invalid coordination policy.");
  return { protected: p.protected, maxAgeMs: p.maxAgeMs, stopUsedPct: p.stopUsedPct ?? 99, concurrency: p.concurrency,
    guardUsedPct: p.guardUsedPct, guardConcurrency: p.guardConcurrency, maxQueue: p.maxQueue, queueTtlMs: p.queueTtlMs,
    permitLeaseMs: p.permitLeaseMs, pollLeaseMs: p.pollLeaseMs, pollIntervalMs: p.pollIntervalMs, pollFailureDelayMs: p.pollFailureDelayMs };
}

/** Repository-local SQLite authority. Every operation is synchronous, short, and transactional.
 * No credentials, forecast imports, network, model calls, history replay, or task ownership. */
export class QuotaCoordinatorStore {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly limits: StoreLimits, private readonly clock: () => number = Date.now) {
    if (!integer(limits.busyTimeoutMs, 0) || !integer(limits.maxAccounts) || !integer(limits.maxWindows) || !integer(limits.maxMetadataChars)) throw new Error("Invalid store limits.");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=${limits.busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
      const check = this.db.prepare("PRAGMA quick_check").get();
      if (!check || Object.values(check)[0] !== "ok") throw new Error("Quota database integrity check failed.");
      this.transaction(() => {
        const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        if (version === 0) {
          if (Number(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.n)) throw new Error("Unrecognized quota database; preserved.");
          this.db.exec(`CREATE TABLE accounts (
            key TEXT PRIMARY KEY, data TEXT NOT NULL
          ) STRICT;
          CREATE TABLE permits (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, account TEXT NOT NULL REFERENCES accounts(key),
            generation INTEGER NOT NULL CHECK(generation>0), family TEXT, feature TEXT,
            state TEXT NOT NULL CHECK(state IN ('waiting','granted','inflight')), expires INTEGER NOT NULL
          ) STRICT;
          CREATE INDEX permits_account ON permits(account, seq);
          PRAGMA user_version=1;`);
        } else if (version !== 1) throw new Error("Unsupported quota database version; preserved.");
        const accounts = this.db.prepare("SELECT key FROM accounts").all();
        if (accounts.length > limits.maxAccounts || this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid quota account retention/references.");
        for (const row of accounts) this.read(String(row.key));
        this.db.prepare("SELECT seq,id,account,generation,family,feature,state,expires FROM permits").all();
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private now(): number { const now = this.clock(); if (!integer(now, 0)) throw new Error("Invalid coordinator clock."); return now; }
  private expiry(now: number, duration: number): number {
    const expires = now + duration;
    if (!integer(expires, 0)) throw new Error("Quota expiry exceeds safe integer range.");
    return expires;
  }
  private text(value: string): string {
    if (typeof value !== "string" || !value.trim() || value.length > this.limits.maxMetadataChars) throw new Error("Invalid quota metadata.");
    return value;
  }
  private binding(value: AccountBinding): AccountBinding {
    const account = validateBinding(value); this.text(account.provider); this.text(account.accountId); return account;
  }
  private failureObservation(account: AccountBinding, previous: AccountObservation | undefined, issue: TelemetryIssue, stamp: string): AccountObservation {
    return { account, windows: previous?.windows ?? [], observedAt: stamp, revision: stamp,
      source: previous?.source ?? "coordinator", complete: false, issue };
  }
  private reserveFailureMetadata(account: AccountBinding, previous?: AccountObservation) {
    const stamp = new Date(8_640_000_000_000_000).toISOString(); // Longest supported ISO timestamp.
    const issue = issues.reduce((longest, next) => next.length > longest.length ? next : longest);
    if (JSON.stringify(this.failureObservation(account, previous, issue, stamp)).length > this.limits.maxMetadataChars) throw new Error("Quota observation must reserve failure metadata.");
  }
  /** Validate and project domain fields; unrecognized caller properties are never persisted. */
  private observation(value: AccountObservation): AccountObservation {
    if (JSON.stringify(value).length > this.limits.maxMetadataChars) throw new Error("Quota observation metadata limit reached.");
    validateState({ ...emptyState(), accounts: [value] });
    if (value.issue != null && !issues.includes(value.issue) || value.windows.length > this.limits.maxWindows) throw new Error("Invalid/bounded quota observation.");
    const projected: AccountObservation = { account: this.binding(value.account), observedAt: value.observedAt, source: this.text(value.source), revision: this.text(value.revision), complete: value.complete, issue: value.issue,
      windows: value.windows.map(w => ({ id: this.text(w.id), label: this.text(w.label), source: this.text(w.source), revision: this.text(w.revision),
        observedAt: w.observedAt, usedPct: w.usedPct, resetAt: w.resetAt, durationSeconds: w.durationSeconds, evidence: w.evidence,
        providerLabel: w.providerLabel == null ? undefined : this.text(w.providerLabel),
        scope: w.scope.kind === "models" ? { kind: "models", families: w.scope.families.map(s => this.text(s)) }
          : w.scope.kind === "features" ? { kind: "features", features: w.scope.features.map(s => this.text(s)) } : { kind: w.scope.kind } })) };
    this.reserveFailureMetadata(projected.account, projected);
    return projected;
  }
  private read(key: string): AccountState | undefined {
    const row = this.db.prepare("SELECT data FROM accounts WHERE key=?").get(key);
    if (!row) return undefined;
    const a = JSON.parse(String(row.data)) as AccountState;
    if (accountKey(this.binding(a.account)) !== key || !integer(a.generation) || !integer(a.revision) || !integer(a.pollFence, 0)
      || !integer(a.pollExpires, 0) || !integer(a.pollNotBefore, 0) || a.pollOwner !== null && typeof a.pollOwner !== "string") throw new Error("Invalid persisted quota account; preserved.");
    a.policy = checkPolicy(a.policy);
    if (a.observation) {
      a.observation = this.observation(a.observation);
      if (accountKey(a.observation.account) !== key) throw new Error("Foreign persisted quota observation.");
    } else this.reserveFailureMetadata(a.account);
    this.queueRows(a);
    return a;
  }
  private queueRows(a: AccountState): QueueRow[] {
    const rows = this.db.prepare("SELECT * FROM permits WHERE account=? ORDER BY seq").all(accountKey(a.account)) as QueueRow[];
    for (const r of rows) {
      if (!integer(r.seq) || !integer(r.generation) || !integer(r.expires, 0) || !["waiting", "granted", "inflight"].includes(r.state)
        || r.generation > a.generation || r.state !== "inflight" && r.generation !== a.generation) throw new Error("Invalid persisted quota permit; preserved.");
      this.text(r.id); if (r.family !== null) this.text(r.family); if (r.feature !== null) this.text(r.feature);
    }
    if (rows.filter(r => r.state === "waiting").length > a.policy.maxQueue) throw new Error("Invalid persisted queue retention.");
    return rows;
  }
  private save(a: AccountState) {
    a.revision++;
    if (!integer(a.revision) || !integer(a.generation) || !integer(a.pollFence, 0) || !integer(a.pollExpires, 0) || !integer(a.pollNotBefore, 0)) throw new Error("Quota coordination counter overflow.");
    this.db.prepare("UPDATE accounts SET data=? WHERE key=?").run(JSON.stringify(a), accountKey(a.account));
  }
  private required(account: AccountBinding): AccountState {
    const a = this.read(accountKey(this.binding(account))); if (!a) throw new Error("Account not enrolled."); return a;
  }
  snapshot(account: AccountBinding): AccountState | undefined { return this.transaction(() => this.read(accountKey(this.binding(account)))); }
  accounts(): AccountState[] {
    return this.transaction(() => this.db.prepare("SELECT key FROM accounts ORDER BY key").all().map(row => this.read(String(row.key))!));
  }
  /** Keep a parked FIFO position alive; this never grants or renews dispatch permission. */
  renewWaiting(ticket: Ticket): boolean {
    return this.transaction(() => {
      const a = this.required(ticket.account), row = this.row(ticket), now = this.now();
      if (!row || row.state !== "waiting" || row.expires <= now || a.generation !== ticket.generation) return false;
      this.db.prepare("UPDATE permits SET expires=? WHERE id=?").run(this.expiry(now, a.policy.queueTtlMs), ticket.id);
      // Expiry maintenance does not change eligibility or notify other waiters.
      return true;
    });
  }
  /** Policy changes fence pre-dispatch grants, but retain already-dispatched account occupancy. */
  enroll(account: AccountBinding, policy: CoordinationPolicy): AccountState {
    account = this.binding(account); policy = checkPolicy(policy);
    this.reserveFailureMetadata(account);
    return this.transaction(() => {
      const now = this.now();
      for (const duration of [policy.queueTtlMs, policy.permitLeaseMs, policy.pollLeaseMs, policy.pollIntervalMs, policy.pollFailureDelayMs]) this.expiry(now, duration);
      const key = accountKey(account); let a = this.read(key);
      if (a) {
        a.generation++; a.policy = policy; a.pollFence++; a.pollOwner = null; a.pollExpires = 0;
        this.db.prepare("DELETE FROM permits WHERE account=? AND state!='inflight'").run(key);
        this.save(a);
      } else {
        if (Number(this.db.prepare("SELECT count(*) AS n FROM accounts").get()!.n) >= this.limits.maxAccounts) throw new Error("Account retention limit reached.");
        a = { account, policy, generation: 1, revision: 1, pollFence: 0, pollOwner: null, pollExpires: 0, pollNotBefore: 0 };
        this.db.prepare("INSERT INTO accounts(key,data) VALUES(?,?)").run(key, JSON.stringify(a));
      }
      return a;
    });
  }
  acquirePoll(account: AccountBinding): PollLease | undefined {
    return this.transaction(() => {
      const a = this.required(account), now = this.now();
      if (a.pollExpires > now || a.pollNotBefore > now) return undefined;
      a.pollFence++; a.pollOwner = randomUUID(); a.pollExpires = this.expiry(now, a.policy.pollLeaseMs); this.save(a);
      return { account: a.account, generation: a.generation, fence: a.pollFence, owner: a.pollOwner };
    });
  }
  private pollValid(a: AccountState, lease: PollLease, now: number) {
    return a.generation === lease.generation && a.pollFence === lease.fence && a.pollOwner === lease.owner && a.pollExpires > now;
  }
  renewPoll(lease: PollLease): boolean {
    return this.transaction(() => {
      const a = this.required(lease.account), now = this.now(); if (!this.pollValid(a, lease, now)) return false;
      a.pollExpires = this.expiry(now, a.policy.pollLeaseMs); this.save(a); return true;
    });
  }
  private failure(a: AccountState, issue: TelemetryIssue, now: number) {
    const stamp = new Date(now).toISOString();
    a.observation = this.observation(this.failureObservation(a.account, a.observation, issue, stamp));
  }
  /** Publication consumes the fence. Malformed publication commits a fail-closed failure, then throws. */
  publish(lease: PollLease, observation: AccountObservation): boolean {
    let fault: unknown;
    const accepted = this.transaction(() => {
      const a = this.required(lease.account), now = this.now(); if (!this.pollValid(a, lease, now)) return false;
      try {
        const next = this.observation(observation);
        if (accountKey(next.account) !== accountKey(a.account)) throw new Error("Poll result account mismatch.");
        a.observation = this.observation(mergeObservation(a.observation, next, new Date(now), a.policy.maxAgeMs, a.policy.stopUsedPct));
      } catch (error) { this.failure(a, "malformed", now); fault = error; }
      a.pollOwner = null; a.pollExpires = 0; a.pollNotBefore = this.expiry(now, fault || a.observation?.issue ? a.policy.pollFailureDelayMs : a.policy.pollIntervalMs);
      this.save(a); return true;
    });
    if (fault) throw fault; return accepted;
  }
  publishFailure(lease: PollLease, issue: TelemetryIssue): boolean {
    if (!issues.includes(issue)) throw new Error("Invalid telemetry issue.");
    return this.transaction(() => {
      const a = this.required(lease.account), now = this.now(); if (!this.pollValid(a, lease, now)) return false;
      this.failure(a, issue, now); a.pollOwner = null; a.pollExpires = 0; a.pollNotBefore = this.expiry(now, a.policy.pollFailureDelayMs); this.save(a); return true;
    });
  }
  private prune(a: AccountState, now: number) {
    const count = this.db.prepare("DELETE FROM permits WHERE account=? AND expires<=?").run(accountKey(a.account), now).changes;
    if (count) this.save(a);
  }
  enqueue(request: QuotaRequest): Ticket | { kind: "advisory" } {
    const account = this.binding(request.account);
    const family = request.modelFamily == null ? null : this.text(request.modelFamily), feature = request.feature == null ? null : this.text(request.feature);
    return this.transaction(() => {
      const a = this.read(accountKey(account)); if (!a || !a.policy.protected) return { kind: "advisory" as const };
      const now = this.now(); this.prune(a, now);
      if (Number(this.db.prepare("SELECT count(*) AS n FROM permits WHERE account=? AND state='waiting'").get(accountKey(account))!.n) >= a.policy.maxQueue) throw new Error("Account queue retention limit reached.");
      const id = randomUUID();
      this.db.prepare("INSERT INTO permits(id,account,generation,family,feature,state,expires) VALUES(?,?,?,?,?,'waiting',?)").run(id, accountKey(account), a.generation, family, feature, this.expiry(now, a.policy.queueTtlMs));
      this.save(a); return { account, generation: a.generation, id };
    });
  }
  private row(ticket: Ticket): QueueRow | undefined {
    return this.db.prepare("SELECT * FROM permits WHERE id=? AND account=? AND generation=?").get(ticket.id, accountKey(this.binding(ticket.account)), ticket.generation) as QueueRow | undefined;
  }
  private decision(a: AccountState, row: QueueRow, now: number) {
    return evaluateAdmission({ account: a.account, modelFamily: row.family ?? undefined, feature: row.feature ?? undefined }, a.observation, a.policy, new Date(now));
  }
  private capacity(a: AccountState): number {
    // Guard-zone concurrency is capacity, never evidence of provider exhaustion.
    const near = a.observation?.windows.some(w => applicable(w.scope, { account: a.account }) !== false && w.usedPct != null && w.usedPct >= a.policy.guardUsedPct);
    return near ? a.policy.guardConcurrency : a.policy.concurrency;
  }
  private dispatchable(a: AccountState, row: QueueRow | undefined, now: number): boolean {
    if (!row || row.state !== "granted" || row.expires <= now || row.generation !== a.generation || this.decision(a, row, now).action !== "admit") return false;
    const ahead = this.queueRows(a).filter(other => other.expires > now && (other.state === "inflight"
      || other.state === "granted" && other.seq < row.seq && this.decision(a, other, now).action === "admit")).length;
    return ahead < this.capacity(a);
  }
  attempt(ticket: Ticket): Attempt {
    return this.transaction(() => {
      const a = this.required(ticket.account), now = this.now(); this.prune(a, now); const row = this.row(ticket);
      if (!row || a.generation !== ticket.generation || row.state === "inflight") return { kind: "invalid", revision: a.revision };
      const decision = this.decision(a, row, now);
      if (decision.action !== "admit") return { kind: "wait", blocker: decision.reasons.some(r => r.reason === "exhausted") ? "quota" : "telemetry", decision, revision: a.revision };
      if (row.state === "granted") return this.dispatchable(a, row, now)
        ? { kind: "permit", ticket, expiresAt: row.expires, revision: a.revision }
        : { kind: "wait", blocker: "capacity", decision, revision: a.revision };
      const occupancy = Number(this.db.prepare("SELECT count(*) AS n FROM permits WHERE account=? AND state!='waiting'").get(accountKey(a.account))!.n);
      const earlier = this.db.prepare("SELECT * FROM permits WHERE account=? AND state='waiting' AND seq<? ORDER BY seq").all(accountKey(a.account), row.seq) as QueueRow[];
      if (occupancy >= this.capacity(a) || earlier.some(r => this.decision(a, r, now).action === "admit")) return { kind: "wait", blocker: "capacity", decision, revision: a.revision };
      const expiresAt = this.expiry(now, a.policy.permitLeaseMs);
      this.db.prepare("UPDATE permits SET state='granted',expires=? WHERE id=?").run(expiresAt, ticket.id); this.save(a);
      return { kind: "permit", ticket, expiresAt, revision: a.revision };
    });
  }
  valid(ticket: Ticket): boolean {
    return this.transaction(() => {
      const a = this.required(ticket.account), row = this.row(ticket), now = this.now();
      return this.dispatchable(a, row, now);
    });
  }
  /** Final transactional pre-dispatch check. Call exactly once at the trusted dispatch boundary. */
  markDispatched(ticket: Ticket): boolean {
    return this.transaction(() => {
      const a = this.required(ticket.account), row = this.row(ticket), now = this.now();
      if (!this.dispatchable(a, row, now)) return false;
      this.db.prepare("UPDATE permits SET state='inflight' WHERE id=?").run(ticket.id); this.save(a); return true;
    });
  }
  /** In-flight renewal preserves occupancy even across policy generations; it is not dispatch permission. */
  renewPermit(ticket: Ticket): boolean {
    return this.transaction(() => {
      const a = this.required(ticket.account), row = this.row(ticket), now = this.now();
      if (!row || row.state === "waiting" || row.expires <= now || row.state === "granted" && !this.dispatchable(a, row, now)) return false;
      this.db.prepare("UPDATE permits SET expires=? WHERE id=?").run(this.expiry(now, a.policy.permitLeaseMs), ticket.id); this.save(a); return true;
    });
  }
  /** Cancellation and completion are the same idempotent terminal removal; no automatic reacquisition. */
  release(ticket: Ticket): boolean {
    return this.transaction(() => {
      const a = this.required(ticket.account);
      const removed = this.db.prepare("DELETE FROM permits WHERE id=? AND account=? AND generation=?").run(ticket.id, accountKey(a.account), ticket.generation).changes;
      if (removed) this.save(a); return !!removed;
    });
  }
}
