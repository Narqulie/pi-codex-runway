import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ProviderRequestOptions } from "@earendil-works/pi-ai";
import type { AccountBinding } from "./quota";

const AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const PROVIDER = "openai-codex";
/** Stable current OAuth metadata only: no refresh, lock, token retention or telemetry-derived identity. */
export async function currentCodexAccount(authFile = AUTH_FILE): Promise<AccountBinding | undefined> {
  try {
    const credential = JSON.parse(await readFile(authFile, "utf8"))[PROVIDER];
    return credential?.type === "oauth" && typeof credential.accountId === "string" && credential.accountId.trim()
      ? { provider: PROVIDER, accountId: credential.accountId } : undefined;
  } catch { return undefined; }
}
/** Bind the prepared built-in Codex route, not JWT signatures or billing policy.
 * Pi AI 1.1.0 forces account/auth headers from apiKey in both SSE and WebSocket.
 * Custom endpoints, fetch implementations and virtual-host overrides are unproved. */
export function codexDispatchAccount(model: Model<Api>, options: ProviderRequestOptions): AccountBinding | undefined {
    if (model.provider !== PROVIDER || model.api !== "openai-codex-responses" || options.fetch !== undefined) return undefined;
    // Env changes proxy/control behavior, not account selection in this pinned implementation.
    // Endpoint auth overrides are already materialized in the exact prepared model.
    const raw = model.baseUrl?.trim() ? model.baseUrl : "https://chatgpt.com/backend-api";
    const normalized = raw.replace(/\/+$/, "");
    const endpoint = normalized.endsWith("/codex/responses") ? normalized : normalized.endsWith("/codex") ? `${normalized}/responses` : `${normalized}/codex/responses`;
    if (endpoint !== "https://chatgpt.com/backend-api/codex/responses" || typeof options.apiKey !== "string") return undefined;
    try {
      const headers = new Headers(model.headers);
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        if (value === null) headers.delete(name); else headers.set(name, value);
      }
      // The provider forces auth/account headers, but does not force Host. Do not attest a virtual-host override.
      if (headers.has("host")) return undefined;
      const parts = options.apiKey.split(".");
      if (parts.length !== 3) return undefined;
      // Match provider extraction rather than accepting an alternate JWT decoder's broader syntax.
      const accountId = JSON.parse(atob(parts[1]!))?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      return typeof accountId === "string" && accountId.trim() ? { provider: PROVIDER, accountId } : undefined;
    } catch { return undefined; }
}
