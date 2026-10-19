import assert from "node:assert/strict";
import test from "node:test";
import { finishReceipt, formatCompactReceipt, formatDetailedReceipt, newReceiptDraft, parseEcbRate, quotaMovement, receiptTotal, recordAssistant, recordManagedResult } from "../receipt";
import type { WeeklyUsageSnapshot, Forecast } from "../types";

const snapshot = (remainingPct: number, at: string, reset = "2026-09-30T00:00:00Z"): WeeklyUsageSnapshot =>
  ({ remainingPct, fetchedAt: at, resetTimestamp: reset, source: "test" });
const health = (value: Forecast["health"]): Forecast => ({ health: value } as Forecast);

test("counts each assistant message once, with reasoning inside output and cached tokens separate", () => {
  const draft = newReceiptDraft(new Date("2026-09-23T08:00:00Z"));
  recordAssistant(draft, { role: "assistant", provider: "openai-codex", model: "gpt-6-sol", usage: {
    input: 325, cacheRead: 75648, cacheWrite: 0, output: 746, reasoning: 665,
    cost: { total: 0.0232396 },
  } });
  recordAssistant(draft, { role: "user", usage: { input: 100000 } });
  const receipt = finishReceipt(draft, undefined, health("ON BUDGET"), undefined, new Date("2026-09-23T08:01:00Z"));
  assert.equal(receipt.parent.output, 746);
  assert.equal(receipt.parent.reasoning, 665);
  assert.equal(receiptTotal(receipt).input, 325);
  assert.equal(receipt.parentModels[0]?.model, "openai-codex/gpt-6-sol");
  assert.match(formatDetailedReceipt(receipt).join("\n"), /746.*665 reasoning included/);
});

test("adds managed children once, and marks async runs pending until completion", () => {
  const draft = newReceiptDraft();
  recordManagedResult(draft, "subagent", { mode: "workflow", runId: "workflow-1", asyncId: "workflow-1", background: true, results: [] }, "call-1");
  assert.equal(draft.pendingRunIds.size, 1);
  const child = { index: 0, agent: "reviewer", model: "openai-codex/gpt-6-sol", usage: { input: 100, output: 20, cacheRead: 400, cacheWrite: 0, cost: 0.05 } };
  const details = { mode: "management", results: [], completions: [{ runId: "workflow-1", results: [child] }] };
  recordManagedResult(draft, "bg_wait", details, "call-2");
  recordManagedResult(draft, "bg_wait", details, "call-3");
  const receipt = finishReceipt(draft, undefined, null);
  assert.equal(receipt.children.length, 1);
  assert.equal(receipt.pendingRuns, 0);
  assert.equal(receiptTotal(receipt).costUsd, 0.05);
  const pending = newReceiptDraft();
  recordManagedResult(pending, "subagent", { mode: "workflow", asyncId: "later", background: true, results: [] }, "call-4");
  const pendingReceipt = finishReceipt(pending, undefined, null);
  assert.match(formatCompactReceipt(pendingReceipt), /1 child run\(s\) pending/);
  assert.match(formatDetailedReceipt(pendingReceipt).join("\n"), /their usage is not included yet/);
});

test("reports quota movement as rounded account-wide observation, never per-job spend", () => {
  const draft = newReceiptDraft();
  draft.quotaBefore = snapshot(81, "2026-09-23T08:00:00Z");
  const after = snapshot(80, "2026-09-23T08:04:00Z");
  const receipt = finishReceipt(draft, after, health("TAKE CARE"));
  receipt.healthBefore = "ON BUDGET";
  assert.match(quotaMovement(receipt), /81% → 80% left \(−1 pp observed, account-wide\)/);
  assert.match(formatCompactReceipt(receipt), /runway ON BUDGET → TAKE CARE/);
  assert.match(formatDetailedReceipt(receipt)[4]!, /not attributable to this task alone/);
  assert.match(quotaMovement({ ...receipt, quotaAfter: snapshot(81, after.fetchedAt) }), /unchanged at published resolution/);
  assert.match(quotaMovement({ ...receipt, quotaAfter: snapshot(100, after.fetchedAt, "2026-10-07T00:00:00Z") }), /weekly reset/);
  assert.match(quotaMovement({ ...receipt, quotaAfter: undefined }), /unavailable/);
});

test("uses dated ECB USD-per-EUR quote and labels API-equivalent cost, not a subscription charge", () => {
  const rate = parseEcbRate("<Cube time='2026-09-22'><Cube currency='USD' rate='1.25'/></Cube>");
  assert.deepEqual(rate, { date: "2026-09-22", usdPerEur: 1.25 });
  assert.equal(parseEcbRate("<Cube currency='USD' rate='0'/>"), null);
  const draft = newReceiptDraft();
  recordAssistant(draft, { role: "assistant", provider: "openai-codex", model: "gpt-6-sol", usage: { input: 1000, output: 100, cost: { total: 0.25 } } });
  const receipt = finishReceipt(draft, undefined, null, rate!);
  assert.match(formatCompactReceipt(receipt), /~€0\.20 API-equivalent \(ECB 2026-09-22\)/);
  assert.match(formatDetailedReceipt(receipt)[3]!, /not a subscription charge/);
  assert.match(formatCompactReceipt({ ...receipt, eurUsd: undefined }), /\$0\.25 API-equivalent \(EUR rate unavailable\)/);
});

test("does not render unpriced model usage as a zero-euro bill", () => {
  const draft = newReceiptDraft();
  recordAssistant(draft, { role: "assistant", model: "unpriced", usage: { input: 10, output: 5, cost: { total: 0 } } });
  const receipt = finishReceipt(draft, undefined, null, { date: "2026-09-22", usdPerEur: 1.25 });
  assert.match(formatCompactReceipt(receipt), /API-equivalent unavailable \(catalog has no price\)/);
});

test("provider-neutral token receipts and account changes do not imply quota attribution", () => {
  const draft = newReceiptDraft();
  recordAssistant(draft, { role: "assistant", provider: "anthropic", model: "claude-sonnet-fixture", usage: { input: 50, output: 10, cost: { total: 0.01 } } });
  const account = { provider: "openai-codex", accountId: "account-a" };
  draft.quotaBefore = { ...snapshot(82, "2026-09-23T08:00:00Z"), account };
  const receipt = finishReceipt(draft, { ...snapshot(81, "2026-09-23T08:04:00Z"), account: { ...account, accountId: "account-b" } }, null);
  assert.equal(receipt.parentModels[0]?.model, "anthropic/claude-sonnet-fixture");
  assert.equal(receiptTotal(receipt).input, 50);
  assert.match(quotaMovement(receipt), /account changed or unbound/);
  assert.match(quotaMovement({ ...receipt, quotaAfter: snapshot(81, "2026-09-23T08:04:00Z") }), /account changed or unbound/);
});
