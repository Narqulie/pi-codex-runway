import assert from "node:assert/strict";
import test from "node:test";
import { WhamUsageSource } from "../sources";

test("rejects a short primary window rather than calling a session limit weekly", async () => {
  const fetchFn = async () => new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: 6, reset_after_seconds: 3600, limit_window_seconds: 18_000 }, secondary_window: null },
  }), { status: 200 });
  const path = `/tmp/codex-runway-source-test-${process.pid}.json`;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({ "openai-codex": { access: "test" } })));
  await assert.rejects(new WhamUsageSource(path, fetchFn as typeof fetch).getUsage(), /weekly-length quota window/);
});

test("uses a seven-day primary WHAM window when secondary is absent", async () => {
  const fetchFn = async () => new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: 6, reset_after_seconds: 592_000, limit_window_seconds: 604_800 }, secondary_window: null },
  }), { status: 200 });
  const path = `/tmp/codex-runway-source-test-${process.pid}-primary.json`;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({ "openai-codex": { access: "test" } })));
  const snapshot = await new WhamUsageSource(path, fetchFn as typeof fetch).getUsage();
  assert.equal(snapshot?.remainingPct, 94);
  assert.equal(snapshot?.source, "codex-wham-primary-weekly");
});

test("converts a published weekly WHAM window into an exact reset snapshot", async () => {
  const fetchFn = async () => new Response(JSON.stringify({
    rate_limit: { secondary_window: { used_percent: 18, reset_after_seconds: 7200 } },
  }), { status: 200 });
  const path = `/tmp/codex-runway-source-test-${process.pid}-ok.json`;
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({ "openai-codex": { access: "test" } })));
  const before = Date.now();
  const snapshot = await new WhamUsageSource(path, fetchFn as typeof fetch).getUsage();
  assert.equal(snapshot?.remainingPct, 82);
  assert.ok(new Date(snapshot!.resetTimestamp).getTime() >= before + 7_199_000);
});
