import { isQuotaReset } from "./core";
import { accountKey } from "./quota";
import type { WeeklyUsageSnapshot, Forecast, RunwayHealth } from "./types";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
  turns: number;
}
export interface ChildUsage { id: string; agent: string; model?: string; usage: TokenUsage }
export interface EurUsdRate { date: string; usdPerEur: number }
export interface TaskReceipt {
  startedAt: string;
  finishedAt: string;
  parent: TokenUsage;
  parentModels: Array<{ model: string; usage: TokenUsage }>;
  children: ChildUsage[];
  pendingRuns: number;
  quotaBefore?: WeeklyUsageSnapshot;
  quotaAfter?: WeeklyUsageSnapshot;
  healthBefore?: RunwayHealth;
  healthAfter?: RunwayHealth;
  eurUsd?: EurUsdRate;
}
export interface ReceiptDraft {
  startedAt: string;
  parent: TokenUsage;
  parentModels: Map<string, TokenUsage>;
  children: Map<string, ChildUsage>;
  pendingRunIds: Set<string>;
  quotaBefore?: WeeklyUsageSnapshot;
  healthBefore?: RunwayHealth;
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, turns: 0 });
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function usageOf(value: any, turn = false): TokenUsage {
  return {
    input: number(value?.input), output: number(value?.output), cacheRead: number(value?.cacheRead),
    cacheWrite: number(value?.cacheWrite), reasoning: number(value?.reasoning),
    costUsd: number(typeof value?.cost === "number" ? value.cost : value?.cost?.total), turns: turn ? 1 : number(value?.turns),
  };
}
function addUsage(target: TokenUsage, usage: TokenUsage) {
  target.input += usage.input; target.output += usage.output; target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite; target.reasoning += usage.reasoning;
  target.costUsd += usage.costUsd; target.turns += usage.turns;
}
export function newReceiptDraft(now = new Date()): ReceiptDraft {
  return { startedAt: now.toISOString(), parent: emptyUsage(), parentModels: new Map(), children: new Map(), pendingRunIds: new Set() };
}
export function recordAssistant(draft: ReceiptDraft, message: any) {
  if (message?.role !== "assistant" || !message.usage) return;
  const usage = usageOf(message.usage, true);
  addUsage(draft.parent, usage);
  const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
  const current = draft.parentModels.get(model) ?? emptyUsage();
  addUsage(current, usage); draft.parentModels.set(model, current);
}
export function recordManagedResult(draft: ReceiptDraft, toolName: string, details: any, toolCallId: string) {
  if (toolName !== "subagent" && toolName !== "bg_wait") return;
  if (!details || typeof details !== "object" || !Array.isArray(details.results)) return;
  const runs = [{ id: details.runId ?? toolCallId, results: details.results },
    ...(Array.isArray(details.completions) ? details.completions.map((completion: any) => ({ id: completion.runId, results: completion.results ?? [] })) : [])];
  if (details.background && details.asyncId && details.results.length === 0) draft.pendingRunIds.add(details.asyncId);
  for (const run of runs) {
    if (!Array.isArray(run.results)) continue;
    if (run.id && run.results.length) draft.pendingRunIds.delete(run.id);
    for (const result of run.results) {
      if (!result || typeof result !== "object" || !result.usage) continue;
      const id = String(result.runId ?? result.sessionFile ?? `${run.id}:${result.workflowKey ?? result.index ?? 0}`);
      if (draft.children.has(id)) continue;
      draft.children.set(id, {
        id, agent: typeof result.agent === "string" ? result.agent : "unknown",
        model: typeof result.model === "string" ? result.model : undefined,
        usage: usageOf(result.usage),
      });
    }
  }
}
export function finishReceipt(draft: ReceiptDraft, quotaAfter: WeeklyUsageSnapshot | undefined, after: Forecast | null, eurUsd?: EurUsdRate, now = new Date()): TaskReceipt {
  return {
    startedAt: draft.startedAt, finishedAt: now.toISOString(), parent: draft.parent,
    parentModels: [...draft.parentModels].map(([model, usage]) => ({ model, usage })),
    children: [...draft.children.values()], pendingRuns: draft.pendingRunIds.size,
    quotaBefore: draft.quotaBefore, quotaAfter, healthBefore: draft.healthBefore, healthAfter: after?.health, eurUsd,
  };
}
export function receiptTotal(receipt: TaskReceipt): TokenUsage {
  const total = emptyUsage(); addUsage(total, receipt.parent);
  for (const child of receipt.children) addUsage(total, child.usage);
  return total;
}
export function quotaMovement(receipt: TaskReceipt): string {
  const before = receipt.quotaBefore, after = receipt.quotaAfter;
  if (!before || !after) return "unavailable (quota reading missing)";
  if (before.account || after.account) {
    if (!before.account || !after.account || accountKey(before.account) !== accountKey(after.account)) return "unavailable (quota account changed or unbound)";
  }
  if (isQuotaReset(before, after) || new Date(after.fetchedAt) < new Date(before.fetchedAt)) return "unavailable (weekly reset or invalid reading)";
  const movement = before.remainingPct - after.remainingPct;
  if (movement === 0) return `${before.remainingPct}% → ${after.remainingPct}% left (unchanged at published resolution)`;
  return `${before.remainingPct}% → ${after.remainingPct}% left (${movement > 0 ? `−${movement}` : `+${-movement}`} pp observed, account-wide)`;
}
export function parseEcbRate(xml: string): EurUsdRate | null {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const rate = /<Cube\s+currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml)?.[1];
  const usdPerEur = Number(rate);
  return date && Number.isFinite(usdPerEur) && usdPerEur > 0 ? { date, usdPerEur } : null;
}
export async function fetchEcbRate(fetchFn: typeof fetch = fetch): Promise<EurUsdRate | null> {
  const response = await fetchFn("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml", { signal: AbortSignal.timeout(2500) });
  if (!response.ok) return null;
  return parseEcbRate((await response.text()).slice(0, 200_000));
}
const tokens = (value: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const amount = (value: number) => value.toFixed(value < 0.001 ? 6 : value < 0.01 ? 4 : 2);
const dollars = (value: number) => `$${amount(value)}`;
function cost(receipt: TaskReceipt): string {
  const usage = receiptTotal(receipt);
  if (usage.costUsd === 0 && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) return "API-equivalent unavailable (catalog has no price)";
  return receipt.eurUsd ? `~€${amount(usage.costUsd / receipt.eurUsd.usdPerEur)} API-equivalent (ECB ${receipt.eurUsd.date})`
    : `${dollars(usage.costUsd)} API-equivalent (EUR rate unavailable)`;
}
export function formatCompactReceipt(receipt: TaskReceipt): string {
  const usage = receiptTotal(receipt);
  const duration = Math.max(0, Math.round((Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt)) / 1000));
  const runway = receipt.healthBefore && receipt.healthAfter ? `${receipt.healthBefore} → ${receipt.healthAfter}` : "unavailable";
  return `Task · ${duration}s · ↑${tokens(usage.input)} (+${tokens(usage.cacheRead)} cached) ↓${tokens(usage.output)} · ${cost(receipt)}\nQuota: ${quotaMovement(receipt)} · runway ${runway}${receipt.pendingRuns ? ` · ${receipt.pendingRuns} child run(s) pending` : ""}`;
}
export function formatDetailedReceipt(receipt: TaskReceipt): string[] {
  const total = receiptTotal(receipt);
  const breakdown = (usage: TokenUsage) => `↑${tokens(usage.input)} · cache read ${tokens(usage.cacheRead)} / write ${tokens(usage.cacheWrite)} · ↓${tokens(usage.output)}${usage.reasoning ? ` (${tokens(usage.reasoning)} reasoning included)` : ""} · ${dollars(usage.costUsd)}`;
  const lines = ["RUNWAY · LAST TASK", `${receipt.startedAt} → ${receipt.finishedAt}`, `Total: ${breakdown(total)}`, `Cost: ${cost(receipt)}; not a subscription charge`,
    `Quota: ${quotaMovement(receipt)}; not attributable to this task alone`,
    `Quota readings: ${receipt.quotaBefore?.fetchedAt ?? "unavailable"} → ${receipt.quotaAfter?.fetchedAt ?? "unavailable"}`,
    `Runway: ${receipt.healthBefore ?? "unavailable"} → ${receipt.healthAfter ?? "unavailable"}`,
    `Parent: ${breakdown(receipt.parent)}`];
  for (const model of receipt.parentModels) lines.push(`  ${model.model}: ${breakdown(model.usage)}`);
  for (const child of receipt.children) lines.push(`Child ${child.agent}${child.model ? ` (${child.model})` : ""}: ${breakdown(child.usage)}`);
  if (receipt.pendingRuns) lines.push(`${receipt.pendingRuns} managed run(s) pending; their usage is not included yet. Use /subagent-cost after completion.`);
  if (total.cacheRead > total.input * 2) lines.push("Signal: repeated context was largely served from cache (not a per-tool cost attribution).");
  if (receipt.children.length) lines.push("Child usage is counted once; child reasoning detail is not available in the managed result.");
  return lines;
}
