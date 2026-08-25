export type CustomerOrderLoadStatus = "loading" | "loaded" | "invalid" | "expired" | "server_error";

export type CustomerOrderRequirements = {
  signing_required: boolean;
  payment_method_required: boolean;
  activation_required: boolean;
};

export type CustomerOrderView = {
  snapshot: Record<string, any>;
  customer: Record<string, any>;
  offer: Record<string, any>;
  totals: Record<string, any>;
  oneTimeRows: Record<string, any>[];
  recurringRows: Record<string, any>[];
  requirements: CustomerOrderRequirements;
  invoices: any[];
  subscriptions: any[];
  paymentMethod: Record<string, any> | null;
  documentHash: string;
  currentStep: number;
};

export function customerOrderRenderFallbackCopy() {
  return {
    title: "Vi kunde inte visa din beställning",
    text: "Försök ladda om sidan eller kontakta Webblyftet."
  };
}

export function classifyCustomerOrderLoadError(error: unknown): { status: Exclude<CustomerOrderLoadStatus, "loading" | "loaded">; message: string } {
  const message = error instanceof Error ? error.message : "Kundlänken kunde inte laddas.";
  const normalized = message.toLowerCase();
  if (normalized.includes("gått ut") || normalized.includes("expired")) {
    return { status: "expired", message: "Kundlänken har gått ut. Kontakta Webblyftet för en ny länk." };
  }
  if (normalized.includes("ogiltig") || normalized.includes("invalid") || normalized.includes("not found")) {
    return { status: "invalid", message: "Kundlänken är ogiltig. Kontrollera länken eller kontakta Webblyftet." };
  }
  return { status: "server_error", message: "Ordern kunde inte laddas just nu. Försök igen om en stund." };
}

export function customerOrderRows(rows: unknown, type: "ONE_TIME" | "RECURRING") {
  return asArray(rows).map(asRecord).filter((row) => row.billing_type === type);
}

export function normalizeCustomerOrderView(session: unknown): CustomerOrderView {
  const raw = asRecord(session);
  const snapshot = asRecord(raw.snapshot);
  const customer = asRecord(snapshot.customer);
  const offer = asRecord(snapshot.offer);
  const totals = asRecord(snapshot.totals);
  const oneTimeRows = customerOrderRows(snapshot.rows, "ONE_TIME");
  const recurringRows = customerOrderRows(snapshot.rows, "RECURRING");
  const requirementsRaw = asRecord(raw.requirements);
  const paymentMethod = isRecord(raw.payment_method) ? raw.payment_method : null;
  const requirements = {
    signing_required: booleanOr(requirementsRaw.signing_required, !raw.signed_at),
    payment_method_required: booleanOr(requirementsRaw.payment_method_required, recurringRows.length > 0 && !paymentMethod),
    activation_required: booleanOr(requirementsRaw.activation_required, !raw.completed_at)
  };
  const invoices = asArray(raw.invoices);
  const subscriptions = asArray(raw.subscriptions);
  const documentHash = typeof raw.document_hash === "string" ? raw.document_hash : "";
  const currentStep = raw.completed_at
    ? 4
    : requirements.activation_required && !requirements.payment_method_required
      ? 3
      : requirements.payment_method_required
        ? 2
        : raw.signed_at
          ? 3
          : raw.reviewed_at
            ? 1
            : 0;

  return {
    snapshot,
    customer,
    offer,
    totals,
    oneTimeRows,
    recurringRows,
    requirements,
    invoices,
    subscriptions,
    paymentMethod,
    documentHash,
    currentStep
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, any> {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}
