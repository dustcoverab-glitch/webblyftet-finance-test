export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {})
      }
    });
  } catch {
    throw new Error("Kunde inte nå Finance API. Ladda om sidan och kontrollera att Cloudflare Access-inloggningen fortfarande är aktiv.");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error ?? data?.message ?? `HTTP ${response.status}`);
  return data as T;
}

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
