import Stripe from "stripe";

export function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-07-29.dahlia",
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    typescript: true
  });
}

export function stripeWebhookCryptoProvider() {
  return Stripe.createSubtleCryptoProvider();
}
