import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  acceptOfferToken,
  createInternalInvoiceFromSalesOrder,
  createOffer,
  createOfferAcceptanceToken,
  createPendingSubscriptionFromSalesOrder,
  createSalesOrderFromAcceptance
} from "../src/core/business-flow";
import { createPrice, createProduct } from "../src/core/finance";
import { activateStripeSubscription } from "../src/integrations/stripe/subscriptions";
import { processStripeEvent } from "../src/integrations/stripe/webhooks";
import { resetTables, workerEnv } from "./helpers";

describe("Customer to accounting business flow", () => {
  beforeEach(async () => {
    await resetTables();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepts an immutable offer version and idempotently creates order, invoice, subscription and invoice accounting", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email) VALUES (?,?,?)")
      .bind("cus_flow", "Acme AB", "buyer@example.com")
      .run();
    const project = await createProduct(workerEnv(), { name: "Projekt", product_type: "ONE_TIME" });
    const projectPrice = await createPrice(workerEnv(), { product_id: project!.id, amount: 100000, billing_type: "ONE_TIME" });
    const service = await createProduct(workerEnv(), { name: "Service", product_type: "SUBSCRIPTION" });
    const servicePrice = await createPrice(workerEnv(), { product_id: service!.id, amount: 20000, billing_type: "RECURRING", billing_interval: "MONTH" });
    const offer = await createOffer(workerEnv(), {
      customer_id: "cus_flow",
      title: "Testflöde",
      offer_date: "2026-08-20",
      rows: [
        { price_id: projectPrice!.id, quantity: 1 },
        { price_id: servicePrice!.id, quantity: 2 }
      ]
    });
    const link = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    const order = await acceptOfferToken(workerEnv(), {
      token: link.token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com",
      ip_address: "203.0.113.10",
      user_agent: "vitest"
    });

    await expect(acceptOfferToken(workerEnv(), {
      token: link.token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    })).rejects.toThrow(/redan|utgången|Ogiltig/);

    const acceptance = await env.DB.prepare("SELECT * FROM offer_acceptances").first<any>();
    expect(await createSalesOrderFromAcceptance(workerEnv(), acceptance.id)).toMatchObject({ id: order!.id });
    expect(await createInternalInvoiceFromSalesOrder(workerEnv(), order!.id)).toMatchObject({ sales_order_id: order!.id });
    expect(await createPendingSubscriptionFromSalesOrder(workerEnv(), order!.id)).toMatchObject({ sales_order_id: order!.id });

    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM sales_orders").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM invoices").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM subscriptions").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='INVOICE_CREATED'").first<{ count: number }>()
    ]);
    expect(counts.map((row) => row?.count)).toEqual([1, 1, 1, 1]);
    const accounting = await env.DB.prepare("SELECT payload_json FROM accounting_events WHERE event_type='INVOICE_CREATED'").first<{ payload_json: string }>();
    expect(JSON.parse(accounting!.payload_json)).toMatchObject({ accounting_semantics: "SALE" });
  });

  it("rejects expired and superseded offer acceptance tokens", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_token", "Acme AB").run();
    const offer = await createOffer(workerEnv(), {
      customer_id: "cus_token",
      title: "Token hygiene",
      offer_date: "2026-08-20",
      rows: [{ description: "Engång", quantity: 1, unit_price: 1000 }]
    });
    const expired = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    await env.DB.prepare("UPDATE offer_acceptance_tokens SET expires_at=? WHERE token_hash IS NOT NULL")
      .bind("2020-01-01T00:00:00.000Z")
      .run();
    await expect(acceptOfferToken(workerEnv(), {
      token: expired.token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    })).rejects.toThrow(/Ogiltig|utgången/);

    const stale = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    const fresh = await createOfferAcceptanceToken(workerEnv(), offer!.id);
    await expect(acceptOfferToken(workerEnv(), {
      token: stale.token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    })).rejects.toThrow(/Ogiltig|utgången|ersatts/);
    await expect(acceptOfferToken(workerEnv(), {
      token: fresh.token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    })).resolves.toBeTruthy();
  });

  it("activates Stripe subscriptions and records invoice.paid accounting exactly once after a prior invoice.payment_failed", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email,stripe_customer_id) VALUES (?,?,?,?)")
      .bind("cus_sub", "Acme AB", "buyer@example.com", "cus_stripe")
      .run();
    const product = await createProduct(workerEnv(), { name: "Service", product_type: "SUBSCRIPTION" });
    const price = await createPrice(workerEnv(), { product_id: product!.id, amount: 20000, billing_type: "RECURRING", billing_interval: "MONTH" });
    await env.DB.prepare(
      `INSERT INTO subscriptions(id,customer_id,status,currency,start_date,current_period_start)
       VALUES (?,?,?,?,?,?)`
    ).bind("sub_local", "cus_sub", "PENDING", "SEK", "2026-08-20", "2026-08-20").run();
    await env.DB.prepare(
      "INSERT INTO subscription_items(id,subscription_id,product_id,price_id,quantity,unit_amount) VALUES (?,?,?,?,?,?)"
    ).bind("sitem_local", "sub_local", product!.id, price!.id, 1, 20000).run();
    await env.DB.prepare(
      `INSERT INTO payment_methods(id,customer_id,provider,provider_payment_method_id,type,brand,last4,exp_month,exp_year,status,is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind("pm_local", "cus_sub", "STRIPE", "pm_card", "card", "visa", "4242", 12, 2030, "ACTIVE", 1).run();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/v1/products")
        ? { id: "prod_stripe", object: "product" }
        : url.includes("/v1/prices")
          ? { id: "price_stripe", object: "price" }
          : { id: "sub_stripe", object: "subscription", status: "incomplete", cancel_at_period_end: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" }
      });
    }));

    await expect(activateStripeSubscription(workerEnv(), "sub_local")).resolves.toMatchObject({ stripe_subscription_id: "sub_stripe" });
    await processStripeEvent(workerEnv(), stripeEvent("evt_invoice_failed", "invoice.payment_failed", {
      id: "in_sub_1",
      object: "invoice",
      amount_due: 25000,
      total: 25000,
      currency: "sek",
      subscription: "sub_stripe",
      payment_intent: "pi_invoice_1"
    }));
    await processStripeEvent(workerEnv(), stripeEvent("evt_invoice_paid", "invoice.paid", {
      id: "in_sub_1",
      object: "invoice",
      amount_paid: 25000,
      total: 25000,
      currency: "sek",
      subscription: "sub_stripe",
      payment_intent: "pi_invoice_1",
      period_start: 1787241600,
      period_end: 1789920000,
      status_transitions: { paid_at: 1787241600 }
    }));
    await processStripeEvent(workerEnv(), stripeEvent("evt_invoice_paid_duplicate_provider", "invoice.paid", {
      id: "in_sub_1",
      object: "invoice",
      amount_paid: 25000,
      total: 25000,
      currency: "sek",
      subscription: "sub_stripe",
      payment_intent: "pi_invoice_1",
      period_start: 1787241600,
      period_end: 1789920000,
      status_transitions: { paid_at: 1787241600 }
    }));

    const payment = await env.DB.prepare("SELECT status FROM payments WHERE provider_payment_id=?")
      .bind("in_sub_1")
      .first<{ status: string }>();
    const accounting = await env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='SUBSCRIPTION_PAYMENT_RECEIVED'")
      .first<{ count: number }>();
    expect(payment?.status).toBe("SUCCEEDED");
    expect(accounting?.count).toBe(1);
  });
});

function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return {
    id,
    object: "event",
    type,
    data: { object }
  } as any;
}
