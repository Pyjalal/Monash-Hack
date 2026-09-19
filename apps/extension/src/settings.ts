export const DEFAULT_API_URL = "http://127.0.0.1:3001";

export interface ExtensionSettings {
  enabled: boolean;
  apiUrl: string;
}

export function isLoopbackApiUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && (url.pathname === "/" || url.pathname === "");
  } catch {
    return false;
  }
}

export function normalizeApiUrl(value: unknown): string {
  if (!isLoopbackApiUrl(value)) return DEFAULT_API_URL;
  return new URL(value.trim()).origin;
}

export function classifyEndpoint(apiUrl: string): string {
  return `${normalizeApiUrl(apiUrl)}/classify`;
}

export function healthEndpoint(apiUrl: string): string {
  return `${normalizeApiUrl(apiUrl)}/health`;
}

export function parseSettings(value: unknown): ExtensionSettings {
  const settings = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: settings.enabled !== false,
    apiUrl: normalizeApiUrl(settings.apiUrl),
  };
}
