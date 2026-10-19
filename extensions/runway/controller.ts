import type { AccountBinding, QuotaRequest, QuotaSource } from "./quota";
import { TelemetryError } from "./sources";
import { QuotaCoordinatorStore } from "./coordination";
import type { Attempt, Ticket } from "./coordination";

export interface ControllerOptions { wakeIntervalMs: number; maxWaitMs: number; sourceTimeoutMs: number }
export type Acquired = { kind: "advisory" } | Extract<Attempt, { kind: "permit" }>;
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new Error("Quota request cancelled."); };

/** A bounded quota-domain service, not an agent/task scheduler or native API implementation. */
export class QuotaController {
  constructor(readonly store: QuotaCoordinatorStore, private readonly options: ControllerOptions) {
    for (const value of [options.wakeIntervalMs, options.maxWaitMs, options.sourceTimeoutMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid controller bounds.");
  }
  /** Register cancellation/timer before the atomic revision check. A wakeup only triggers reevaluation.
   * SQLite has no cross-process event subscription: bounded timers are the notification fallback. */
  private changed(account: AccountBinding, revision: number, signal: AbortSignal | undefined, delay: number, immediateAllowed: boolean): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const finish = (immediate: boolean, error?: unknown) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        error === undefined ? resolve(immediate) : reject(error);
      };
      const abort = () => finish(false, signal?.reason ?? new Error("Quota request cancelled."));
      const timer = setTimeout(() => finish(false), delay);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        cancelled(signal);
        if (this.store.snapshot(account)?.revision !== revision && immediateAllowed) finish(true);
      } catch (error) { finish(false, error); }
    });
  }
  /** Releasing a lease is not dispatch; the future native adapter still owns cancellation/credential matching. */
  async acquire(request: QuotaRequest, signal?: AbortSignal): Promise<Acquired> {
    cancelled(signal);
    const until = Date.now() + this.options.maxWaitMs;
    const enrolled = this.store.enqueue(request);
    if ("kind" in enrolled) return enrolled;
    const ticket: Ticket = enrolled;
    let keep = false;
    let immediateAllowed = true;
    try {
      for (;;) {
        cancelled(signal);
        const left = until - Date.now();
        if (left <= 0) throw new Error("Bounded quota wait expired; ticket removed.");
        const attempt = this.store.attempt(ticket);
        cancelled(signal); // Cancellation wins over a simultaneously published reset.
        if (Date.now() >= until) throw new Error("Bounded quota wait expired; ticket removed.");
        if (attempt.kind === "invalid") throw new Error("Quota ticket expired or account generation changed; explicit reacquisition required.");
        if (attempt.kind === "permit") { keep = true; return attempt; }
        // One immediate race recheck is allowed; revision churn cannot turn waiting into a busy loop.
        const immediate = await this.changed(ticket.account, attempt.revision, signal, Math.min(left, this.options.wakeIntervalMs), immediateAllowed);
        immediateAllowed = !immediate;
      }
    } finally { if (!keep) this.store.release(ticket); }
  }
  /** After trusted account/credential matching, cancellation must still win at dispatch. */
  markDispatched(ticket: Ticket, signal?: AbortSignal): boolean {
    try {
      cancelled(signal);
      const valid = this.store.markDispatched(ticket);
      if (!valid) this.store.release(ticket);
      return valid;
    } catch (error) { this.store.release(ticket); throw error; }
  }
  /** No automatic polling loop: the integration schedules probes respecting these account source bounds.
   * Network runs outside transactions; a timeout/lost lease can never publish obsolete allowance. */
  async poll(account: AccountBinding, source: QuotaSource, signal?: AbortSignal): Promise<"published" | "obsolete" | "not-due"> {
    cancelled(signal);
    const state = this.store.snapshot(account);
    if (!state) throw new Error("Account not enrolled.");
    if (this.options.sourceTimeoutMs >= state.policy.pollLeaseMs) throw new Error("Source timeout must fit within the account polling lease.");
    const lease = this.store.acquirePoll(account);
    if (!lease) return "not-due";
    const timeout = new AbortController();
    const timeoutTimer = setTimeout(() => timeout.abort(new Error("Quota telemetry polling timed out.")), this.options.sourceTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    let removeAbort: (() => void) | undefined;
    try {
      // Race also bounds injected sources which fail to honor their AbortSignal.
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(combined.reason ?? new Error("Telemetry polling cancelled."));
        combined.addEventListener("abort", abort, { once: true });
        removeAbort = () => combined.removeEventListener("abort", abort);
        if (combined.aborted) abort();
      });
      const reading = Promise.resolve().then(() => { cancelled(combined); return source.getObservation(combined); });
      const observation = await Promise.race([reading, aborted]);
      cancelled(combined);
      return this.store.publish(lease, observation) ? "published" : "obsolete";
    } catch (error) {
      this.store.publishFailure(lease, error instanceof TelemetryError ? error.issue : combined.aborted ? "network" : "malformed");
      throw error; // Faults are surfaced, not converted into a successful quota read.
    } finally { clearTimeout(timeoutTimer); removeAbort?.(); }
  }
}
