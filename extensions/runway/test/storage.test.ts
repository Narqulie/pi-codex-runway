import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyState, forecastFor, readState, validateState, writeState } from "../storage";
import type { RunwayState } from "../storage";
import { applySnapshot, emptyStore } from "../core";
import { accountKey } from "../quota";
const legacy = { ...applySnapshot(emptyStore(), { remainingPct: 82, fetchedAt: "2026-10-07T08:00:00Z", resetTimestamp: "2026-10-14T08:00:00Z", source: "fixture" }).store, config: { reservePct: 15 } };
async function fixture(run: (path: string, old: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "runway-storage-"));
  try { await run(join(dir, "runway.json"), join(dir, "codex-runway.json")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test("validated one-time migration preserves original, config and account-less forecast separately", async () => fixture(async (path, old) => {
  const original = JSON.stringify(legacy);
  await writeFile(old, original);
  const state = await readState(path, old);
  assert.equal(state.legacyImport, "imported");
  assert.deepEqual(state.legacyForecast, legacy);
  assert.deepEqual(state.config, { reservePct: 15 });
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.forecasts, {});
  assert.equal(await readFile(old, "utf8"), original);
  const key = accountKey({ provider: "openai-codex", accountId: "new-account" });
  assert.equal(forecastFor(state, key).lastSnapshot, undefined);
  assert.equal(forecastFor(state, key).config?.reservePct, 15);
  assert.equal(forecastFor(state).lastSnapshot?.remainingPct, 82);
  await writeFile(old, "invalid after import");
  assert.deepEqual(await readState(path, old), state); // No reimport or original deletion.
}));
test("v1/v2 weekly snapshots survive migration without inventing bound accounts", async () => fixture(async (path, old) => {
  const v1 = { ...legacy, version: 1, snapshots: undefined, forecastHistory: undefined };
  await writeFile(old, JSON.stringify(v1));
  const state = await readState(path, old);
  assert.equal(state.legacyForecast?.version, 3);
  assert.deepEqual(state.legacyForecast?.snapshots, [legacy.lastSnapshot]);
  assert.equal(state.legacyForecast?.lastSnapshot?.account, undefined);
}));
test("invalid legacy records/config and failed publication preserve original and do not claim import", async () => {
  for (const raw of ["invalid json", JSON.stringify({ ...legacy, version: 88 }), JSON.stringify({ ...legacy, config: { reservePct: -1 } }), JSON.stringify({ ...legacy, snapshots: [{ remainingPct: 0 }] })]) await fixture(async (path, old) => {
    await writeFile(old, raw);
    await assert.rejects(readState(path, old));
    assert.equal(await readFile(old, "utf8"), raw);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  });
  await fixture(async (path, old) => {
    await writeFile(old, JSON.stringify(legacy));
    const blockingFile = `${path}.blocked`;
    await writeFile(blockingFile, "not a directory");
    await assert.rejects(readState(join(blockingFile, "runway.json"), old));
    assert.deepEqual(JSON.parse(await readFile(old, "utf8")), legacy);
  });
});
test("invalid neutral file is never replaced or bypassed with another migration", async () => fixture(async (path, old) => {
  await writeFile(path, "corrupt neutral state");
  await writeFile(old, JSON.stringify(legacy));
  await assert.rejects(readState(path, old));
  assert.equal(await readFile(path, "utf8"), "corrupt neutral state");
}));
test("concurrent import publishes once; absent legacy is recorded once", async () => fixture(async (path, old) => {
  const [a, b] = await Promise.all([readState(path, old), readState(path, old)]);
  assert.deepEqual(a, b);
  assert.equal(a.legacyImport, "absent");
  await writeFile(old, JSON.stringify(legacy));
  assert.deepEqual(await readState(path, old), a);
}));
test("neutral v1 Codex histories migrate unchanged to provider-neutral v2", async () => fixture(async (path, old) => {
  const account = { provider: "openai-codex", accountId: "existing-account" }, key = accountKey(account);
  const forecast = applySnapshot(emptyStore(), { ...legacy.lastSnapshot!, account }).store;
  const original = JSON.stringify({ version: 1, legacyImport: "absent", accounts: [], codexForecasts: { [key]: forecast } });
  await writeFile(path, original);
  const state = await readState(path, old);
  assert.equal(state.version, 2);
  assert.deepEqual(state.forecasts[key], forecast);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal("codexForecasts" in state, false);
  const claude = { provider: "anthropic", accountId: "claude-account" };
  state.forecasts[accountKey(claude)] = applySnapshot(emptyStore(), { ...legacy.lastSnapshot!, account: claude }).store;
  await writeState(state, path);
  assert.deepEqual((await readState(path, old)).forecasts, state.forecasts);
}));
test("bound forecasting cannot contain unbound or another account's samples", async () => fixture(async (path) => {
  const account = { provider: "openai-codex", accountId: "account-a" }, key = accountKey(account);
  const state: RunwayState = { ...emptyState(), forecasts: { [key]: legacy } };
  assert.throws(() => validateState(state), /Unbound or foreign/);
  state.forecasts[key] = applySnapshot(emptyStore(), { ...legacy.lastSnapshot!, account }).store;
  await writeState(state, path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).forecasts[key].lastSnapshot.account.accountId, "account-a");
  const original = await readFile(path, "utf8");
  state.forecasts[key].lastSnapshot!.account = { ...account, accountId: "account-b" };
  await assert.rejects(writeState(state, path), /Unbound or foreign/);
  assert.equal(await readFile(path, "utf8"), original);
}));
