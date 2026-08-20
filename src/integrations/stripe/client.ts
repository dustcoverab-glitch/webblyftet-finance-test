import Stripe from "stripe";
import { stripeSecretKey } from "../../lib/config";

export function stripeClient(env: Env): Stripe {
  return new Stripe(stripeSecretKey(env), {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    typescript: true
  });
}

export function stripeWebhookCryptoProvider() {
  return Stripe.createSubtleCryptoProvider();
}
