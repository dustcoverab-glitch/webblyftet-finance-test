import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { id } from "./db";
import { PublicAppError } from "./fortnox";

export function errorJson(c: Context<{ Bindings: Env }>, error: unknown): Response {
  if (error instanceof PublicAppError) {
    return c.json({ error: error.publicMessage, request_id: error.requestId }, error.status as any);
  }

  const requestId = id("err");
  if (error instanceof HTTPException) {
    return c.json({ error: "Begäran kunde inte hanteras.", request_id: requestId }, error.status as any);
  }

  console.error("Unhandled request error", { requestId, message: error instanceof Error ? error.message : String(error) });
  return c.json({ error: "Ett internt fel uppstod.", request_id: requestId }, 500);
}

export function oauthErrorPage(): Response {
  return new Response(
    `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fortnox kunde inte anslutas</title></head><body><main style="font-family:system-ui;max-width:680px;margin:48px auto;padding:24px"><h1>Fortnox kunde inte anslutas</h1><p>OAuth-sessionen kunde inte slutföras. Gå tillbaka till integrationen och försök igen.</p><p><a href="/integration">Till integrationen</a></p></main></body></html>`,
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
