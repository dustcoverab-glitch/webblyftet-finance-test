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

  it("activates Stripe subscriptions with allow_incomplete and records invoice.paid accounting exactly once after a prior invoice.payment_failed", async () => {
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

    const stripeRequests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      stripeRequests.push({ url, body: String(init?.body ?? "") });
      const body = url.includes("/v1/products")
        ? { id: "prod_stripe", object: "product" }
        : url.includes("/v1/prices")
          ? { id: "price_stripe", object: "price" }
          : { id: "sub_stripe", object: "subscription", status: "active", cancel_at_period_end: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" }
      });
    }));

    await expect(activateStripeSubscription(workerEnv(), "sub_local")).resolves.toMatchObject({ stripe_subscription_id: "sub_stripe" });
    const subscriptionRequest = stripeRequests.find((request) => request.url.includes("/v1/subscriptions"));
    expect(subscriptionRequest?.body).toContain("payment_behavior=allow_incomplete");
    expect(subscriptionRequest?.body).toContain("collection_method=charge_automatically");
    expect(subscriptionRequest?.body).toContain("off_session=true");
    expect(subscriptionRequest?.body).toContain("default_payment_method=pm_card");
    await expect(activateStripeSubscription(workerEnv(), "sub_local")).resolves.toMatchObject({ stripe_subscription_id: "sub_stripe", reused: true });
    await processStripeEvent(workerEnv(), stripeEvent("evt_subscription_active", "customer.subscription.updated", {
      id: "sub_stripe",
      object: "subscription",
      status: "active",
      current_period_start: 1787241600,
      current_period_end: 1789920000,
      cancel_at_period_end: false,
      metadata: { webblyftet_subscription_id: "sub_local" }
    }));
    await processStripeEvent(workerEnv(), stripeEvent("evt_invoice_failed", "invoice.payment_failed", {
      id: "in_sub_1",
      object: "invoice",
      amount_due: 25000,
      total: 25000,
      currency: "sek",
      subscription: "sub_stripe",
      payment_intent: "pi_invoice_1"
    }));
    const failedState = await Promise.all([
      env.DB.prepare("SELECT status FROM payments WHERE provider_payment_id=?")
        .bind("in_sub_1")
        .first<{ status: string }>(),
      env.DB.prepare("SELECT status FROM subscriptions WHERE id=?")
        .bind("sub_local")
        .first<{ status: string }>()
    ]);
    expect(failedState.map((row) => row?.status)).toEqual(["FAILED", "PAST_DUE"]);
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
    await processStripeEvent(workerEnv(), stripeEvent("evt_subscription_active_after_payment", "customer.subscription.updated", {
      id: "sub_stripe",
      object: "subscription",
      status: "active",
      current_period_start: 1787241600,
      current_period_end: 1789920000,
      cancel_at_period_end: false,
      metadata: { webblyftet_subscription_id: "sub_local" }
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
    const subscriptionStatus = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?")
      .bind("sub_local")
      .first<{ status: string }>();
    const accounting = await env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='SUBSCRIPTION_PAYMENT_RECEIVED'")
      .first<{ count: number }>();
    expect(payment?.status).toBe("SUCCEEDED");
    expect(subscriptionStatus?.status).toBe("ACTIVE");
    expect(accounting?.count).toBe(1);
  });

  it("keeps subscriptions incomplete when Stripe requires customer action and exposes the PaymentIntent client secret", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name,email,stripe_customer_id) VALUES (?,?,?,?)")
      .bind("cus_action", "Acme AB", "buyer@example.com", "cus_stripe_action")
      .run();
    const product = await createProduct(workerEnv(), { name: "Action Service", product_type: "SUBSCRIPTION" });
    const price = await createPrice(workerEnv(), { product_id: product!.id, amount: 20000, billing_type: "RECURRING", billing_interval: "MONTH" });
    await env.DB.prepare(
      `INSERT INTO subscriptions(id,customer_id,status,currency,start_date,current_period_start)
       VALUES (?,?,?,?,?,?)`
    ).bind("sub_action", "cus_action", "PENDING", "SEK", "2026-08-20", "2026-08-20").run();
    await env.DB.prepare(
      "INSERT INTO subscription_items(id,subscription_id,product_id,price_id,quantity,unit_amount) VALUES (?,?,?,?,?,?)"
    ).bind("sitem_action", "sub_action", product!.id, price!.id, 1, 20000).run();
    await env.DB.prepare(
      `INSERT INTO payment_methods(id,customer_id,provider,provider_payment_method_id,type,brand,last4,exp_month,exp_year,status,is_default)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind("pm_action", "cus_action", "STRIPE", "pm_card_action", "card", "visa", "3184", 12, 2030, "ACTIVE", 1).run();

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.includes("/v1/products")
        ? { id: "prod_action", object: "product" }
        : url.includes("/v1/prices")
          ? { id: "price_action", object: "price" }
          : url.includes("/v1/invoice_payments")
            ? {
                object: "list",
                data: [{
                  id: "inpay_action",
                  object: "invoice_payment",
                  is_default: true,
                  status: "open",
                  amount_requested: 20000,
                  amount_paid: null,
                  payment: {
                    type: "payment_intent",
                    payment_intent: {
                      id: "pi_action",
                      object: "payment_intent",
                      status: "requires_action",
                      client_secret: "pi_action_secret"
                    }
                  }
                }]
              }
            : {
              id: "sub_stripe_action",
              object: "subscription",
              status: "incomplete",
              cancel_at_period_end: false,
              latest_invoice: {
                id: "in_action",
                object: "invoice"
              }
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_test" }
      });
    }));

    const result = await activateStripeSubscription(workerEnv(), "sub_action");
    await processStripeEvent(workerEnv(), stripeEvent("evt_subscription_action", "customer.subscription.created", {
      id: "sub_stripe_action",
      object: "subscription",
      status: "incomplete",
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
      metadata: { webblyftet_subscription_id: "sub_action" }
    }));

    const subscriptionStatus = await env.DB.prepare("SELECT status FROM subscriptions WHERE id=?")
      .bind("sub_action")
      .first<{ status: string }>();
    const accounting = await env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='SUBSCRIPTION_PAYMENT_RECEIVED'")
      .first<{ count: number }>();
    expect(result).toMatchObject({
      stripe_subscription_id: "sub_stripe_action",
      status: "incomplete",
      payment_action: {
        required: true,
        type: "STRIPE_CONFIRMATION",
        invoice_id: "in_action",
        invoice_payment_id: "inpay_action",
        payment_intent_id: "pi_action",
        status: "requires_action",
        client_secret: "pi_action_secret"
      }
    });
    expect(subscriptionStatus?.status).toBe("PENDING");
    expect(accounting?.count).toBe(0);
  });

  it("recovers acceptance when token was claimed but acceptance creation did not finish", async () => {
    const { token } = await createOneTimeOfferLink();
    await env.DB.prepare("UPDATE offer_acceptance_tokens SET status='PROCESSING' WHERE status='ACTIVE'").run();

    await expect(acceptOfferToken(workerEnv(), {
      token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    })).resolves.toBeTruthy();

    const row = await env.DB.prepare("SELECT status, used_at FROM offer_acceptance_tokens").first<any>();
    const count = await env.DB.prepare("SELECT COUNT(*) count FROM offer_acceptances").first<{ count: number }>();
    expect(row.status).toBe("USED");
    expect(row.used_at).toBeTruthy();
    expect(count?.count).toBe(1);
  });

  it("handles concurrent acceptance requests with only one persisted acceptance", async () => {
    const { token } = await createOneTimeOfferLink();

    const attempts = await Promise.allSettled([
      acceptOfferToken(workerEnv(), { token, accepted_by_name: "A", accepted_by_email: "a@example.com" }),
      acceptOfferToken(workerEnv(), { token, accepted_by_name: "B", accepted_by_email: "b@example.com" })
    ]);

    expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM offer_acceptances").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM sales_orders").first<{ count: number }>(),
      env.DB.prepare("SELECT status FROM offer_acceptance_tokens").first<{ status: string }>()
    ]);
    expect(counts[0]?.count).toBe(1);
    expect(counts[1]?.count).toBe(1);
    expect(counts[2]?.status).toBe("USED");
  });

  it("repairs interrupted order provisioning on retry", async () => {
    const { token } = await createMixedOfferLink();
    const order = await acceptOfferToken(workerEnv(), {
      token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    });
    const acceptance = await env.DB.prepare("SELECT id FROM offer_acceptances").first<{ id: string }>();
    await env.DB.prepare("DELETE FROM accounting_events").run();
    await env.DB.prepare("DELETE FROM invoice_rows").run();
    await env.DB.prepare("DELETE FROM invoices").run();
    await env.DB.prepare("DELETE FROM subscription_items").run();
    await env.DB.prepare("DELETE FROM subscriptions").run();
    await env.DB.prepare("DELETE FROM sales_order_items").run();
    await env.DB.prepare("UPDATE sales_orders SET status='PARTIAL_FAILURE' WHERE id=?").bind(order!.id).run();

    const repaired = await createSalesOrderFromAcceptance(workerEnv(), acceptance!.id);
    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM sales_order_items").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM invoices").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM subscriptions").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='INVOICE_CREATED'").first<{ count: number }>(),
      env.DB.prepare("SELECT status FROM sales_orders WHERE id=?").bind(order!.id).first<{ status: string }>()
    ]);

    expect(repaired?.id).toBe(order!.id);
    expect(counts.map((row: any) => row.count ?? row.status)).toEqual([2, 1, 1, 1, "READY"]);
  });

  it("repairs missing invoice accounting without creating another invoice or subscription", async () => {
    const { token } = await createMixedOfferLink();
    const order = await acceptOfferToken(workerEnv(), {
      token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    });
    const acceptance = await env.DB.prepare("SELECT id FROM offer_acceptances").first<{ id: string }>();
    await env.DB.prepare("DELETE FROM accounting_events").run();

    await createSalesOrderFromAcceptance(workerEnv(), acceptance!.id);
    await createSalesOrderFromAcceptance(workerEnv(), acceptance!.id);

    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM invoices WHERE sales_order_id=?").bind(order!.id).first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM subscriptions WHERE sales_order_id=?").bind(order!.id).first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='INVOICE_CREATED'").first<{ count: number }>()
    ]);
    expect(counts.map((row) => row?.count)).toEqual([1, 1, 1]);
  });

  it("reserves unique test invoice numbers under concurrent invoice creation", async () => {
    const orders = [];
    for (let i = 0; i < 2; i += 1) {
      const { token } = await createOneTimeOfferLink(`cus_seq_${i}`);
      const order = await acceptOfferToken(workerEnv(), {
        token,
        accepted_by_name: "Köpare",
        accepted_by_email: "buyer@example.com"
      });
      orders.push(order!.id);
    }
    await env.DB.prepare("DELETE FROM accounting_events").run();
    await env.DB.prepare("DELETE FROM invoice_rows").run();
    await env.DB.prepare("DELETE FROM invoices").run();
    await env.DB.prepare("UPDATE document_sequences SET next_number=1 WHERE name='TEST_INVOICE'").run();

    await Promise.all(orders.map((orderId) => createInternalInvoiceFromSalesOrder(workerEnv(), orderId)));
    const rows = await env.DB.prepare("SELECT invoice_number, invoice_type FROM invoices ORDER BY invoice_number").all<any>();
    expect(rows.results.map((row) => row.invoice_number)).toEqual(["TEST-00001", "TEST-00002"]);
    expect(new Set(rows.results.map((row) => row.invoice_number)).size).toBe(2);
    expect(rows.results.every((row) => row.invoice_type === "PROJECT_INVOICE")).toBe(true);
  });

  it("keeps recurring PaymentIntent diagnostic and invoice.paid canonical accounting as one payment", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_rec", "Acme AB").run();
    await env.DB.prepare(
      `INSERT INTO subscriptions(id,customer_id,status,currency,start_date,current_period_start,stripe_subscription_id)
       VALUES (?,?,?,?,?,?,?)`
    ).bind("sub_rec", "cus_rec", "ACTIVE", "SEK", "2026-08-20", "2026-08-20", "sub_stripe_rec").run();

    await processStripeEvent(workerEnv(), stripeEvent("evt_pi_rec", "payment_intent.succeeded", {
      id: "pi_recurring",
      object: "payment_intent",
      invoice: "in_recurring",
      amount: 25000,
      amount_received: 25000,
      currency: "sek",
      created: 1787241600,
      latest_charge: "ch_recurring",
      metadata: {
        webblyftet_customer_id: "cus_rec",
        webblyftet_subscription_id: "sub_rec"
      }
    }));
    await processStripeEvent(workerEnv(), stripeEvent("evt_invoice_rec_paid", "invoice.paid", {
      id: "in_recurring",
      object: "invoice",
      amount_paid: 25000,
      total: 25000,
      currency: "sek",
      subscription: "sub_stripe_rec",
      payments: {
        data: [{
          id: "inpay_recurring",
          is_default: true,
          status: "paid",
          payment: {
            type: "payment_intent",
            payment_intent: {
              id: "pi_recurring",
              object: "payment_intent",
              status: "succeeded"
            }
          }
        }]
      },
      period_start: 1787241600,
      period_end: 1789920000,
      status_transitions: { paid_at: 1787241600 }
    }));

    const counts = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) count FROM payments WHERE provider='STRIPE' AND provider_payment_id='in_recurring'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='PAYMENT_RECEIVED'").first<{ count: number }>(),
      env.DB.prepare("SELECT COUNT(*) count FROM accounting_events WHERE event_type='SUBSCRIPTION_PAYMENT_RECEIVED'").first<{ count: number }>()
    ]);
    expect(counts.map((row) => row?.count)).toEqual([1, 0, 1]);
  });

  it("includes the full related customer audit timeline", async () => {
    const { token } = await createMixedOfferLink("cus_audit");
    const order = await acceptOfferToken(workerEnv(), {
      token,
      accepted_by_name: "Köpare",
      accepted_by_email: "buyer@example.com"
    });
    await env.DB.prepare(
      `INSERT INTO payment_methods(id,customer_id,provider,provider_payment_method_id,type,status,is_default)
       VALUES (?,?,?,?,?,?,?)`
    ).bind("pm_audit", "cus_audit", "STRIPE", "pm_card", "card", "ACTIVE", 1).run();
    await env.DB.prepare(
      `INSERT INTO audit_log(id,actor_type,action,entity_type,entity_id)
       VALUES (?,?,?,?,?)`
    ).bind("aud_pm", "STRIPE", "PAYMENT_METHOD_ATTACHED", "payment_method", "pm_audit").run();
    const invoice = await env.DB.prepare("SELECT id FROM invoices WHERE sales_order_id=?").bind(order!.id).first<{ id: string }>();
    const subscription = await env.DB.prepare("SELECT id FROM subscriptions WHERE sales_order_id=?").bind(order!.id).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO payments(id,customer_id,subscription_id,amount,status,provider,provider_payment_id) VALUES (?,?,?,?,?,?,?)")
      .bind("pay_audit", "cus_audit", subscription!.id, 1000, "SUCCEEDED", "STRIPE", "in_audit")
      .run();
    await env.DB.prepare("INSERT INTO audit_log(id,actor_type,action,entity_type,entity_id) VALUES (?,?,?,?,?)")
      .bind("aud_pay", "STRIPE", "PAYMENT_CREATED", "payment", "pay_audit")
      .run();

    const detail = await import("../src/core/business-flow").then((module) => module.getCustomerDetail(workerEnv(), "cus_audit"));
    const actions = detail!.audit.map((row: any) => row.action);
    expect(invoice).toBeTruthy();
    expect(subscription).toBeTruthy();
    expect(actions).toEqual(expect.arrayContaining([
      "OFFER_CREATED",
      "OFFER_ACCEPTED",
      "SALES_ORDER_CREATED",
      "INVOICE_CREATED",
      "SUBSCRIPTION_PENDING_CREATED",
      "PAYMENT_METHOD_ATTACHED",
      "PAYMENT_CREATED"
    ]));
  });
});

async function createOneTimeOfferLink(customerId = "cus_one_time") {
  await env.DB.prepare("INSERT OR IGNORE INTO customers(id,name,email) VALUES (?,?,?)")
    .bind(customerId, "Acme AB", "buyer@example.com")
    .run();
  const offer = await createOffer(workerEnv(), {
    customer_id: customerId,
    title: "Engång",
    offer_date: "2026-08-20",
    rows: [{ description: "Projekt", quantity: 1, unit_price: 1000 }]
  });
  return createOfferAcceptanceToken(workerEnv(), offer!.id);
}

async function createMixedOfferLink(customerId = "cus_mixed") {
  await env.DB.prepare("INSERT OR IGNORE INTO customers(id,name,email) VALUES (?,?,?)")
    .bind(customerId, "Acme AB", "buyer@example.com")
    .run();
  const project = await createProduct(workerEnv(), { name: `Projekt ${customerId}`, product_type: "ONE_TIME" });
  const projectPrice = await createPrice(workerEnv(), { product_id: project!.id, amount: 100000, billing_type: "ONE_TIME" });
  const service = await createProduct(workerEnv(), { name: `Service ${customerId}`, product_type: "SUBSCRIPTION" });
  const servicePrice = await createPrice(workerEnv(), { product_id: service!.id, amount: 20000, billing_type: "RECURRING", billing_interval: "MONTH" });
  const offer = await createOffer(workerEnv(), {
    customer_id: customerId,
    title: "Blandat flöde",
    offer_date: "2026-08-20",
    rows: [
      { price_id: projectPrice!.id, quantity: 1 },
      { price_id: servicePrice!.id, quantity: 1 }
    ]
  });
  return createOfferAcceptanceToken(workerEnv(), offer!.id);
}

function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return {
    id,
    object: "event",
    type,
    data: { object }
  } as any;
}
