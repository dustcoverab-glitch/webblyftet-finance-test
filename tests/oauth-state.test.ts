import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { PublicAppError } from "../src/lib/app-error";
import { cleanupExpiredOAuthStates, consumeOAuthState } from "../src/lib/fortnox";
import { resetTables } from "./helpers";

describe("OAuth state hygiene", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("consumes state only once", async () => {
    await env.DB.prepare("INSERT INTO oauth_states(state, expires_at) VALUES (?, ?)")
      .bind("fresh", new Date(Date.now() + 60_000).toISOString())
      .run();

    await consumeOAuthState(env, "fresh");

    await expect(consumeOAuthState(env, "fresh")).rejects.toBeInstanceOf(PublicAppError);
  });

  it("removes expired states", async () => {
    await env.DB.prepare("INSERT INTO oauth_states(state, expires_at) VALUES (?, ?)")
      .bind("expired", new Date(Date.now() - 60_000).toISOString())
      .run();

    await cleanupExpiredOAuthStates(env);

    const row = await env.DB.prepare("SELECT state FROM oauth_states WHERE state = ?").bind("expired").first();
    expect(row).toBeNull();
  });
});
