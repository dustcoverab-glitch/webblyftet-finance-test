import { one } from "../../lib/db";
import { PublicAppError } from "../fortnox/client";
import { stripeClient } from "./client";
import type { StripeCustomerResult } from "./types";

export async function createOrReuseStripeCustomer(env: Env, customerId: string): Promise<StripeCustomerResult> {
  const customer = await one<any>(env.DB, "SELECT id,name,email,stripe_customer_id FROM customers WHERE id=?", customerId);
  if (!customer) throw new PublicAppError(404, "Kunden hittades inte.");
  if (customer.stripe_customer_id) {
    return { stripe_customer_id: customer.stripe_customer_id, reused: true };
  }

  const stripe = stripeClient(env);
  const created = await stripe.customers.create(
    {
      name: customer.name,
      email: customer.email || undefined,
      metadata: {
        webblyftet_customer_id: customer.id
      }
    },
    {
      idempotencyKey: `stripe-customer:${customer.id}`
    }
  );

  await env.DB.prepare(
    "UPDATE customers SET stripe_customer_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND stripe_customer_id IS NULL"
  ).bind(created.id, customer.id).run();

  const updated = await one<any>(env.DB, "SELECT stripe_customer_id FROM customers WHERE id=?", customer.id);
  return { stripe_customer_id: updated?.stripe_customer_id ?? created.id, reused: false };
}
