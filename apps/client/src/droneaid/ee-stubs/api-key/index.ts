// Core expects: the IApiKey type and getApiKeys(params) for a settings prefetch; no API keys exist here.
export type IApiKey = Record<string, unknown>;

export async function getApiKeys(_params: Record<string, unknown>): Promise<null> {
  return null;
}
