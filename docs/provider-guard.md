# Claude and Codex provider protection

Runway 1.2 uses Pi's supported Provider API, not a Pi patch or native admission ABI. Protection is off until the Captain explicitly enrolls the selected OAuth account.

## Enable on Homelab

Homelab already has `runway.claudeTelemetry: true`. In a Claude session:

```text
/reload
/runway blocking on
/runway blocking status
```

Recreate already-running managed children; they retain the code/provider inherited at launch. `blocking off` disables the selected account only, not another account or an in-flight request. Codex protection can remain off.

The stop threshold is 99% observed usage. Both all-model Claude windows—five-hour and weekly—must be below it and fresh. Known Sonnet/Opus pools apply to that model family; unknown applicability holds rather than guessing. A reset timestamp alone never restores permission. Holds end the current attempt with an explanation; they do not park a task, change managed deadlines or automatically retry.

## Request path

At `session_start`, `index.ts` captures each existing provider through public `ctx.modelRegistry.getProvider`, then `pi.registerProvider` installs `SubscriptionQuotaGuard`. Native, legacy and built-in origins are restored when the last scope releases its guard. Existing models, auth and transport overrides are retained. Multiple extension scopes reuse the same provider guard and owner leases rather than nesting gates.

Pi resolves the credential and endpoint before the provider callback. `provider-guard.ts` verifies that prepared request, polls through the quota controller, acquires a short local permit and rechecks credential, model applicability, policy and cancellation immediately before calling the original provider.

For Claude, `claude-proof.ts` accepts only the official Anthropic endpoint and an existing OAuth token, not API keys or caller-supplied fetch/host/auth routing overrides. The exact opaque token is verified through the existing `/api/oauth/profile` read-only endpoint; the account+organization identity is not inferred from a token prefix or advisory JSON. One in-memory profile proof is cached for at most two minutes and invalidated by a token change. Profile work is bounded, owned and cancelled on shutdown. No token is persisted. Usage is read with that same verified token. Known family scopes come from the actual model ID; an unrecognized family is not guessed.

For Codex, `codex-proof.ts` binds the prepared credential/account and official endpoint using the pinned provider's forced account/auth headers. Unbound or unsupported requests hold when that provider has protected accounts. Independent verified unenrolled accounts remain unprotected.

Enrollment, fenced telemetry, polling bounds and short-lived permits live in `~/.pi/agent/runway-provider-quota.sqlite`, shared across participating processes on that host. No account is enrolled during installation; advisory JSON and retired native authority state are not imported. `reserve` and forecast health are advisory, not stop thresholds.

## Coverage and limits

- Participating ModelRuntime full/simple streams, ordinary turns and compaction use the gate. Published managed foreground inheritance and shared-scope ownership are tested. Detached children must load Runway separately.
- Direct HTTP/standalone Pi-AI utility calls and provider-internal transport retries bypass this logical-stream gate. It is not a global network firewall.
- Telemetry may lag or round. Already-running streams and other clients can continue consuming quota. A 99% observation threshold is not a guaranteed spending ceiling.
- Missing, stale, failed or incomplete applicable evidence holds; HTTP quota-read failures are not evidence of inference exhaustion. Turning Claude telemetry off while its account is enrolled holds protected Claude requests rather than silently disabling the guard.
- Coordination is host-local. Workbook and Homelab do not share a SQLite permit pool. Pi-Bolt protection is unverified.
- No provider switching, paid fallback, login, credits activation, Pi patch or task scheduler is introduced.

**Claude quota protection is not an extra-usage spending cap.** Homelab's existing auth plugin adds Claude Code request shaping and billing headers; Runway neither reproduces nor modifies that behavior. Its routing claims do not establish vendor authorization or actual billing. The Anthropic billing warning remains enabled. Profile/usage access alone does not prove Pi inference consumes included subscription allowance.

## Verification

`npm test` covers provider/account separation, both Claude windows, model-specific pools, opaque-token changes, failure/opt-out holds, cancellation and no token persistence. `npm run test:pi` uses official Pi 1.1.0 and synthetic transports, with network disabled, to exercise real public command enrollment, package loading, legacy transport restoration, reload and managed inheritance. No paid inference is used for these probes.
