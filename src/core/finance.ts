import { id, one } from "../lib/db";
import { PublicAppError } from "../integrations/fortnox/client";

export const subscriptionStatuses = ["DRAFT", "PENDING", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED", "ENDED"] as const;
export const paymentStatuses = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"] as const;

export type CreateProductInput = {
  name: string;
  description?: string;
  product_type: "ONE_TIME" | "SUBSCRIPTION";
  active?: boolean;
};

export type CreatePriceInput = {
  product_id: string;
  amount: number;
  currency?: string;
  billing_type: "ONE_TIME" | "RECURRING";
  billing_interval?: "MONTH" | "YEAR" | null;
  vat_percent?: number;
  active?: boolean;
  stripe_price_id?: string | null;
};

export type SubscriptionItemInput = {
  product_id: string;
  price_id: string;
  quantity: number;
};

export function validatePriceInput(input: CreatePriceInput): void {
  if (!Number.isInteger(input.amount) || input.amount < 0) {
    throw new PublicAppError(400, "Pris måste anges i ören som ett positivt heltal.");
  }
  if (input.billing_type === "ONE_TIME" && input.billing_interval) {
    throw new PublicAppError(400, "Engångspriser får inte ha billing_interval.");
  }
  if (input.billing_type === "RECURRING" && !input.billing_interval) {
    throw new PublicAppError(400, "Återkommande priser kräver billing_interval.");
  }
}

export function subscriptionMonthlyAmount(items: Array<{ unit_amount: number; quantity: number; billing_interval?: string | null }>): number {
  return items.reduce((sum, item) => {
    if (item.billing_interval === "YEAR") return sum + Math.round((item.unit_amount * item.quantity) / 12);
    return sum + item.unit_amount * item.quantity;
  }, 0);
}

export async function createProduct(env: Env, input: CreateProductInput) {
  const productId = id("prod");
  await env.DB.prepare(
    `INSERT INTO products(id,name,description,active,product_type)
     VALUES (?,?,?,?,?)`
  ).bind(productId, input.name, input.description ?? "", input.active === false ? 0 : 1, input.product_type).run();
  await audit(env, "SYSTEM", null, "PRODUCT_CREATED", "product", productId, null, input);
  return one<any>(env.DB, "SELECT * FROM products WHERE id=?", productId);
}

export async function createPrice(env: Env, input: CreatePriceInput) {
  validatePriceInput(input);
  const priceId = id("price");
  await env.DB.prepare(
    `INSERT INTO prices(id,product_id,amount,currency,billing_type,billing_interval,vat_percent,active,stripe_price_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    priceId,
    input.product_id,
    input.amount,
    (input.currency ?? "SEK").toUpperCase(),
    input.billing_type,
    input.billing_interval ?? null,
    input.vat_percent ?? 25,
    input.active === false ? 0 : 1,
    input.stripe_price_id ?? null
  ).run();
  await audit(env, "SYSTEM", null, "PRICE_CREATED", "price", priceId, null, input);
  return one<any>(env.DB, "SELECT * FROM prices WHERE id=?", priceId);
}

export async function seedTestProducts(env: Env) {
  if (env.APP_ENV === "production") throw new PublicAppError(403, "Seed får inte köras i production.");
  const existing = await one<{ count: number }>(env.DB, "SELECT COUNT(*) count FROM products");
  if ((existing?.count ?? 0) > 0) return { created: 0 };

  const definitions = [
    ["Webblyftet Bas", "Engångsprojekt", "ONE_TIME", 799500, "ONE_TIME", null],
    ["Webblyftet Avancerad", "Engångsprojekt", "ONE_TIME", 1499500, "ONE_TIME", null],
    ["Webblyftet Service", "Löpande service", "SUBSCRIPTION", 29500, "RECURRING", "MONTH"],
    ["Webblyftet Drift", "Årlig drift", "SUBSCRIPTION", 89500, "RECURRING", "YEAR"],
    ["Microsoft 365", "Licens per användare", "SUBSCRIPTION", 14500, "RECURRING", "MONTH"]
  ] as const;

  for (const [name, description, productType, amount, billingType, interval] of definitions) {
    const product = await createProduct(env, { name, description, product_type: productType });
    await createPrice(env, {
      product_id: product!.id,
      amount,
      billing_type: billingType,
      billing_interval: interval,
      vat_percent: 25
    });
  }
  return { created: definitions.length };
}

export async function createSubscription(env: Env, input: {
  customer_id: string;
  start_date: string;
  items: SubscriptionItemInput[];
  status?: typeof subscriptionStatuses[number];
}) {
  if (!input.items.length) throw new PublicAppError(400, "Subscription kräver minst en rad.");
  const subscriptionId = id("sub");
  await env.DB.prepare(
    `INSERT INTO subscriptions(id,customer_id,status,currency,start_date,current_period_start,current_period_end)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(subscriptionId, input.customer_id, input.status ?? "DRAFT", "SEK", input.start_date, input.start_date, null).run();

  for (const item of input.items) {
    const price = await one<any>(env.DB, "SELECT * FROM prices WHERE id=? AND active=1", item.price_id);
    if (!price) throw new PublicAppError(404, "Pris saknas eller är inaktivt.");
    await env.DB.prepare(
      `INSERT INTO subscription_items(id,subscription_id,product_id,price_id,quantity,unit_amount)
       VALUES (?,?,?,?,?,?)`
    ).bind(id("sitem"), subscriptionId, item.product_id, item.price_id, item.quantity, price.amount).run();
  }
  await audit(env, "SYSTEM", null, "SUBSCRIPTION_CREATED", "subscription", subscriptionId, null, input);
  return getSubscription(env, subscriptionId);
}

export async function getSubscription(env: Env, subscriptionId: string) {
  const subscription = await one<any>(env.DB, "SELECT * FROM subscriptions WHERE id=?", subscriptionId);
  if (!subscription) return null;
  const items = await env.DB.prepare(
    `SELECT si.*, p.name product_name, pr.billing_interval
     FROM subscription_items si
     JOIN products p ON p.id=si.product_id
     JOIN prices pr ON pr.id=si.price_id
     WHERE si.subscription_id=? ORDER BY si.created_at`
  ).bind(subscriptionId).all<any>();
  return {
    ...subscription,
    items: items.results,
    monthly_amount: subscriptionMonthlyAmount(items.results)
  };
}

export async function upsertPayment(env: Env, input: {
  customer_id: string;
  subscription_id?: string | null;
  invoice_id?: string | null;
  amount: number;
  currency?: string;
  status: typeof paymentStatuses[number];
  provider: "STRIPE" | "FORTNOX" | "BANK" | "MANUAL";
  provider_payment_id?: string | null;
  paid_at?: string | null;
}) {
  if (input.provider_payment_id) {
    const existing = await one<any>(
      env.DB,
      "SELECT * FROM payments WHERE provider=? AND provider_payment_id=?",
      input.provider,
      input.provider_payment_id
    );
    if (existing) return existing;
  }
  const paymentId = id("pay");
  await env.DB.prepare(
    `INSERT INTO payments(id,customer_id,subscription_id,invoice_id,amount,currency,status,provider,provider_payment_id,paid_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    paymentId,
    input.customer_id,
    input.subscription_id ?? null,
    input.invoice_id ?? null,
    input.amount,
    (input.currency ?? "SEK").toUpperCase(),
    input.status,
    input.provider,
    input.provider_payment_id ?? null,
    input.paid_at ?? null
  ).run();
  await audit(
    env,
    input.provider === "STRIPE" || input.provider === "FORTNOX" ? input.provider : "SYSTEM",
    null,
    "PAYMENT_CREATED",
    "payment",
    paymentId,
    null,
    input
  );
  return one<any>(env.DB, "SELECT * FROM payments WHERE id=?", paymentId);
}

export async function recordPaymentAttempt(env: Env, input: {
  payment_id: string;
  provider: "STRIPE" | "FORTNOX" | "BANK" | "MANUAL";
  provider_attempt_id?: string | null;
  status: string;
  error_message?: string | null;
  payload_json?: unknown;
}) {
  if (input.provider_attempt_id) {
    const existing = await one<any>(
      env.DB,
      "SELECT * FROM payment_attempts WHERE provider=? AND provider_attempt_id=?",
      input.provider,
      input.provider_attempt_id
    );
    if (existing) return existing;
  }
  const attemptId = id("patt");
  await env.DB.prepare(
    `INSERT INTO payment_attempts(id,payment_id,provider,provider_attempt_id,status,error_message,payload_json)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    attemptId,
    input.payment_id,
    input.provider,
    input.provider_attempt_id ?? null,
    input.status,
    input.error_message ?? null,
    input.payload_json ? JSON.stringify(input.payload_json) : null
  ).run();
  return one<any>(env.DB, "SELECT * FROM payment_attempts WHERE id=?", attemptId);
}

export async function createAccountingEvent(env: Env, input: {
  event_type: "INVOICE_CREATED" | "INVOICE_CREDITED" | "PAYMENT_RECEIVED" | "PAYMENT_REFUNDED" | "SUBSCRIPTION_PAYMENT_RECEIVED" | "SUPPLIER_INVOICE_REGISTERED";
  entity_type: string;
  entity_id: string;
  currency: string;
  net_amount: number;
  vat_amount: number;
  gross_amount: number;
  status?: "PENDING" | "READY" | "EXPORTED" | "FAILED";
  payload?: unknown;
  occurred_at?: string;
}) {
  const existing = await one<any>(
    env.DB,
    "SELECT * FROM accounting_events WHERE event_type=? AND entity_type=? AND entity_id=?",
    input.event_type,
    input.entity_type,
    input.entity_id
  );
  if (existing) return existing;
  const eventId = id("acct");
  await env.DB.prepare(
    `INSERT INTO accounting_events(id,event_type,entity_type,entity_id,occurred_at,currency,net_amount,vat_amount,gross_amount,status,payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    eventId,
    input.event_type,
    input.entity_type,
    input.entity_id,
    input.occurred_at ?? new Date().toISOString(),
    input.currency.toUpperCase(),
    input.net_amount,
    input.vat_amount,
    input.gross_amount,
    input.status ?? "READY",
    input.payload ? JSON.stringify(input.payload) : null
  ).run();
  return one<any>(env.DB, "SELECT * FROM accounting_events WHERE id=?", eventId);
}

export async function audit(
  env: Env,
  actorType: "USER" | "SYSTEM" | "STRIPE" | "FORTNOX",
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  metadata?: unknown
) {
  await env.DB.prepare(
    `INSERT INTO audit_log(id,actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    id("aud"),
    actorType,
    actorId,
    action,
    entityType,
    entityId,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    metadata ? JSON.stringify(metadata) : null
  ).run();
}
