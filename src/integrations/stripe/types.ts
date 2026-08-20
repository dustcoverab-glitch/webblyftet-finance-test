export type StripeCustomerResult = {
  stripe_customer_id: string;
  reused: boolean;
};

export type StripeSetupIntentResult = {
  setup_intent_id: string;
  client_secret: string | null;
};

export const handledStripeEvents = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed"
] as const;
