/** Dashboard access token lives only in sessionStorage: it dies with the tab and never enters the bundle. */
const KEY = "cargolens.dashboard.session";
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

export interface Session {
  token: string;
  issuedAt: number;
  apiUrl: string;
}

export function defaultApiUrl(
  env: Record<string, string | undefined> = import.meta.env as Record<
    string,
    string | undefined
  >,
): string {
  return (env.VITE_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
}

export function readSession(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): Session | null {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.token !== "string" ||
      !parsed.token ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.apiUrl !== "string"
    )
      throw new Error("shape");
    if (
      !Number.isFinite(parsed.issuedAt) ||
      parsed.issuedAt > now ||
      now - parsed.issuedAt >= MAX_AGE_MS
    )
      throw new Error("expired");
    return {
      token: parsed.token,
      issuedAt: parsed.issuedAt,
      apiUrl: parsed.apiUrl,
    };
  } catch {
    storage.removeItem(KEY);
    return null;
  }
}

export function writeSession(
  storage: Pick<Storage, "setItem">,
  session: Session,
): void {
  storage.setItem(KEY, JSON.stringify(session));
}
export function clearSession(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(KEY);
}
export const SESSION_MAX_AGE_MS = MAX_AGE_MS;
