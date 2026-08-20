import { one } from "../../lib/db";
import { PublicAppError } from "../fortnox/client";
import { stripeClient } from "./client";
import type { StripeSetupIntentResult } from "./types";

export async function createPaymentMethodSetupIntent(env: Env, customerId: string): Promise<StripeSetupIntentResult> {
  const customer = await one<any>(env.DB, "SELECT id,stripe_customer_id FROM customers WHERE id=?", customerId);
  if (!customer) throw new PublicAppError(404, "Kunden hittades inte.");
  if (!customer.stripe_customer_id) throw new PublicAppError(409, "Kunden saknar Stripe Customer.");

  const stripe = stripeClient(env);
  const intent = await stripe.setupIntents.create(
    {
      customer: customer.stripe_customer_id,
      usage: "off_session",
      automatic_payment_methods: {
        enabled: true
      },
      metadata: {
        webblyftet_customer_id: customer.id
      }
    },
    {
      idempotencyKey: `setup-intent:${customer.id}:${Date.now()}`
    }
  );
  return {
    setup_intent_id: intent.id,
    client_secret: intent.client_secret
  };
}
