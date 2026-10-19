import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
export const codexAccount = { provider: "openai-codex", accountId: "fixture-account" };
export const token = (id = codexAccount.accountId) => `e30.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } }))}.fake`;
export const codexModel: Model<"openai-codex-responses"> = { provider: "openai-codex", api: "openai-codex-responses", id: "fixture-model", name: "Fixture", baseUrl: "https://chatgpt.com/backend-api",
  reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
export const message = (model = codexModel): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: "fixture" }], provider: model.provider, api: model.api, model: model.id,
  timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
export const done = () => { const stream = createAssistantMessageEventStream(), m = message(); stream.push({ type: "done", reason: "stop", message: m }); stream.end(m); return stream; };
export const fakeProvider = (stream: Provider["stream"] = done, streamSimple: Provider["streamSimple"] = stream): Provider => ({ id: "openai-codex", name: "Fixture",
  getModels: () => [codexModel], auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async ({ credential }: any) => ({ auth: { apiKey: credential.key } }) } }, stream, streamSimple });
