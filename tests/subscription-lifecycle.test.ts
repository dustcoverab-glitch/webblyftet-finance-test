import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/worker";
import {
  confirmPaymentMethodUpdate,
  createPaymentMethodUpdateLink,
  createPaymentMethodUpdateSetupIntent,
  retryPastDueSubscriptionPayment,
  scheduleSubscriptionCancellation,
  undoScheduledSubscriptionCancellation
} from "../src/core/subscription-lifecycle";
import { processStripeEvent } from "../src/integrations/stripe/webhooks";
import { resetTables, workerEnv } from "./helpers";

describe("subscription lifecycle", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await resetTables();
    await seedSubscription();
  });

  it("schedules and undoes cancel at period end without immediate cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      return Response.json({
        id: "sub_stripe_lifecycle",
        object: "subscription",
        status: "active",
        cancel_at_period_end: body.includes("cancel_at_period_end=true"),
        current_period_end: 1792512000
      });
    }));

    const scheduled = await scheduleSubscriptionCancellation(workerEnv(), "sub_lifecycle");
    expect(scheduled).toMatchObject({ cancel_at_period_end: true });
    expect(await env.DB.prepare("SELECT cancel_at_period_end,cancellation_effective_at FROM subscriptions WHERE id=?")
      .bind("sub_lifecycle").first<any>()).toMatchObject({ cancel_at_period_end: 1 });

    const undone = await undoScheduledSubscriptionCancellation(workerEnv(), "sub_lifecycle");
    expect(undone).toMatchObject({ cancel_at_period_end: false });
    expect(await env.DB.prepare("SELECT cancel_at_period_end,cancellation_effective_at FROM subscriptions WHERE id=?")
      .bind("sub_lifecycle").first<any>()).toMatchObject({ cancel_at_period_end: 0, cancellation_effective_at: null });
  });

  it("allows only finance/admin to immediately cancel a subscription", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "sub_stripe_lifecycle",
      object: "subscription",
      status: "canceled",
      cancel_at_period_end: false,
      canceled_at: 1790000000
    })));
    const seller = await worker.fetch(req("/api/subscriptions/sub_lifecycle/cancel/immediate", "seller@example.test"), workerEnv(), createExecutionContext());
    expect(seller.status).toBe(403);

    const finance = await worker.fetch(req("/api/subscriptions/sub_lifecycle/cancel/immediate", "finance@example.test"), workerEnv(), createExecutionContext());
    expect(finance.status).toBe(200);
    expect(await env.DB.prepare("SELECT status,cancelled_at FROM subscriptions WHERE id=?")
      .bind("sub_lifecycle").first<any>()).toMatchObject({ status: "CANCELLED" });
  });

  it("models failed recurring payment, card replacement and retry recovery", async () => {
    await processStripeEvent(workerEnv(), stripeEvent("evt_lifecycle_failed", "invoice.payment_failed", {
      id: "in_lifecycle",
      object: "invoice",
      amount_due: 36900,
      total: 36900,
      currency: "sek",
      subscription: "sub_stripe_lifecycle",
      payment_intent: "pi_lifecycle_failed"
    }));
    expect(await env.DB.prepare("SELECT status,latest_stripe_invoice_id,payment_action_required_at FROM subscriptions WHERE id=?")
      .bind("sub_lifecycle").first<any>()).toMatchObject({ status: "PAST_DUE", latest_stripe_invoice_id: "in_lifecycle" });

    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/v1/setup_intents/seti_update")) {
        return Response.json({
          id: "seti_update",
          object: "setup_intent",
          status: "succeeded",
          payment_method: {
            id: "pm_replacement",
            object: "payment_method",
            type: "card",
            card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 }
          }
        });
      }
      if (url.includes("/v1/setup_intents")) {
        return Response.json({ id: "seti_update", object: "setup_intent", status: "requires_payment_method", client_secret: "seti_secret" });
      }
      if (url.includes("/v1/subscriptions/sub_stripe_lifecycle")) {
        return Response.json({ id: "sub_stripe_lifecycle", object: "subscription", status: "past_due", latest_invoice: { id: "in_lifecycle", object: "invoice" } });
      }
      if (url.includes("/v1/invoices/in_lifecycle/pay")) {
        return Response.json({ id: "in_lifecycle", object: "invoice", status: "paid" });
      }
      return Response.json({ id: "cus_stripe_lifecycle", object: "customer" });
    }));

    const link = await createPaymentMethodUpdateLink(workerEnv(), "sub_lifecycle");
    const token = link.url.split("/customer-order/card-update/")[1];
    const setup = await createPaymentMethodUpdateSetupIntent(workerEnv(), token);
    expect(setup).toMatchObject({ setup_intent_id: "seti_update" });
    await confirmPaymentMethodUpdate(workerEnv(), token);

    expect(calls.some((call) => call.includes("/v1/invoices/in_lifecycle/pay"))).toBe(true);
    expect(await env.DB.prepare("SELECT provider_payment_method_id,is_default FROM payment_methods WHERE customer_id=? ORDER BY is_default DESC, updated_at DESC LIMIT 1")
      .bind("cus_lifecycle").first<any>()).toMatchObject({ provider_payment_method_id: "pm_replacement", is_default: 1 });
  });

  it("keeps webhook replay idempotent for recurring accounting", async () => {
    for (const eventId of ["evt_paid_once", "evt_paid_replay"]) {
      await processStripeEvent(workerEnv(), stripeEvent(eventId, "invoice.paid", {
        id: "in_lifecycle_paid",
        object: "invoice",
        amount_paid: 36900,
        total: 36900,
        currency: "sek",
        subscription: "sub_stripe_lifecycle",
        payment_intent: "pi_lifecycle_paid",
        period_start: 1787241600,
        period_end: 1789920000,
        status_transitions: { paid_at: 1787241600 }
      }));
    }
    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM payments WHERE provider_payment_id='in_lifecycle_paid'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='SUBSCRIPTION_PAYMENT_RECEIVED'").first<{ count: number }>()
    ]);
    expect(counts.map((row) => row?.count)).toEqual([1, 1]);
  });
});

async function seedSubscription() {
  await env.DB.prepare("INSERT INTO customers(id,name,email,stripe_customer_id) VALUES (?,?,?,?)")
    .bind("cus_lifecycle", "Lifecycle AB", "buyer@example.test", "cus_stripe_lifecycle")
    .run();
  await env.DB.prepare(
    `INSERT INTO subscriptions(id,customer_id,status,currency,start_date,current_period_start,current_period_end,stripe_customer_id,stripe_subscription_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind("sub_lifecycle", "cus_lifecycle", "ACTIVE", "SEK", "2026-08-20", "2026-08-20", "2026-09-20", "cus_stripe_lifecycle", "sub_stripe_lifecycle").run();
  await env.DB.prepare(
    `INSERT INTO payment_methods(id,customer_id,provider,provider_payment_method_id,type,brand,last4,exp_month,exp_year,status,is_default)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind("pm_lifecycle", "cus_lifecycle", "STRIPE", "pm_old", "card", "visa", "1111", 12, 2030, "ACTIVE", 1).run();
}

function req(path: string, email: string) {
  return new Request(`https://finance-test.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user-email": email },
    body: JSON.stringify({ reason: "pilot test immediate cancellation" })
  });
}

function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return { id, object: "event", type, data: { object } } as any;
}
