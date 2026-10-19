# pi-runway for Pi

Provider-neutral account quota overview, pure admission-policy evaluation, account-bound weekly forecasting and task receipts for [Pi](https://github.com/earendil-works/pi).

**Protection is off by default.** On unmodified official Pi 1.1.0, Runway can guard Claude and Codex requests through Pi's supported provider API. It checks the resolved account, endpoint and shared quota state before starting each new answer-generation stream. No Pi patch or native admission ABI is needed. Claude protection checks both five-hour and weekly windows, but is not an extra-usage spending cap. Direct provider calls, unenrolled accounts and provider-internal retries are outside its protection. See [provider guard and coverage](docs/provider-guard.md).

The package/product is now `pi-runway`, with entry point `extensions/runway/index.ts` and primary command `/runway`. `/codex-runway` remains an explicitly transitional alias. The actual repository remains [Narqulie/pi-codex-runway](https://github.com/Narqulie/pi-codex-runway); no new repository, npm publication, tag or install route is implied.

## Local development

Requires a supported Pi runtime and Node **22.19+** (Pi baseline), including built-in `node:sqlite`. The backend uses `DatabaseSync`, statements and SQL pragmas available on that baseline, not native addons or a new network dependency. Current checks exercise Node 26.11 and stock Pi 1.1.0; Node 22.19 and Pi-Bolt were not executed here. Pi supplies extension imports; the local tests pin Pi-AI 1.1.0.

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm test
# Stock Pi + installed managed runtime, synthetic providers only, no real inference:
RUNWAY_PI_SDK_MODULE="$(npm root -g)/@earendil-works/pi-coding-agent/dist/index.js" \
RUNWAY_SUBAGENTS_FACTORY_MODULE="$HOME/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/child-session.js" \
npm run test:pi
# Optional manual load:
pi -e ./
```

No global installation or configuration change is needed to test this checkout. The default extension polls the active session's Codex telemetry, or Claude telemetry when explicitly enabled, and fetches the public ECB rate endpoint after tasks. Tests use synthetic fixtures/injected transports, not live credentials or quota endpoints.

## Use

```text
/runway
/runway receipt
/runway refresh
/runway history
/runway reserve 15
/runway clear
/runway alerts off               # silence forecast warnings and continue prompts
/runway alerts on                # restore forecast alerts
/runway alerts status            # this session only; defaults to on
/runway blocking status          # also shown in the overview
/runway blocking on              # current Claude/Codex account; explicit opt-in
/runway blocking off             # current account only; shared local enrollment
/runway status                   # compatibility commands remain available
/runway protect                  # current Claude/Codex OAuth account, stop 99%
/runway protect 300000 2         # maxAgeMs 120000–300000, concurrency 1–8
/runway disable                  # current account only
```

In the terminal, `/runway`, `receipt` and `history` open a temporary panel. Use arrow keys or Page Up/Page Down to scroll; Enter or Escape closes it. These views do not write the overview into the transcript or leave a widget above the editor. Refresh, reserve, clear and blocking commands give a short confirmation and update the footer. RPC clients receive requested details once as a notification, without a widget.

`alerts off` silences sustainability warnings and the Sol/Astra "Continue?" confirmation for this session. Forecasts, footer status, task receipts and quota protection remain active. Receipts use informational severity while alerts are off. The footer shows `alerts OFF`; `/runway` also shows alert status. Reloading or starting a new session restores alerts. This setting is not saved globally and does not change `/runway blocking`.

Enabling protection stops new guarded Claude/Codex streams at 99% observed usage. Missing, stale, incomplete or failed quota evidence also holds them. A hold ends that attempt with an explanation; it does not park a task until reset. Check quota and submit a new request when resolved. Disabling protection affects the current account's new requests, not in-flight requests. The overview reports ON, OFF, UNAVAILABLE or DEGRADED. An unsupported or replaced provider is visibly unavailable. No account is enrolled during installation. Pi-Bolt protection is unverified; do not restore a patched Pi to use this feature.

Load this package once through Pi settings. Do not also leave the retired `codex-runway` copy in `~/.pi/agent/extensions/`: that duplicates commands, timers and receipt handlers. `/codex-runway` is one compatibility alias supplied by this package, not another installation.

The overview lists stable provider/account bindings and **all** observed windows, their applicability, observed usage, individual reset times, stale/unknown data and observed blockers. It distinguishes unavailable guards, available-but-off guards, and explicitly enrolled Claude/Codex accounts. The active provider's adapter polls every two minutes. It resolves the existing credential through Pi at refresh time, including Pi's normal OAuth renewal, and verifies a stable account binding. Absent identity is an actionable error, not a provider-wide anonymous pool. Tokens are not retained in quota state.

WHAM primary/secondary labels are metadata. Published windows are retained and identified by their actual durations, not assumed roles. An explicit `null` role is a published absence, while an omitted role remains unknown. Neither means zero usage. Only one known all-model 604800-second window is projected into the weekly forecast. Unknown durations or additional unknown scopes are not guessed; missing windows are not zero allowance. Absolute provider reset timestamps take precedence over reconstructed relative timestamps.

`clear` clears the selected forecast history, not quota observations or observed blockers. `reserve` is forecast advice and does not change the 99% evaluation threshold.

## Claude telemetry, explicit opt-in

Claude telemetry is off by default. To use an existing authorized Claude OAuth login, add this to personal `~/.pi/agent/settings.json`, then run `/reload`:

```json
{
  "runway": {
    "claudeTelemetry": true
  }
}
```

When Claude is the active provider, Runway asks Pi for the existing OAuth credential and verifies profile access through `/api/oauth/profile`. A successful profile response supplies the account and organization UUIDs, which together bind the subscription. It then reads `/api/oauth/usage`. Claude-only sessions do not poll Codex. Advisory refreshes verify profile access. Protected requests bind the exact prepared token to its account+organization, cache one profile proof for at most two minutes, and invalidate it on token changes. Switching accounts cannot reuse another subscription's forecast history or permit.

The setting grants read-only telemetry access. It does not log in, enroll an account, enable blocking, change inference authentication, or enable paid usage. Pi owns normal credential renewal. Runway does not scan cookies, Keychain, or other clients' credential stores. Headers are limited to bearer authorization, JSON accept and the OAuth beta header, with no impersonated CLI identity or retry-as-another-client behavior.

`ClaudeUsageSource` also accepts injected verified telemetry credentials for tests or trusted integrations. Tokens are never written to quota state or committed files.

Five-hour and all-model weekly windows remain separate; published Sonnet/Opus weekly windows are model-scoped. Structured `limits` rows are deduplicated only when their published kind, all-model scope, percentage and reset match the corresponding named window. Conflicting or unrecognized rows remain visible unknown limits. `seven_day_breakdown` reports where usage occurred, not another allowance window. Unknown additive limits remain unknown and cannot silently be ignored by protected policy. `extra_usage` is paid spend, not subscription percentage, and is not converted into allowance.

This unofficial endpoint shape is based on public implementation evidence, not a guaranteed vendor API contract. HTTP authentication, permission, throttling and network errors are telemetry failures, never evidence of inference exhaustion. The endpoint may require permissions unavailable on an inference-only token. Observation does **not** establish authorized third-party subscription inference or its billing source. Native Anthropic usage, approved runner control and API/usage-credit billing are distinct capabilities. Consult [Anthropic's authorization guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account) before enabling an integration; no paid fallback or credits are enabled here.

## Policy foundation and storage

`quota.ts` defines one provider-neutral model (`AccountObservation` with independent `QuotaWindow` records) used by adapters, overview and weekly projection. `evaluateAdmission` is pure and returns candidate `admit`, `hold` or `advisory` decisions; the provider guard consumes the same evaluation through SQLite. Explicitly protected candidates require every applicable window fresh and below the default **99% observed usage** threshold. The caller supplies account binding, model family/feature applicability and freshness budget. Unknown applicability/data, stale readings, incomplete inventory and retained blockers hold. Unreadable known model-scoped rows hold only applicable requests, not unrelated model families. A published reset time does not grant admission; only fresh below-threshold evidence clears an observed blocker. Reset times are probe hints only, never permission to dispatch. Unenrolled accounts remain advisory and independent accounts do not share identity.

99% is not a guaranteed spending ceiling: readings may lag/round and external clients or in-flight requests can spend more. Pure advisory helpers retain their illustrative ten-minute budget. Explicit Claude/Codex enrollment uses a bounded maximum five-minute freshness budget and two-minute source probes; live provider lag/rate-limit guarantees have not been verified.

Local `~/.pi/agent/runway.json` is **advisory persistence, not transactional admission authority**. Version 2 contains bound observations and separate per-provider/account forecast histories in `forecasts`. Existing version-1 `codexForecasts` are validated and migrated without rebinding samples or discarding history. Reload all sessions on a host when applying this schema change; old loaded code cannot read version 2. A validated one-time import copies legacy `codex-runway.json` configuration/history into a separate **unbound legacy forecast**, never into the next authenticated account's history. The original legacy file is always preserved. Invalid input or failed migration disables persistence visibly instead of overwriting it; existing neutral state is never silently reimported. Concurrent initial imports use exclusive publication, but subsequent JSON read/modify/write updates are not coordinated across processes. The separate SQLite backend below provides transactional shared observations and short-lived permits. Protected requests use SQLite exclusively for policy, telemetry and permits; JSON copies feed advisory forecasts only. The guard preserves caller cancellation and settles held attempts promptly. Managed wall-clock deadlines continue to apply. There is no suspended active-work budget or automatic long-reset continuation. Do not use JSON as a request permit store.

## Repository-local transactional coordination backend

`extensions/runway/coordination.ts` exports `QuotaCoordinatorStore`; `controller.ts` exports `QuotaController`. These remain quota-domain primitives, **not** an agent/task runtime or transport wrapper. `provider-guard.ts` wraps the existing provider during `session_start` through the public registry. `codex-proof.ts` verifies the resolved Codex credential and official endpoint; `claude-proof.ts` verifies the prepared Claude route and `SubscriptionQuotaGuard` verifies the exact opaque token's profile. The guard opens `~/.pi/agent/runway-provider-quota.sqlite`, shared by participating sessions on that host. Enrollment is explicit. Neither advisory JSON nor the retired native `runway-quota.sqlite` is imported, so installing the new guard does not enable protection.

A trusted integration must supply a verified `{ provider, accountId }` binding and explicit configuration:

- `StoreLimits`: `busyTimeoutMs`, `maxAccounts`, `maxWindows`, `maxMetadataChars` (per-field and total observation JSON bound). Only the latest merged observation is retained; missing windows/blockers are not evicted to fit the bound.
- `CoordinationPolicy`: `protected`, `maxAgeMs`, `stopUsedPct` (99 if omitted), `concurrency`, `guardUsedPct`, `guardConcurrency`, `maxQueue`, `queueTtlMs`, `permitLeaseMs`, `pollLeaseMs`, `pollIntervalMs`, `pollFailureDelayMs`. The subscription provider guard supplies bounded defaults separately from forecast policy. Its control loop delegates polling to the fenced controller and respects shared next-poll bounds; telemetry failures never grant permission.
- `ControllerOptions`: `wakeIntervalMs`, `maxWaitMs`, `sourceTimeoutMs`; the source timeout must fit inside the account's polling lease. Controller wait bounds are wall-clock bounds, not suspended active-work budgets.

Usage integration seam (configuration and authorized source supplied by the integration):

```typescript
import { QuotaCoordinatorStore } from "./extensions/runway/coordination";
import { QuotaController } from "./extensions/runway/controller";

const store = new QuotaCoordinatorStore(repositoryLocalDatabasePath, storeLimits);
store.enroll(verifiedAccount, verifiedAccountPolicy); // Explicit enrollment/policy change
const quota = new QuotaController(store, controllerOptions);
await quota.poll(verifiedAccount, authorizedQuotaSource, telemetryAbortSignal);
const candidate = await quota.acquire({ account: verifiedAccount, modelFamily }, requestAbortSignal);
// Low-level bounded-domain example only. The provider guard uses enqueue/attempt
// and returns a terminal hold rather than waiting for quota or capacity.
```

API contract:

- `enroll` returns account generation/revision. Re-enrollment changes generation, fences polling and invalidates queued/pre-dispatch grants while retaining observations and already-dispatched account occupancy. Do not re-enroll on every request. Unenrolled/unprotected requests return `advisory`, not a permit.
- `snapshot` returns authoritative account metadata. `acquirePoll`/`renewPoll`, `publish`/`publishFailure` provide one short fenced poll lease per account. Publication consumes the lease and sets an explicit next-poll lower bound; late/expired/old-generation results cannot overwrite state. `quota.poll` injects the existing `QuotaSource` interface, performs no credential discovery and bounds even sources that ignore cancellation. Source failures are classified metadata, retained blockers remain, and faults are surfaced.
- `enqueue`/`attempt` provide bounded FIFO **eligible** requests. An exhausted scoped head does not block an eligible unrelated family. Hold results distinguish observed exhausted `quota`, unavailable/stale `telemetry`, and `capacity`, with the pure policy's detailed reasons. Account concurrency, including configured guard-zone reduction, yields a `capacity` blocker; it is not reported as provider exhaustion below the stop threshold. Permits do not reserve or invent usage percentages.
- `quota.acquire` waits with cancellation, a bounded timer and an atomic revision check after arming the local wakeup/cancel subscription. There is no cross-process push channel: each timer/revision wake only triggers another transactional evaluation, never permission. Queue expiry/generation change requires explicit new acquisition at the tail; cancelled tickets cannot revive.
- Before dispatch, Pi resolves credentials; the policy must verify actual provider/account/model applicability still matches the admitted binding, recheck its real request abort signal, then call `store.markDispatched(ticket)` after checking cancellation. This performs the final transactional quota/generation/expiry check exactly once; `store.valid(ticket)` is a diagnostic pre-dispatch check, not a substitute. No credential lock may be held while waiting.
- `renewPermit` maintains short granted/in-flight leases; `release` is idempotent for completion, cancellation and dispatch failure. An old-generation in-flight lease can renew **occupancy only**, never authorize another dispatch. In-flight calls must renew and settle; expiry is local reclamation, not proof that a provider call stopped. Account policies cannot erase active spending. The runtime remains responsible for cancellation after a returned grant and terminal cleanup.

Every store decision/update uses a short SQLite transaction with per-account revision. No network or asynchronous waiting occurs inside database locks. Database/invalid-state faults throw and fail closed; damaged or unrecognized databases are never silently replaced. The store persists only account/policy/window metadata and random coordination identities plus model-family/feature applicability, not credentials, prompts, request payloads or executable task/session records. Callers must not put secrets in metadata fields. Independent provider/account pools do not share capacity or allowance.

[Provider coverage](docs/provider-guard.md) distinguishes registered model calls from direct calls. The guard does not intercept provider-internal retries, enroll independent accounts, change managed deadlines, recover tasks across processes or resume them after long resets. It does not intercept `prepareRequest`, modify Pi or rely on an extension-hook veto.

## Weekly forecast

The default schedule is Monday–Friday, 09:00–16:00 local time. Weekends have zero planned weight. A forecast begins after two usable workday pace samples; until then it reports `learning`, not an invented rate from small whole-percent movements. Existing workday/EWMA calculations are retained:

```text
usableBudget = remainingPct - reservePct
sustainableBurnPerWorkday = usableBudget / remainingWeightedWorkdays
recentBurnPerWorkday = EWMA(completed daily burn / workday weight)
expectedFutureBurn = recentBurnPerWorkday × remainingWeightedWorkdays
paceRatio = recentBurnPerWorkday / sustainableBurnPerWorkday
```

| Pace ratio | Status | Advice |
|---:|---|---|
| <0.75 | FREE | no warning |
| 0.75–0.90 | HEALTHY | normal work |
| 0.90–1.10 | ON BUDGET | monitor pace |
| 1.10–1.30 | TAKE CARE | prefer a lighter model when the task permits |
| >1.30 | SLOW DOWN | existing interactive Sol/Astra advice applies on Codex |

## Task receipts

After Pi settles, a compact notice shows uncached input, cache read, output, API-equivalent euros, the active account's weekly readings when available, and any forecast status change. `/runway receipt` shows the latest task's provider-neutral parent-model and completed managed-child breakdown. New entries use `runway-receipt`; legacy `codex-runway-receipt` entries remain readable without rewriting session history. Changed/unbound quota accounts and resets make movement unavailable rather than comparing unrelated pools.

Reasoning tokens, when reported, are already included in output. Pending async child work is labelled pending, not zero usage. An async notification alone does not backfill the earlier receipt; use `/subagent-cost` after completion for session-wide managed-child totals. A later task can include that child's usage if its structured managed result reaches Pi.

The euro estimate uses Pi's catalog dollar cost and the dated [ECB USD/EUR reference rate](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml), fetched at most hourly. If unavailable, it shows the dollar estimate. This is **not a subscription charge**. A zero-priced model with tokens reports unavailable pricing rather than suggesting a free task.

WHAM readings cover the whole account and round to whole percentages. Before/after movement is **observed account-wide**, not the task's individual share; overlapping sessions, external use and small tasks prevent reliable per-job attribution. Cache/child signals describe where usage occurred, not exact token cost of individual tool outputs. No exact token-to-subscription conversion is performed.

## Security and verification limits

Extensions execute with your local user permissions; review the source before loading. Quota history stays local. Quota collection sends Codex credentials only to WHAM; explicitly enabled Claude telemetry sends credentials only to Anthropic's profile and usage endpoints. Allowed inference uses Pi's original provider connection. No credentials are stored in Runway state. Public ECB FX fetching remains separate from quota collection.

Offline tests cover source parsing, independent window/model applicability, unknown/stale/partial blockers, migration failure preservation, account-isolated forecasting, rename/alias/legacy receipt compatibility and receipt accounting. Backend tests add deterministic clocks, fencing/takeover, restart retention, generation/in-flight occupancy, guard capacity, eligible FIFO/reacquisition/expiry, bounded cancellation/polling and **two genuine processes sharing one tempfile database**. Seven mandatory stock-Pi probes use synthetic providers to exercise the actual package loader, ordinary AgentSession turns, both model-stream APIs, request purposes, explicit enrollment through the real ModelRegistry, configured-provider restoration on reload, shared guard ownership and published managed foreground inheritance. They make no real inference calls and do not skip missing runtime requirements. Live read-only Codex and Homelab Claude telemetry was verified on 2026-10-09 using existing local grants. This does not prove every custom request route, cross-machine coordination or hours-long task continuity. See the approved [design](docs/pi-runway-design.md) for later delivery stages.

MIT licensed.
