import { id, one } from "../../lib/db";
import { PublicAppError } from "../../lib/app-error";
import { stripeClient } from "./client";
import { createOrReuseStripeCustomer } from "./customers";
import type { StripeSetupIntentResult } from "./types";
import { audit } from "../../core/finance";
import type Stripe from "stripe";
import { retrieveInvoicePaymentDetails } from "./invoice-payments";

const activeSetupIntentStatuses = [
  "CREATED",
  "REQUIRES_PAYMENT_METHOD",
  "REQUIRES_CONFIRMATION",
  "REQUIRES_ACTION",
  "PROCESSING"
] as const;

export async function createPaymentMethodSetupIntent(env: Env, customerId: string): Promise<StripeSetupIntentResult> {
  await createOrReuseStripeCustomer(env, customerId);
  const customer = await one<any>(env.DB, "SELECT id,stripe_customer_id FROM customers WHERE id=?", customerId);
  if (!customer) throw new PublicAppError(404, "Kunden hittades inte.");
  if (!customer.stripe_customer_id) throw new PublicAppError(409, "Kunden saknar Stripe Customer.");

  const now = new Date();
  const nowIso = now.toISOString();
  const existing = await one<any>(
    env.DB,
    `SELECT * FROM payment_method_setup_sessions
     WHERE customer_id=? AND status IN (${activeSetupIntentStatuses.map(() => "?").join(",")}) AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT 1`,
    customer.id,
    ...activeSetupIntentStatuses,
    nowIso
  );
  const stripe = stripeClient(env);
  if (existing?.stripe_setup_intent_id) {
    const intent = await stripe.setupIntents.retrieve(existing.stripe_setup_intent_id);
    await env.DB.prepare(
      "UPDATE payment_method_setup_sessions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(setupIntentStatus(intent.status), existing.id).run();
    return {
      setup_session_id: existing.id,
      setup_intent_id: intent.id,
      client_secret: intent.client_secret,
      reused: true
    };
  }

  const sessionId = existing?.id ?? id("pmsetup");
  const expiresAt = existing?.expires_at ?? new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO payment_method_setup_sessions(id,customer_id,stripe_customer_id,status,expires_at)
       VALUES (?,?,?,?,?)`
    ).bind(sessionId, customer.id, customer.stripe_customer_id, "CREATED", expiresAt).run();
  }

  try {
    const intent = await stripe.setupIntents.create(
      {
        customer: customer.stripe_customer_id,
        usage: "off_session",
        automatic_payment_methods: {
          enabled: true
        },
        metadata: {
          webblyftet_customer_id: customer.id,
          webblyftet_setup_session_id: sessionId
        }
      },
      {
        idempotencyKey: `payment-method-setup:${sessionId}`
      }
    );
    await env.DB.prepare(
      `UPDATE payment_method_setup_sessions
       SET stripe_setup_intent_id=?, status=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(intent.id, setupIntentStatus(intent.status), sessionId).run();
    return {
      setup_session_id: sessionId,
      setup_intent_id: intent.id,
      client_secret: intent.client_secret,
      reused: false
    };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE payment_method_setup_sessions SET status='FAILED', updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(sessionId).run();
    throw error;
  }
}

export async function syncProductToStripe(env: Env, productId: string) {
  const product = await one<any>(env.DB, "SELECT * FROM products WHERE id=?", productId);
  if (!product) throw new PublicAppError(404, "Produkten hittades inte.");
  if (product.stripe_product_id) return { stripe_product_id: product.stripe_product_id, reused: true };
  const stripe = stripeClient(env);
  const result = await stripe.products.create({
    name: product.name,
    description: product.description || undefined,
    active: product.active === 1,
    metadata: {
      webblyftet_product_id: product.id
    }
  }, {
    idempotencyKey: `product:${product.id}`
  });
  await env.DB.prepare("UPDATE products SET stripe_product_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(result.id, product.id)
    .run();
  return { stripe_product_id: result.id, reused: false };
}

export async function syncPriceToStripe(env: Env, priceId: string) {
  const price = await one<any>(
    env.DB,
    `SELECT pr.*, p.name product_name, p.stripe_product_id
     FROM prices pr JOIN products p ON p.id=pr.product_id
     WHERE pr.id=?`,
    priceId
  );
  if (!price) throw new PublicAppError(404, "Priset hittades inte.");
  if (price.stripe_price_id) return { stripe_price_id: price.stripe_price_id, reused: true };
  const productSync = price.stripe_product_id ? { stripe_product_id: price.stripe_product_id } : await syncProductToStripe(env, price.product_id);
  const stripe = stripeClient(env);
  const result = await stripe.prices.create({
    product: productSync.stripe_product_id,
    unit_amount: price.amount,
    currency: String(price.currency).toLowerCase(),
    recurring: price.billing_type === "RECURRING" ? {
      interval: price.billing_interval === "YEAR" ? "year" : "month"
    } : undefined,
    metadata: {
      webblyftet_price_id: price.id,
      webblyftet_product_id: price.product_id
    }
  }, {
    idempotencyKey: `price:${price.id}:${price.amount}:${price.currency}:${price.billing_interval ?? "one_time"}`
  });
  await env.DB.prepare("UPDATE prices SET stripe_price_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(result.id, price.id)
    .run();
  return { stripe_price_id: result.id, reused: false };
}

export async function activateStripeSubscription(env: Env, subscriptionId: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) throw new PublicAppError(404, "Abonnemanget hittades inte.");
  if (subscription.stripe_subscription_id) return { stripe_subscription_id: subscription.stripe_subscription_id, reused: true };
  if (!["PENDING", "DRAFT"].includes(subscription.status)) throw new PublicAppError(409, "Abonnemanget kan inte aktiveras i nuvarande status.");
  await createOrReuseStripeCustomer(env, subscription.customer_id);
  const customer = await one<any>(env.DB, "SELECT * FROM customers WHERE id=?", subscription.customer_id);
  if (!customer?.stripe_customer_id) throw new PublicAppError(409, "Kunden saknar Stripe Customer.");
  const paymentMethod = await one<any>(
    env.DB,
    "SELECT * FROM payment_methods WHERE customer_id=? AND provider='STRIPE' AND status='ACTIVE' ORDER BY is_default DESC, updated_at DESC LIMIT 1",
    customer.id
  );
  if (!paymentMethod) throw new PublicAppError(409, "Kunden saknar giltig betalmetod.");
  const items = await env.DB.prepare(
    `SELECT si.*, pr.billing_type, pr.stripe_price_id
     FROM subscription_items si JOIN prices pr ON pr.id=si.price_id
     WHERE si.subscription_id=?`
  ).bind(subscription.id).all<any>();
  if (!items.results.length) throw new PublicAppError(409, "Abonnemanget saknar rader.");
  const stripeItems = [];
  for (const item of items.results) {
    if (item.billing_type !== "RECURRING") throw new PublicAppError(409, "Endast återkommande priser får aktiveras.");
    const synced = item.stripe_price_id ? { stripe_price_id: item.stripe_price_id } : await syncPriceToStripe(env, item.price_id);
    stripeItems.push({ price: synced.stripe_price_id, quantity: item.quantity });
  }
  const stripe = stripeClient(env);
  const result = await stripe.subscriptions.create({
    customer: customer.stripe_customer_id,
    items: stripeItems,
    collection_method: "charge_automatically",
    default_payment_method: paymentMethod.provider_payment_method_id,
    payment_behavior: "allow_incomplete",
    off_session: true,
    expand: ["latest_invoice"],
    metadata: {
      webblyftet_subscription_id: subscription.id,
      webblyftet_customer_id: customer.id,
      sales_order_id: subscription.sales_order_id ?? ""
    }
  }, {
    idempotencyKey: `subscription:${subscription.id}`
  });
  await env.DB.prepare(
    "UPDATE subscriptions SET stripe_customer_id=?, stripe_subscription_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
  ).bind(customer.stripe_customer_id, result.id, subscription.id).run();
  await audit(env, "STRIPE", null, "SUBSCRIPTION_ACTIVATION_REQUESTED", "subscription", subscription.id, subscription, {
    stripe_subscription_id: result.id,
    status: result.status
  });
  return {
    stripe_subscription_id: result.id,
    reused: false,
    status: result.status,
    payment_action: await subscriptionPaymentAction(stripe, result)
  };
}

export async function cancelStripeSubscriptionAtPeriodEnd(env: Env, subscriptionId: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) throw new PublicAppError(404, "Abonnemanget hittades inte.");
  if (!subscription.stripe_subscription_id) throw new PublicAppError(409, "Abonnemanget saknar Stripe Subscription.");
  const stripe = stripeClient(env);
  const result = await stripe.subscriptions.update(subscription.stripe_subscription_id, {
    cancel_at_period_end: true
  }, {
    idempotencyKey: `subscription-cancel-at-period-end:${subscription.id}`
  });
  await env.DB.prepare("UPDATE subscriptions SET cancel_at_period_end=1, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(subscription.id)
    .run();
  await audit(env, "STRIPE", null, "SUBSCRIPTION_CANCEL_AT_PERIOD_END_REQUESTED", "subscription", subscription.id, subscription, {
    stripe_subscription_id: result.id,
    cancel_at_period_end: result.cancel_at_period_end
  });
  return { stripe_subscription_id: result.id, cancel_at_period_end: result.cancel_at_period_end };
}

function setupIntentStatus(status: string): string {
  switch (status) {
    case "requires_payment_method":
      return "REQUIRES_PAYMENT_METHOD";
    case "requires_confirmation":
      return "REQUIRES_CONFIRMATION";
    case "requires_action":
      return "REQUIRES_ACTION";
    case "processing":
      return "PROCESSING";
    case "succeeded":
      return "SUCCEEDED";
    case "canceled":
      return "CANCELLED";
    default:
      return "CREATED";
  }
}

async function subscriptionPaymentAction(stripe: Stripe, subscription: Stripe.Subscription) {
  const latestInvoice = subscription.latest_invoice;
  const invoice = typeof latestInvoice === "object" && latestInvoice !== null ? latestInvoice : null;
  if (!invoice || subscription.status !== "incomplete") return null;
  const payment = await retrieveInvoicePaymentDetails(stripe, invoice);
  const paymentIntent = payment?.payment_intent ?? null;
  if (!paymentIntent) return null;
  if (paymentIntent.status === "requires_confirmation") {
    return {
      required: false,
      type: "STRIPE_REQUIRES_CONFIRMATION",
      invoice_id: invoice.id,
      invoice_payment_id: payment?.invoice_payment_id ?? null,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status
    };
  }
  if (paymentIntent.status !== "requires_action") return null;
  return {
    required: true,
    type: "STRIPE_CONFIRMATION",
    invoice_id: invoice.id,
    invoice_payment_id: payment?.invoice_payment_id ?? null,
    payment_intent_id: paymentIntent.id,
    status: paymentIntent.status,
    client_secret: paymentIntent.client_secret
  };
}
