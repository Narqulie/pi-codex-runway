import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Provider, ProviderRequestOptions } from "@earendil-works/pi-ai";
import { codexDispatchAccount } from "./codex-proof";
import { claudeDispatchCredential, claudeModelFamily } from "./claude-proof";
import { QuotaCoordinatorStore } from "./coordination";
import type { CoordinationPolicy, Ticket } from "./coordination";
import { QuotaController } from "./controller";
import { accountKey } from "./quota";
import type { AccountBinding, QuotaSource } from "./quota";
import { claudeProfileCredentials, ClaudeUsageSource, WhamUsageSource } from "./sources";
import type { ClaudeTelemetryCredentials } from "./sources";

export const DEFAULT_PROTECTION_POLICY: CoordinationPolicy = {
  protected: true, stopUsedPct: 99, maxAgeMs: 300_000, concurrency: 2, guardUsedPct: 90, guardConcurrency: 1,
  maxQueue: 128, queueTtlMs: 60_000, permitLeaseMs: 30_000, pollLeaseMs: 15_000,
  pollIntervalMs: 120_000, pollFailureDelayMs: 120_000,
};
export class QuotaHeldError extends Error {
  constructor(reason: string) { super(`Runway request held: ${reason}. No new model stream was started. Check /runway blocking status and retry when resolved.`); }
}
const GUARD_HANDLE = Symbol.for("pi-runway.subscription-provider-guard");
export type GuardedProvider = "openai-codex" | "anthropic";
export type ProviderOrigin = { kind: "builtin" } | { kind: "native"; provider: Provider }
  | { kind: "legacy"; config: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>> };
export interface RegisteredGuard { guard: SubscriptionQuotaGuard; origin: ProviderOrigin }
export function registeredQuotaGuard(provider: Provider | undefined): RegisteredGuard | undefined {
  return (provider as (Provider & { [GUARD_HANDLE]?: RegisteredGuard }) | undefined)?.[GUARD_HANDLE];
}
type Backend = { store: QuotaCoordinatorStore; controller: QuotaController };
type Lifecycle = { kind: "pending" } | ({ kind: "ready" | "closing" } & Backend) | { kind: "closed" };
type Proof = { account: AccountBinding; credential?: string; modelFamily?: string; profile?: ClaudeTelemetryCredentials };
type Work = { abort: AbortController; ticket?: Ticket; proof?: Proof };
export interface GuardOptions {
  path: string;
  provider?: GuardedProvider;
  claudeTelemetry?: boolean;
  claudeCredentials?: (token: string, signal: AbortSignal) => Promise<ClaudeTelemetryCredentials>;
  now?: () => number;
  source?: (account: AccountBinding, options: ProviderRequestOptions) => QuotaSource;
}

/** Local logical-stream admission. No Pi patch, routing, task scheduling or transport retry interception. */
export class SubscriptionQuotaGuard {
  private profile?: { credential: string; value: ClaudeTelemetryCredentials; at: number };
  get provider(): GuardedProvider { return this.options.provider ?? "openai-codex"; }
  private lifecycle: Lifecycle = { kind: "pending" };
  private readonly work = new Set<Work>();
  private readonly owners = new Set<symbol>();
  constructor(private readonly options: GuardOptions) {}
  start() {
    if (this.lifecycle.kind === "ready") return;
    if (this.lifecycle.kind !== "pending") throw new QuotaHeldError("provider guard was closed; reload this session");
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const store = new QuotaCoordinatorStore(this.options.path, { busyTimeoutMs: 100, maxAccounts: 32, maxWindows: 32, maxMetadataChars: 65536 }, this.options.now);
    this.lifecycle = { kind: "ready", store, controller: new QuotaController(store, { wakeIntervalMs: 1000, maxWaitMs: 60_000, sourceTimeoutMs: 5000 }) };
  }
  retain(): () => void {
    if (this.lifecycle.kind === "closed" || this.lifecycle.kind === "closing") throw new QuotaHeldError("inherited provider guard was closed; reload the parent and recreate this child");
    const owner = Symbol(); this.owners.add(owner);
    return () => { if (this.owners.delete(owner) && !this.owners.size) this.close(); };
  }
  private backend(): Backend {
    if (this.lifecycle.kind !== "ready") throw new QuotaHeldError("provider guard is not ready; repair local quota storage and reload");
    return this.lifecycle;
  }
  get store() { return this.backend().store; }
  get phase() { return this.lifecycle.kind; }
  enroll(account: AccountBinding, policy = DEFAULT_PROTECTION_POLICY) {
    if (account.provider !== this.provider) throw new Error("Enrollment must match the guarded provider.");
    if (policy.stopUsedPct !== 99 || policy.maxAgeMs < 120_000 || policy.maxAgeMs > 300_000 || policy.pollIntervalMs < 120_000
      || policy.pollFailureDelayMs < 120_000 || policy.pollLeaseMs <= 5000 || policy.permitLeaseMs < 3000) throw new Error("Invalid subscription guard policy bounds.");
    return this.store.enroll(account, policy);
  }
  disable(account: AccountBinding) {
    const state = this.store.snapshot(account);
    if (state) this.store.enroll(account, { ...state.policy, protected: false });
  }
  async refreshSource(source: QuotaSource, account: AccountBinding | undefined, signal?: AbortSignal) {
    if (account?.provider !== this.provider || source.name !== (this.provider === "anthropic" ? "claude-oauth-usage" : "codex-wham")) return undefined;
    const { store, controller } = this.backend();
    if (!store.snapshot(account)?.policy.protected) return undefined;
    const work: Work = { abort: new AbortController() };
    this.work.add(work);
    const ownedSignal = signal ? AbortSignal.any([signal, work.abort.signal]) : work.abort.signal;
    try {
      try { await controller.poll(account, source, ownedSignal); } catch { /* Read the fenced failure, never substitute advisory evidence. */ }
      ownedSignal.throwIfAborted();
      const observation = store.snapshot(account)?.observation;
      if (!observation) throw new QuotaHeldError("protected telemetry is unavailable");
      return observation;
    } finally { this.work.delete(work); this.finishClose(); }
  }
  private async verify(model: Model<Api>, options: ProviderRequestOptions): Promise<Proof | undefined> {
    if (this.provider === "openai-codex") {
      const account = codexDispatchAccount(model, options);
      return account && { account };
    }
    if (!this.options.claudeTelemetry) throw new QuotaHeldError("Claude telemetry disabled; enable runway.claudeTelemetry for protected requests");
    const credential = claudeDispatchCredential(model, options);
    if (!credential) return undefined;
    const signal = options.signal!;
    signal.throwIfAborted();
    const now = (this.options.now ?? Date.now)();
    if (!this.profile || this.profile.credential !== credential || now < this.profile.at || now - this.profile.at >= 120_000) {
      const timeout = AbortSignal.timeout(5000), bounded = AbortSignal.any([signal, timeout]);
      let removeAbort = () => {};
      try {
        const cancelled = new Promise<never>((_, reject) => {
          const abort = () => reject(bounded.reason);
          bounded.addEventListener("abort", abort, { once: true });
          removeAbort = () => bounded.removeEventListener("abort", abort);
          if (bounded.aborted) abort();
        });
        const value = await Promise.race([
          this.options.claudeCredentials ? this.options.claudeCredentials(credential, bounded) : claudeProfileCredentials(credential, fetch, bounded), cancelled,
        ]);
        bounded.throwIfAborted();
        if (!value.verified || value.account.provider !== "anthropic" || value.accessToken !== credential) throw new QuotaHeldError("Claude profile did not match the actual request credential");
        this.profile = { credential, value, at: now };
      } catch {
        if (signal.aborted) throw signal.reason;
        throw new QuotaHeldError("Claude profile verification unavailable; check existing OAuth/profile permission and network");
      } finally { removeAbort(); }
    }
    return { account: this.profile.value.account, credential, modelFamily: claudeModelFamily(model), profile: this.profile.value };
  }
  /** Control-plane identity lookup; owned, bounded and never model inference. */
  async resolveAccount(model: Model<Api>, options: ProviderRequestOptions): Promise<AccountBinding | undefined> {
    this.backend();
    const work: Work = { abort: new AbortController() }; this.work.add(work);
    const signal = options.signal ? AbortSignal.any([options.signal, work.abort.signal]) : work.abort.signal;
    try { const proof = await this.verify(model, { ...options, signal }); signal.throwIfAborted(); return proof?.account; }
    finally { this.work.delete(work); this.finishClose(); }
  }
  private actualAccount(model: Model<Api>, options: ProviderRequestOptions, proof?: Proof): AccountBinding | undefined {
    if (this.provider === "openai-codex") return codexDispatchAccount(model, options);
    return proof && claudeDispatchCredential(model, options) === proof.credential && claudeModelFamily(model) === proof.modelFamily ? proof.account : undefined;
  }
  private async acquire(model: Model<Api>, options: ProviderRequestOptions, work: Work): Promise<Backend> {
    const backend = this.backend(), { store, controller } = backend;
    options.signal?.throwIfAborted();
    if (!store.accounts().some(account => account.account.provider === this.provider && account.policy.protected)) return backend;
    const proof = await this.verify(model, options);
    work.proof = proof;
    if (!proof) throw new QuotaHeldError("resolved subscription credential or endpoint cannot be verified");
    const { account } = proof;
    if (!store.snapshot(account)?.policy.protected) return backend;
    const profile = proof.profile;
    const source = this.options.source?.(account, options) ?? (this.provider === "anthropic"
      ? new ClaudeUsageSource({ enabled: true, credentials: async () => profile! })
      : new WhamUsageSource({ credentials: async () => ({ access: options.apiKey, accountId: account.accountId }) }));
    try { await controller.poll(account, source, options.signal); } catch { /* Atomic evaluation consumes retained failure evidence. */ }
    options.signal?.throwIfAborted();
    const ticket = store.enqueue({ account, modelFamily: proof.modelFamily });
    if ("kind" in ticket) throw new QuotaHeldError("enrollment changed during quota verification; retry");
    work.ticket = ticket;
    const decision = store.attempt(ticket);
    if (decision.kind !== "permit") {
      const reason = decision.kind === "invalid" ? "account policy or permit expired"
        : decision.blocker === "quota" ? "an applicable quota window reached the 99% stop threshold"
        : decision.blocker === "capacity" ? "the local account concurrency limit is occupied"
        : "quota telemetry is missing, stale, incomplete or unavailable";
      throw new QuotaHeldError(reason);
    }
    return backend;
  }
  /** The registered Provider receives already-resolved auth and endpoint overrides from ModelRuntime. */
  protect(base: Provider, origin: ProviderOrigin = { kind: "builtin" }): Provider {
    if (base.id !== this.provider) throw new Error("Subscription guard cannot replace another provider.");
    const provider: Provider & { [GUARD_HANDLE]: RegisteredGuard } = { ...base, [GUARD_HANDLE]: { guard: this, origin },
      stream: (model, context, options) => this.stream(model, options, resolved => base.stream(model, context, resolved)),
      streamSimple: (model, context, options) => this.stream(model, options, resolved => base.streamSimple(model, context, resolved)),
    };
    return provider;
  }
  private stream<TOptions extends ProviderRequestOptions>(model: Model<Api>, options: TOptions | undefined,
    start: (options: TOptions) => AssistantMessageEventStream): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    const work: Work = { abort: new AbortController() };
    this.work.add(work);
    const signal = options?.signal ? AbortSignal.any([options.signal, work.abort.signal]) : work.abort.signal;
    const resolved = { ...options, signal } as TOptions;
    let backend: Backend | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let delegated = false;
    const release = () => {
      if (renewal) clearInterval(renewal);
      renewal = undefined;
      if (work.ticket) {
        const store = backend?.store ?? (this.lifecycle.kind === "ready" || this.lifecycle.kind === "closing" ? this.lifecycle.store : undefined);
        try { store?.release(work.ticket); } catch { /* A short lease bounds cleanup after a store failure. */ }
        work.ticket = undefined;
      }
      this.work.delete(work); this.finishClose();
    };
    void (async () => {
      try {
        backend = await this.acquire(model, resolved, work);
        signal.throwIfAborted();
        if (work.ticket) {
          const actual = this.actualAccount(model, resolved, work.proof);
          if (!actual || accountKey(actual) !== accountKey(work.ticket.account)) throw new QuotaHeldError("resolved account or route changed during verification; retry");
          if (!backend.store.markDispatched(work.ticket)) throw new QuotaHeldError("quota or policy changed before dispatch; retry");
          renewal = setInterval(() => {
            try { if (!backend!.store.renewPermit(work.ticket!)) work.abort.abort(new QuotaHeldError("request permit lease was lost")); }
            catch { work.abort.abort(new QuotaHeldError("request permit renewal failed")); }
          }, 1000);
          renewal.unref();
        } else if (backend.store.accounts().some(account => account.account.provider === this.provider && account.policy.protected)) {
          work.proof ??= await this.verify(model, resolved);
          const actual = this.actualAccount(model, resolved, work.proof);
          if (!actual || backend.store.snapshot(actual)?.policy.protected) throw new QuotaHeldError("account or protection changed before dispatch; retry");
        }
        signal.throwIfAborted();
        delegated = true;
        const inner = start(resolved);
        for await (const event of inner) {
          if (event.type === "done" || event.type === "error") release();
          output.push(event);
        }
        const result = await inner.result();
        release(); output.end(result);
      } catch (error) {
        const aborted = signal.aborted;
        const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: aborted ? "aborted" : "error", timestamp: Date.now(),
          errorMessage: aborted ? "Runway request cancelled." : error instanceof QuotaHeldError ? error.message : delegated ? "Runway provider stream failed; check provider diagnostics." : "Runway request held: quota coordination failed. No new model stream was started. Repair local storage and retry." };
        release(); output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message }); output.end(message);
      } finally { release(); }
    })();
    return output;
  }
  close() {
    this.profile = undefined;
    this.owners.clear();
    if (this.lifecycle.kind === "closed") return;
    if (this.lifecycle.kind === "pending") this.lifecycle = { kind: "closed" };
    else this.lifecycle = { ...this.lifecycle, kind: "closing" };
    for (const work of this.work) work.abort.abort(new Error("Runway session closed."));
    this.finishClose();
  }
  private finishClose() {
    if (this.lifecycle.kind === "closing" && !this.work.size) { this.lifecycle.store.close(); this.lifecycle = { kind: "closed" }; }
  }
}
