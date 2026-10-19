# pi-runway subscription management design

Current delivery, approved 2026-10-09: the Captain ruled out further Pi modifications. Runway 1.1.0 uses the supported provider API on official Pi 1.1.0 for explicit Codex protection. It retains the SQLite quota model, forecasting and receipts. Held attempts terminate with an explanation rather than waiting through resets. Claude telemetry is readable but remains advisory. See the [provider guard contract and coverage](provider-guard.md). No account is enrolled by installation.

The native ABI2 implementation and patched runtime described by the 2026-10-07 proposal are retired rollback evidence, not current dependencies. The broader proposal below is historical. Native waits, suspended active-work budgets and full workflow continuity are not implemented by the current provider guard. Council closed on 2026-10-07 after two passes.

## Recommendation

Rename the product to **pi-runway** and add cooperative, subscription-account-wide request admission. Keep forecasting and receipts, but separate them from the admission decision.

Runway should answer two different questions:

- At this pace, will the allowance last until reset?
- May this particular account/model request start now?

A poor weekly forecast is advisory. An observed exhausted applicable window is a request hold. Neither token counts nor API-equivalent prices establish subscription allowance.

Build the account model and verified request coverage first. The full promise of waiting hours and continuing requires a small Pi admission contract plus owned quota-wait support in pi-subagents. Do not sell an extension-only hook as comprehensive protection.

## User outcome

When an enrolled subscription reaches 99% observed usage, participating requests wait without losing the task. The display identifies the account, blocking windows, next reset/probe, and whether the problem is exhaustion or unavailable telemetry. Work on independent subscriptions remains possible. Provider changes and paid spending require explicit policy.

99% is an observed stop threshold, not a guaranteed spending ceiling. Provider readings can lag or round; requests already in flight and external clients can consume more. A lower configurable threshold gives more headroom but still cannot guarantee the final percentage.

## Account and window model

Use one authoritative quota pool identified by provider and stable account/subscription identity. Models and rotating access tokens are not account identities. If an adapter cannot establish identity, require an explicit verified binding rather than merging all users of a provider.

Each pool contains independently observed windows:

- A provider window identifier and its applicability to models/features.
- Used percentage and provider reset timestamp, when published.
- Observation time, source identity, revision and evidence quality.
- Whether the value is known, unavailable, stale, or a confirmed provider refusal.

Keep the provider's primary/secondary labels as metadata. Do not assume they mean five-hour/weekly. Do not synthesize absent windows as zero usage. A previously known applicable blocker cannot disappear because a refresh returned partial data.

Admit only when every applicable protected window is fresh and below its stop threshold. A model-specific weekly block need not stop a model outside that scope, but changing the task's model still follows the approved routing policy.

Claude Pro has both a five-hour window and a separate all-model weekly limit. Resetting the first does not clear the second. Report each blocker and probe their published resets separately; do not invent one universal reset countdown.

## Observation and local coordination

Use a local transactional store for observations, account policy, known blockers, bounded history and short-lived coordination leases. SQLite is the recommended storage choice, subject to the supported Node/platform dependency check. Atomic replacement of the current JSON file is not sufficient to serialize multiple processes' read-modify-write decisions.

One elected poller per account renews a short lease. Other sessions consume the shared observations. Polling has bounded network timeouts, jitter, backoff and provider-rate-limit awareness. It costs no model tokens. A lost lease permits takeover, not a second perpetual poller.

Do not hold store locks while polling or waiting. Reject late results from an obsolete poll/account generation. Preserve exhaustion across process restarts. Prefer absolute provider reset timestamps to reconstructed relative timestamps when available.

A reset timer schedules a telemetry probe. It never grants permission by itself. A fresh observation must show allowance below the threshold and clear every applicable blocker. Endpoint throttling is a telemetry failure, not proof that inference quota is exhausted.

Near the configured guard zone, reduce account-level in-flight concurrency and refresh within source limits. Coordinate short-lived request permits, not invented percentage reservations. Release eligible requests through a fair queue, reacquiring execution capacity rather than waking the whole fleet at once. Leases must expire or be reclaimable after a confirmed lost owner.

## Native request admission

Pi owns dispatch; Runway supplies quota policy. Proposed admission inputs are actual provider/model, opaque account binding, request purpose, request/owner identity, and the actual request abort signal. Admission must have non-swallowed outcomes and publish owned wait transitions. It is not another generic payload-transform event.

The logical control flow is:

1. Identify the candidate request and account binding without retaining a bearer token in quota state.
2. Await admission with cancellation and a bounded policy for unavailable telemetry.
3. Resolve fresh dispatch credentials after the wait.
4. Verify that the resolved account still matches the admitted account and generation. Re-admit after an account change.
5. Recheck cancellation and permit validity immediately before dispatch.
6. Release the permit on completion, cancellation or dispatch failure.

Do not hold credential-operation locks during quota waits. Cancellation must win over a simultaneous reset notification.

Install the contract explicitly in each Pi ModelRuntime, including managed foreground/background children. Parent extension loading is not proof of child coverage. Cover ordinary turns, continuation, summaries/compaction, optional cache warming, nested calls and auxiliary model agents. Optional cache warming should stop rather than consume allowance or accumulate parked work while a protected pool is blocked.

The intent arbiter currently creates a direct Agent. Route its inference through admitted execution, or return its existing unavailable result without inference for a protected account until that integration exists. Do not disable unrelated accounts.

Do not indiscriminately gate `prepareRequest`: it also serves deferred cancellation. Cancellation, credential repair, telemetry and control requests must remain available. Deferred retrieval needs explicit billable/non-billable classification.

Provider-internal retries are a separate transport responsibility. Inventory them and define whether re-admission is required before another potentially billable attempt. Logical-call admission alone does not establish per-HTTP-attempt protection. Do not implement transport wrappers merely to conceal uncovered paths.

## Waiting is owned work

Represent an explicit owned `quota_wait` condition within the existing lifecycle, with request/run identity, blocking pool/windows, reason, start time, next probe, observation revision and cancellation route. Preserve manual pause and terminal cancellation meanings. Runway is not allowed to create a second task runtime.

FleetView should distinguish quota waiting from stale telemetry, manual pause, ordinary queueing and a failure. A known quota wait suppresses idle/stall notifications and quota-triggered fallback. Wait progress is deterministic, not repeated LLM narration.

A display could read:

```text
Claude Pro · waiting for quota
5h 99% used · next probe 14:32
Weekly 64% used · no weekly blocker
3 requests waiting · no provider change · no paid fallback
```

Keep refresh, cancel, authentication repair and approved routing controls available. A task receipt records wait duration separately from active work and does not pretend waiting consumed tokens.

### Deadline semantics

Current managed background defaults are 30 minutes. Keeping those timers unchanged cannot satisfy a five-hour reset wait.

Introduce an opt-in active-work budget rather than silently reinterpreting `timeoutMs` or `deadlineAt`. Existing explicit wall-clock deadlines remain hard limits. For a reset-wait-enabled run, verified quota waits do not consume its active-work budget; remaining budget is retained and resumed correctly.

An ancestor's active clock pauses only when its entire owned scope is demonstrably quota-blocked. One waiting parallel descendant is insufficient. Running tools, verification commands and runnable siblings still count as active work. Real tool-execution timeouts, shutdown grace, stop/cancel and explicit human deadlines remain absolute.

For ancestry that cannot propagate this contract, return a non-error parked handle and a completion subscription rather than leaving a delegation tool under an expiring timeout. A wait-window expiry may return control without cancelling the retained work. An explicit run deadline or cancel is different and prevents later automatic revival.

Ship owned wait transitions, clock accounting, ancestor propagation/parking and fallback suppression together before claiming hours-long continuity. A bounded-wait prototype must say plainly that its existing deadlines still apply.

### Capacity and recovery

A parked child releases runnable execution capacity and reacquires it fairly before inference resumes. It does not silently release lifecycle ownership or bypass max-active-run accounting. Bound retained sessions/processes separately so parked work cannot grow without limit. Do not repurpose abandoned-run detection to reclaim an intentionally waiting child.

While the process lives, continue the pending request in the same session. After a crash, an in-memory suspended stack is gone. Recovery uses runtime-owned session records and a verified request-boundary checkpoint; quota state alone cannot recreate execution. Do not replay tools or start duplicate writers. Uncertain side-effect completion requires operator review. Cancelled or expired work stays cancelled or expired.

## Protection and routing policies

Proposed defaults, subject to Captain approval:

- Unsupported or unenrolled providers are advisory, not globally blocked.
- Explicitly protected accounts hold new requests when evidence is stale/unavailable. Show the cause and repair path. Never clear known exhaustion due to missing telemetry.
- A human may grant an account-scoped, expiring override. Record it locally and show that protection is bypassed. An agent cannot approve its own override.
- Default action on exhaustion is wait, not change model/provider.
- Alternative routing must name approved providers, capability floors, privacy restrictions and spending classes. No implicit API billing, usage credits, account rotation, or local-model substitution.
- An approved alternative still needs admission against its own applicable pool. Cancel the original pending request before transferring execution; do not run two writers.

The stale-data policy trades availability for protection. Define freshness from actual adapter behavior and rate limits, not a universal guessed TTL. Missing permission, authentication failure, endpoint throttling and malformed data need distinct actionable reasons.

## Provider authorization and billing

Official Claude guidance says included subscription usage is designed for native Anthropic applications. Third-party access preferably uses Console API keys or supported cloud providers; Anthropic may allow certain third-party tools with credits enabled and may debit those credits. Misrepresenting identity or routing third-party traffic against subscription limits is prohibited by the published guidance.

The reported homelab success establishes functionality, not authorization, usage scope or billing mode. Before enabling a protected Claude route, establish which approved integration is in use and which allowance actually funds inference. Observing a subscription, managing an approved native Claude Code runner, and direct API inference are separate capabilities.

CodexBar documents a Claude usage endpoint requiring `user:profile`; inference-only permission may not permit telemetry. This is public implementation evidence, not an official API contract. Do not silently extract browser cookies, imitate client identities, refresh unrelated credential stores or enable credits to make an adapter work. A runner integration is protective only where its supported execution interface can actually defer requests.

## Cross-machine coordination

Start with shared local-account coordination. Add cross-host coordination only when the same pool is actively used by multiple machines.

If enabled, use one private authenticated authority for account observations and admission decisions, reachable over the existing private network. No inference credentials, prompts, tool payloads or bearer tokens in coordinator state. Use verified opaque account bindings and enforce admission revisions/leases on every client. The remote service coordinates quota, not agent execution.

A partition cannot preserve global serialization while letting each host spend independently. Protected accounts hold when authority/freshness is unavailable, unless a human explicitly downgrades coordination for that account. Independent subscriptions remain independent. This mode changes the current local-only promise and must be opt-in. Git, backup sync and pi-sync are not live coordination channels.

## Rename and compatibility

Proposed migration includes package/display name, `/runway`, extension path and neutral state storage. Preserve the legacy `/codex-runway` command for a documented transition because it is already installed and used. Read legacy receipt custom entries; do not rewrite session history.

Perform one validated import of legacy weekly history/configuration and preserve the original file until import succeeds. Do not attribute legacy account-less observations to an arbitrary new account. Keep reserve-based forecast advice independent of the 99% admission threshold.

Compare the homelab version before implementing to avoid discarding newer provider support. Remote repository rename, release/tag changes, installing runtime changes and publishing packages are separate approval steps.

## Delivery order and acceptance

1. **Verify and model.** Inspect homelab drift through an approved read-only route; establish provider authorization, billing and telemetry capabilities. Add neutral account/windows and policy evaluation with deterministic fixtures. Rename/migrate with explicit compatibility. No protection claim yet.
2. **Prove native admission.** Add the narrow Pi contract and explicit runtime registration. Test no dispatch while held, cancellation-before-reset, changed account, refreshed credentials, auxiliary coverage, control-operation bypass and retry behavior. Feature detection must report unsupported runtime honestly.
3. **Deliver local reset continuity.** Implement transactional multi-process observations/poll lease and owned managed-child waits, active budgets, ancestor parking, capacity release/reacquisition and FleetView metadata as one coherent protected mode.
4. **Extend only where needed.** Add confirmed same-account cross-host coordination and explicitly approved routing after local correctness is established.

Focused acceptance scenarios:

- Two processes share an account; both hold at observed 99%, with one provider poller.
- Five-hour reset clears but weekly quota remains blocked; no inference starts.
- Stale/partial/auth-failed data cannot silently clear a known blocker; unrelated accounts remain usable.
- Fake-clock five-hour wait preserves opted-in active budget and resumes once; explicit hard deadline still expires.
- Waiting nested descendants do not expire their owned dependency clocks; active siblings prevent an ancestor-wide clock pause.
- Parked work releases runnable capacity, has bounded retention, and fairly reacquires slots without a reset stampede.
- Cancel races with reset, account changes during waiting, and expired credentials cause no unintended dispatch.
- Ordinary calls, compaction, cache warming and auxiliary inference obey their documented coverage; cancellation/control remain possible.
- Poller crash/late result and runtime restart preserve blockers and do not replay side effects or revive cancelled work.

Live adapter tests require authorized access and sanitized fixtures. None were performed for this memo. Select actual validation commands from each affected repository before implementation; passing the existing Runway tests would not verify new runtime contracts.

## Council disposition and confidence

Pass 1 used prescribed fallbacks because no executable `council-*` profiles existed: `oracle` on Astra/high with forked context and `reviewer` on Sol/high with runtime-default context, not independently identified as fresh/fork. Both completed. Pass 2 used fresh-context fallbacks because `children.list` reported no retained children. The reviewer completed; oracle failed with `WebSocket closed 1000` before returning a report. Stop at the two-pass cap. This is parent synthesis with incomplete final quorum, not unanimous convergence.

Accepted: stable account/all-window gates, transactional observations, fresh reset proof, no automatic routing, minimal Pi-owned admission, and owned quota waits. Parent independently confirmed swallowed hook errors, shared ModelRuntime dispatch, the 30-minute background default and the auxiliary direct Agent path.

Refined: the reviewer's initial proposal to retain all attempt timers. It is honest for bounded waiting only; the full outcome requires opted-in active budgets across supported ancestry. Explicit hard deadlines remain unchanged.

Rejected: exact conversion from token counts into subscription percentages, extension-hook veto claims, forced fleet-wide abort, busy retries, every child polling separately, implicit paid fallback, Git-backed live state, and a new distributed agent scheduler.

Owner decisions before implementation: protected stale-data policy/override authority; active-budget/wait-expiry settings; same-account cross-host use; permitted routing/spending/privacy classes; authorized Claude integration. Repository/runtime mutation and publication approval remain separate.

Confidence is high in the observed local limitations and medium in the proposed complete design. Live telemetry, admission implementation and lifecycle semantics are untested. A supported native admission API, verified provider reservation capability, or reusable homelab integration could simplify the plan.

## Evidence and run references

Local source evidence inspected by advisors; key dispatch, hook, timeout and arbiter findings also inspected by the parent:

- `extensions/codex-runway/sources.ts:38-61`, `types.ts:6-14`, `index.ts:17-28,76-88,129-141`, `core.ts:36-50`.
- Installed Pi `dist/core/extensions/runner.js:961-1014`, `dist/core/model-runtime.js:422-499`, `dist/core/extensions/types.d.ts:534-553`.
- Pi `dist/core/sdk.js:176-247`, compaction `compaction.js:484-510`, `cache-warmer.js:238-259`, `agent-session.js:1608-1624,2445-2455`.
- pi-subagents `src/runs/shared/child-session.ts:182-239`, `child-launch.ts:272-300`, `llm-intent-arbiter.ts:175-216`, `model-fallback.ts:510-578`.
- pi-subagents `src/runs/background/async-execution.ts:155,1043`, `active-async-capacity.ts:15-59`, `subagent-runner.ts:1799-1840,3017-3058,3200-3204`; foreground `execution.ts:910-928,1172-1191,1239-1255,1953-1968`; shared `parallel-utils.ts:148-225`.

Public sources, read on 2026-10-07:

- https://support.claude.com/en/articles/8325606-what-is-the-pro-plan
- https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account
- https://raw.githubusercontent.com/steipete/CodexBar/main/docs/claude.md
- https://raw.githubusercontent.com/steipete/CodexBar/main/docs/codex-oauth.md

CodexBar sources are unpinned public upstream implementation evidence, not provider guarantees.

Council mission: `fd785cc5-ed4f-4bc0-a38b-926c76ea22a9`.
Pass 1 workflow: `8e3045f7-7145-4676-96ae-7cf55f26c0f5`; oracle `1313b91b-94e7-4063-aabe-4d21d7648ea1`; reviewer `a8b99e0b-a695-4d5c-ab66-09e94f594932`.
Pass 2 workflow: `f2e37d22-50b9-4159-9e2e-f66011b556d8`; oracle `3b8f837b-b3ee-4211-9bb2-87890a8a8503` failed; reviewer `73d98f92-f896-4cc3-9d5d-427b5bcc3427` completed.
Brief, public-evidence notes and claim matrix are scratch artifacts in `/tmp/pi-runway-council/`; the memo is the durable design artifact.
