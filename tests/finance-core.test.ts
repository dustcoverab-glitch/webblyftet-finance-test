import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  createAccountingEvent,
  createPrice,
  createProduct,
  createSubscription,
  recordPaymentAttempt,
  subscriptionMonthlyAmount,
  upsertPayment,
  validatePriceInput
} from "../src/core/finance";
import { resetTables, workerEnv } from "./helpers";

describe("Finance Core", () => {
  beforeEach(async () => {
    await resetTables();
  });

  it("creates products and prices in minor currency units", async () => {
    const product = await createProduct(workerEnv(), {
      name: "Webblyftet Service",
      product_type: "SUBSCRIPTION"
    });
    const price = await createPrice(workerEnv(), {
      product_id: product!.id,
      amount: 29500,
      billing_type: "RECURRING",
      billing_interval: "MONTH"
    });

    expect(price).toMatchObject({ amount: 29500, billing_type: "RECURRING", billing_interval: "MONTH" });
  });

  it("validates recurring price intervals", () => {
    expect(() => validatePriceInput({
      product_id: "prod_1",
      amount: 29500,
      billing_type: "RECURRING",
      billing_interval: null
    })).toThrow(/billing_interval/);
  });

  it("calculates subscription monthly totals with multiple items", () => {
    expect(subscriptionMonthlyAmount([
      { unit_amount: 29500, quantity: 1, billing_interval: "MONTH" },
      { unit_amount: 14500, quantity: 3, billing_interval: "MONTH" }
    ])).toBe(73000);
  });

  it("creates subscriptions with item totals", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_test", "Acme AB").run();
    const service = await createProduct(workerEnv(), { name: "Webblyftet Service", product_type: "SUBSCRIPTION" });
    const m365 = await createProduct(workerEnv(), { name: "Microsoft 365", product_type: "SUBSCRIPTION" });
    const servicePrice = await createPrice(workerEnv(), { product_id: service!.id, amount: 29500, billing_type: "RECURRING", billing_interval: "MONTH" });
    const m365Price = await createPrice(workerEnv(), { product_id: m365!.id, amount: 14500, billing_type: "RECURRING", billing_interval: "MONTH" });

    const subscription = await createSubscription(workerEnv(), {
      customer_id: "cus_test",
      start_date: "2026-08-20",
      items: [
        { product_id: service!.id, price_id: servicePrice!.id, quantity: 1 },
        { product_id: m365!.id, price_id: m365Price!.id, quantity: 3 }
      ]
    });

    expect(subscription?.monthly_amount).toBe(73000);
    expect(subscription?.items).toHaveLength(2);
  });

  it("keeps payment attempts history and prevents duplicate payments", async () => {
    await env.DB.prepare("INSERT INTO customers(id,name) VALUES (?,?)").bind("cus_test", "Acme AB").run();
    const payment = await upsertPayment(workerEnv(), {
      customer_id: "cus_test",
      amount: 29500,
      status: "SUCCEEDED",
      provider: "STRIPE",
      provider_payment_id: "pi_test"
    });
    const duplicate = await upsertPayment(workerEnv(), {
      customer_id: "cus_test",
      amount: 29500,
      status: "SUCCEEDED",
      provider: "STRIPE",
      provider_payment_id: "pi_test"
    });
    await recordPaymentAttempt(workerEnv(), { payment_id: payment!.id, provider: "STRIPE", provider_attempt_id: "ch_1", status: "SUCCEEDED" });
    await recordPaymentAttempt(workerEnv(), { payment_id: payment!.id, provider: "STRIPE", provider_attempt_id: "ch_2", status: "FAILED" });

    const attempts = await env.DB.prepare("SELECT COUNT(*) count FROM payment_attempts").first<{ count: number }>();
    expect(duplicate!.id).toBe(payment!.id);
    expect(attempts?.count).toBe(2);
  });

  it("generates accounting events idempotently", async () => {
    const first = await createAccountingEvent(workerEnv(), {
      event_type: "PAYMENT_RECEIVED",
      entity_type: "payment",
      entity_id: "pay_1",
      currency: "SEK",
      net_amount: 23600,
      vat_amount: 5900,
      gross_amount: 29500
    });
    const second = await createAccountingEvent(workerEnv(), {
      event_type: "PAYMENT_RECEIVED",
      entity_type: "payment",
      entity_id: "pay_1",
      currency: "SEK",
      net_amount: 23600,
      vat_amount: 5900,
      gross_amount: 29500
    });
    expect(second!.id).toBe(first!.id);
  });
});
