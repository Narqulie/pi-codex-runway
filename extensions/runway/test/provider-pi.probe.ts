import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { SubscriptionQuotaGuard, DEFAULT_PROTECTION_POLICY } from "../provider-guard";
import { QuotaCoordinatorStore } from "../coordination";
import { registerRunway } from "../index";
import { limits, observation, START } from "./coordination-fixture";
import { codexAccount, codexModel, token, fakeProvider, done } from "./provider-fixture";
import { parseClaudeUsage } from "../sources";
const claudeModel = { ...codexModel, provider: "anthropic", api: "anthropic-messages" as const, id: "claude-sonnet-fixture", baseUrl: "https://api.anthropic.com" };
const claudeAccess = ["sk", "ant", "oat", "fixture"].join("-");
const claudeAccount = { provider: "anthropic", accountId: JSON.stringify(["fixture-account", "fixture-org"]) };

// Mandatory when invoked: a stock installed SDK, synthetic credential/provider only. Never real inference.
const sdkPath = process.env.RUNWAY_PI_SDK_MODULE;
if (!sdkPath) throw new Error("Set RUNWAY_PI_SDK_MODULE to the installed Pi dist/index.js, then run npm run test:pi. This probe does not skip.");
const fetchBeforeProbe = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network is disabled in stock-runtime probes."); };
after(() => { globalThis.fetch = fetchBeforeProbe; });
const sdk = await import(pathToFileURL(sdkPath).href);
async function credentialStore() { const store = new InMemoryCredentialStore(); await store.modify("openai-codex", async () => ({ type: "api_key", key: token() })); return store; }

test("stock Pi ModelRuntime honors supported Provider guard for full/simple/purpose calls, preserves auth and rejects bypasses", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-stock-pi-")); let now = START, reading = observation(99, now, codexAccount), calls = 0;
  const guard = new SubscriptionQuotaGuard({ path: join(dir, "quota.sqlite"), now: () => now, source: () => ({ name: "fixture", async getObservation() { return reading; } }) });
  guard.start(); guard.enroll(codexAccount); t.after(() => { guard.close(); rmSync(dir, { recursive: true, force: true }); });
  const seen: any[] = [], original = fakeProvider((_m, _c, options) => { calls++; seen.push(options); return done(); });
  const guarded = guard.protect(original), credentials = await credentialStore();
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  assert.equal(runtime.getRequestAdmissionState, undefined); // No private/native admission patch.
  runtime.registerNativeProvider(guarded); await runtime.refresh({ allowNetwork: false, providers: ["openai-codex"] });
  assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), guarded);
  assert.deepEqual(runtime.getModel("openai-codex", codexModel.id), codexModel);
  for (const purpose of ["chat", "compaction", "cache-warm"]) {
    const held = await runtime.completeSimple(codexModel, { messages: [] }, { purpose });
    assert.match(held.errorMessage, /99% stop threshold/); assert.equal(calls, 0);
  }
  const held = await runtime.complete(codexModel, { messages: [] }, { reasoningEffort: "high" }); assert.equal(held.stopReason, "error"); assert.equal(calls, 0);
  now += 120001; reading = observation(10, now, codexAccount);
  assert.equal((await runtime.complete(codexModel, { messages: [] }, { reasoningEffort: "high" })).stopReason, "stop");
  assert.equal(seen[0].apiKey, token()); assert.equal(seen[0].reasoningEffort, "high");
  assert.equal((await runtime.completeSimple(codexModel, { messages: [] }, { reasoning: "high" })).stopReason, "stop"); assert.equal(calls, 2);
  assert.equal(seen[1].reasoning, "high");
  for (const override of [{ apiKey: "unproved" }, { fetch: () => { throw new Error("must never call"); } }, { headers: { Host: "unproved.test" } }]) {
    assert.equal((await runtime.complete(codexModel, { messages: [] }, override)).stopReason, "error"); assert.equal(calls, 2);
  }
  // Control/auth preparation is never intercepted or blocked at an exhausted window.
  now += 120001; reading = observation(99, now, codexAccount);
  const auth = await runtime.prepareRequest(codexModel, { purpose: "chat" }); assert.equal(auth.options.apiKey, token());
  await runtime.completeSimple(codexModel, { messages: [] }); assert.equal(calls, 2);
  await credentials.modify("openai-codex", async () => ({ type: "api_key", key: token("independent") }));
  assert.equal((await runtime.completeSimple(codexModel, { messages: [] })).stopReason, "stop"); assert.equal(calls, 3);
  // A separate runtime using the exact registered provider follows the same guard, as inherited foreground providers do.
  const child = await sdk.ModelRuntime.create({ credentials: await credentialStore(), modelsPath: null, refreshOnCreate: false });
  child.registerNativeProvider(runtime.getRegisteredNativeProvider("openai-codex"));
  assert.equal((await child.completeSimple(codexModel, { messages: [] })).stopReason, "error"); assert.equal(calls, 3);
  guard.close(); assert.equal((await child.completeSimple(codexModel, { messages: [] })).stopReason, "error"); assert.equal(calls, 3);
});

test("stock AgentSession loads the extension without native ABI, holds normal turns, and closes on reload", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-session-pi-")), path = join(dir, "quota.sqlite"); let calls = 0;
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("No network permitted in the stock-runtime proof."); };
  t.after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
  const credentials = await credentialStore(), runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const original = fakeProvider(() => { calls++; return done(); }); runtime.registerNativeProvider(original);
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(api: any) => registerRunway(api, [], { coordinationPath: path, statePath: join(dir, "state.json"), legacyStatePath: join(dir, "missing.json"), currentAccount: async () => codexAccount, codexProvider: original })] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: codexModel, tools: [], settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(dir), enableCacheWarming: false });
  const errors: unknown[] = []; await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  const registered = runtime.getRegisteredNativeProvider("openai-codex"); assert.notEqual(registered, original);
  const store = new QuotaCoordinatorStore(path, limits); t.after(() => store.close());
  assert.equal(store.accounts().length, 0);
  const command = session.extensionRunner.getCommand("runway"), ctx = session.extensionRunner.createCommandContext();
  await command.handler("blocking on", ctx);
  assert.equal(store.snapshot(codexAccount).policy.protected, true); // Real ModelRegistry facade, not a mock prepareRequest method.
  store.publish(store.acquirePoll(codexAccount)!, observation(99, Date.now(), codexAccount));
  await session.prompt("Synthetic quota-guard probe; no tools or network.");
  assert.equal(calls, 0); assert.equal(session.messages.at(-1).stopReason, "error"); assert.match(session.messages.at(-1).errorMessage, /99% stop threshold/);
  assert.deepEqual(errors, []);
  // Reload disposes the old guard. A captured/inherited old provider must hold, not fall through.
  await session.reload();
  assert.notEqual(runtime.getRegisteredNativeProvider("openai-codex"), registered);
  assert.equal((await registered.streamSimple(codexModel, { messages: [] }, { apiKey: token() }).result()).stopReason, "error");
  assert.equal(calls, 0); assert.deepEqual(errors, []);
});

test("the actual on-disk package loads through stock Pi without local patches or quota enrollment", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-package-pi-")), previousHome = process.env.HOME, previousFetch = globalThis.fetch;
  process.env.HOME = dir; globalThis.fetch = async () => { throw new Error("No network permitted in package-load proof."); };
  t.after(() => { process.env.HOME = previousHome; globalThis.fetch = previousFetch; rmSync(dir, { recursive: true, force: true }); });
  const runtime = await sdk.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const before = runtime.getAllModels("openai-codex");
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: { mode: "off" } });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [process.cwd()] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: before[0], tools: [], settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(dir), enableCacheWarming: false });
  const errors: unknown[] = []; await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  assert.deepEqual(errors, []); assert.equal(runtime.getRegisteredNativeProvider("openai-codex").id, "openai-codex");
  assert.deepEqual(runtime.getAllModels("openai-codex"), before);
  const store = new QuotaCoordinatorStore(join(dir, ".pi", "agent", "runway-provider-quota.sqlite"), limits);
  assert.deepEqual(store.accounts(), []); store.close();
});

test("two extension scopes sharing a registry reuse one guard; either scope can close without disabling the other", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-scopes-pi-")), path = join(dir, "quota.sqlite"); let calls = 0;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = await sdk.ModelRuntime.create({ credentials: await credentialStore(), modelsPath: null, refreshOnCreate: false });
  const original = fakeProvider(() => { calls++; return done(); }); runtime.registerNativeProvider(original);
  async function scope() {
    const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { mode: "off" } });
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(api: any) => registerRunway(api, [], { coordinationPath: path, statePath: join(dir, "state.json"), legacyStatePath: join(dir, "missing.json"), currentAccount: async () => codexAccount })] });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: codexModel, tools: [], settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(dir), enableCacheWarming: false });
    await session.bindExtensions({ onError: (error: unknown) => { throw error; } }); return session;
  }
  const first = await scope(), registered = runtime.getRegisteredNativeProvider("openai-codex"), second = await scope();
  assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), registered); // No nested guard or second permit.
  const store = new QuotaCoordinatorStore(path, limits); store.enroll(codexAccount, { ...DEFAULT_PROTECTION_POLICY, concurrency: 1 });
  store.publish(store.acquirePoll(codexAccount)!, observation(10, Date.now(), codexAccount));
  await first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); first.dispose();
  await second.prompt("Synthetic shared-provider probe."); assert.equal(calls, 1); assert.equal(second.messages.at(-1).stopReason, "stop");
  await second.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); second.dispose();
  assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), original); store.close();
  assert.equal((await registered.streamSimple(codexModel, { messages: [] }, { apiKey: token() }).result()).stopReason, "error"); assert.equal(calls, 1);
});

test("published managed foreground factory inherits the guarded provider and holds without a child extension or inference", async t => {
  const factoryPath = process.env.RUNWAY_SUBAGENTS_FACTORY_MODULE;
  if (!factoryPath) throw new Error("Set RUNWAY_SUBAGENTS_FACTORY_MODULE to installed pi-subagents/src/runs/shared/child-session.js. The managed coverage probe does not skip.");
  const dir = mkdtempSync(join(tmpdir(), "runway-managed-pi-")); let calls = 0;
  const factoryKey = Symbol.for("pi-runway.stock-managed-proof");
  // Use the host's real extension loader and peer aliases, exactly as the foreground managed extension does.
  const bridge = join(dir, "managed-factory.ts");
  writeFileSync(bridge, `import { createDefaultChildSessionFactory } from ${JSON.stringify(factoryPath)}; export default function () { globalThis[Symbol.for("pi-runway.stock-managed-proof")] = createDefaultChildSessionFactory; }`);
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [bridge] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const createDefaultChildSessionFactory = (globalThis as any)[factoryKey];
  t.after(() => { delete (globalThis as any)[factoryKey]; rmSync(dir, { recursive: true, force: true }); });
  for (const model of [codexModel, claudeModel]) {
    const isClaude = model.provider === "anthropic", account = isClaude ? claudeAccount : codexAccount;
    async function credentialsForChild() {
      const credentials = await credentialStore();
      if (isClaude) await credentials.modify("anthropic", async () => ({ type: "api_key", key: claudeAccess }));
      return credentials;
    }
    const guard = new SubscriptionQuotaGuard({ provider: isClaude ? "anthropic" : "openai-codex", claudeTelemetry: true,
      path: join(dir, `${model.provider}.sqlite`), claudeCredentials: async accessToken => ({ accessToken, account, verified: true, scopes: ["user:profile"] }),
      source: () => ({ name: "fixture", async getObservation() { return observation(99, Date.now(), account); } }) });
    guard.start(); guard.enroll(account);
    const parent = await sdk.ModelRuntime.create({ credentials: await credentialsForChild(), modelsPath: null, refreshOnCreate: false });
    const original = { ...fakeProvider(() => { calls++; return done(); }), id: model.provider, getModels: () => [model] };
    parent.registerNativeProvider(guard.protect(original));
    const errors: unknown[] = [];
    const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk, ModelRuntime: { create: async () => sdk.ModelRuntime.create({ credentials: await credentialsForChild(), modelsPath: null, refreshOnCreate: false }) } }) });
    t.after(async () => { await factory.dispose(); guard.close(); });
    const child = await factory.create({ cwd: dir, parentProviderRegistry: parent, storage: { kind: "memory" }, model: `${model.provider}/${model.id}`, tools: [], excludeTools: [],
      extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: {}, onExtensionError: (error: unknown) => errors.push(error) });
    await child.prompt("Synthetic managed quota probe; no tools or network.");
    assert.equal(calls, 0); assert.equal(child.messages.at(-1).stopReason, "error"); assert.match(child.messages.at(-1).errorMessage, /99% stop threshold/);
    await child.dispose(); assert.equal(guard.phase, "ready"); assert.deepEqual(errors, []); // Inherited-only child does not own its parent's guard.
  }
});

test("Claude public enrollment holds five-hour quota and restores the existing legacy transport on last-owner shutdown", async t => {
  const dir = mkdtempSync(join(tmpdir(), "runway-claude-stock-")), path = join(dir, "quota.sqlite");
  let calls = 0, profiles = 0;
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({ type: "api_key", key: claudeAccess }));
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const base = { ...fakeProvider(() => done()), id: "anthropic", getModels: () => [claudeModel] };
  runtime.registerNativeProvider(base);
  const legacy = { api: "anthropic-messages", streamSimple: (_model: any, _context: any, options: any) => { calls++; assert.equal(options.apiKey, claudeAccess); return done(); } };
  runtime.registerProvider("anthropic", legacy);
  const original = runtime.getRegisteredProviderConfig("anthropic"), priorNative = runtime.getRegisteredNativeProvider("anthropic");
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } });
  async function scope() {
    const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(api: any) => registerRunway(api, [], { coordinationPath: path, statePath: join(dir, "state.json"), legacyStatePath: join(dir, "absent.json"), claudeTelemetry: true,
        claudeCredentials: async accessToken => { profiles++; return { accessToken, account: claudeAccount, verified: true, scopes: ["user:profile"] }; } })] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await sdk.createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: claudeModel, tools: [], settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(dir), enableCacheWarming: false });
    await session.bindExtensions({ onError: (error: unknown) => { throw error; } });
    return session;
  }
  const first = await scope(), guarded = runtime.getRegisteredNativeProvider("anthropic"), second = await scope();
  assert.equal(runtime.getRegisteredNativeProvider("anthropic"), guarded);
  const store = new QuotaCoordinatorStore(path, limits);
  const open = new Set([first, second]);
  async function close(session: any) { if (!open.delete(session)) return; await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  t.after(async () => { for (const session of open) await close(session); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.accounts().length, 0);
  const command = second.extensionRunner.getCommand("runway"), ctx = second.extensionRunner.createCommandContext();
  await command.handler("blocking on", ctx); assert.equal(store.snapshot(claudeAccount)?.policy.protected, true);
  const reset = new Date(Date.now() + 604800000).toISOString();
  store.publish(store.acquirePoll(claudeAccount)!, parseClaudeUsage({ five_hour: { utilization: 99, resets_at: reset }, seven_day: { utilization: 30, resets_at: reset } }, claudeAccount));
  await close(first);
  await second.prompt("Synthetic Claude guard probe; no network or inference.");
  assert.equal(calls, 0); assert.match(second.messages.at(-1).errorMessage, /99% stop threshold/);
  await command.handler("blocking off", ctx);
  assert.equal((await runtime.completeSimple(claudeModel, { messages: [] })).stopReason, "stop"); assert.equal(calls, 1); assert.equal(profiles, 1);
  await close(second);
  assert.equal(runtime.getRegisteredNativeProvider("anthropic"), priorNative);
  assert.deepEqual(runtime.getRegisteredProviderConfig("anthropic"), original);
  assert.equal((await guarded.streamSimple(claudeModel, { messages: [] }, { apiKey: claudeAccess }).result()).stopReason, "error"); assert.equal(calls, 1);
});

test("built-in Codex catalog/auth are unchanged by provider decoration", () => {
  const base = openaiCodexProvider(), guard = new SubscriptionQuotaGuard({ path: "unused; no start" });
  const protectedProvider = guard.protect(base);
  assert.equal(protectedProvider.auth, base.auth); assert.equal(protectedProvider.getModels, base.getModels); assert.equal(protectedProvider.getModelsError, base.getModelsError);
  guard.close();
});
