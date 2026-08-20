import type { MiddlewareHandler } from "hono";
import { cloudflareAccessRequired } from "./config";

export function isLocalEnvironment(env: Env): boolean {
  return env.APP_ENV === "local";
}

export function requireCloudflareAccess(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname === "/webhooks/stripe") {
      await next();
      return;
    }

    if (isLocalEnvironment(c.env) || !cloudflareAccessRequired(c.env)) {
      await next();
      return;
    }

    const hasAccessHeader =
      Boolean(c.req.header("cf-access-authenticated-user-email")) ||
      Boolean(c.req.header("cf-access-jwt-assertion"));

    if (!hasAccessHeader) {
      return c.json(
        {
          error: "Cloudflare Access krävs för den deployade testmiljön.",
          code: "ACCESS_REQUIRED"
        },
        403
      );
    }

    await next();
  };
}
