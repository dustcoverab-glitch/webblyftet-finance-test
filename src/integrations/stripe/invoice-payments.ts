import type Stripe from "stripe";

export type StripeInvoicePaymentDetails = {
  invoice_payment_id: string | null;
  payment_intent_id: string | null;
  payment_intent: Stripe.PaymentIntent | null;
  status: string | null;
};

type InvoiceWithPayments = Stripe.Invoice & {
  payments?: {
    data?: Array<{
      id?: string;
      is_default?: boolean;
      status?: string;
      payment?: {
        type?: string;
        payment_intent?: string | Stripe.PaymentIntent | null;
      } | null;
    }>;
  } | null;
};

export function invoicePaymentFromInvoice(invoice: Stripe.Invoice): StripeInvoicePaymentDetails | null {
  const payments = (invoice as InvoiceWithPayments).payments?.data ?? [];
  const payment = payments.find((item) => item.is_default) ?? payments[0];
  return payment ? invoicePaymentDetails(payment) : null;
}

export async function retrieveInvoicePaymentDetails(
  stripe: Stripe,
  invoice: Stripe.Invoice | string
): Promise<StripeInvoicePaymentDetails | null> {
  if (typeof invoice !== "string") {
    const embedded = invoicePaymentFromInvoice(invoice);
    if (embedded) return embedded;
  }
  const invoiceId = typeof invoice === "string" ? invoice : invoice.id;
  const payments = await stripe.invoicePayments.list({
    invoice: invoiceId,
    limit: 10,
    expand: ["data.payment.payment_intent"]
  });
  const payment = payments.data.find((item) => item.is_default) ?? payments.data[0];
  return payment ? invoicePaymentDetails(payment) : null;
}

function invoicePaymentDetails(payment: {
  id?: string;
  status?: string;
  payment?: {
    type?: string;
    payment_intent?: string | Stripe.PaymentIntent | null;
  } | null;
}): StripeInvoicePaymentDetails {
  const paymentIntent = payment.payment?.payment_intent;
  return {
    invoice_payment_id: payment.id ?? null,
    payment_intent_id: typeof paymentIntent === "string" ? paymentIntent : paymentIntent?.id ?? null,
    payment_intent: typeof paymentIntent === "object" && paymentIntent !== null ? paymentIntent : null,
    status: payment.status ?? null
  };
}
