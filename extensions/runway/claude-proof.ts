import type { Api, Model, ProviderRequestOptions } from "@earendil-works/pi-ai";

/** Attest only the existing official OAuth route. Never shape identity or billing. */
export function claudeDispatchCredential(model: Model<Api>, options: ProviderRequestOptions): string | undefined {
  if (model.provider !== "anthropic" || model.api !== "anthropic-messages" || options.fetch !== undefined
    || typeof options.apiKey !== "string" || !options.apiKey.startsWith("sk-ant-oat")) return undefined;
  if ((model.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "") !== "https://api.anthropic.com") return undefined;
  try {
    const headers = new Headers(model.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    // The SDK merges caller headers after defaults. A different auth or host
    // would make a profile verified with apiKey irrelevant to this request.
    for (const name of ["host", "x-api-key", "x-organization-id", "anthropic-project-id"]) {
      if (headers.has(name)) return undefined;
    }
    if (headers.has("authorization") && headers.get("authorization") !== `Bearer ${options.apiKey}`) return undefined;
    return options.apiKey;
  } catch { return undefined; }
}
export function claudeModelFamily(model: Model<Api>): string | undefined {
  return /(?:^|[-_])(sonnet|opus|haiku)(?:[-_]|$)/i.exec(model.id)?.[1]?.toLowerCase();
}
