import type { MiddlewareHandler } from "hono";

export type Role = "ADMIN" | "FINANCE" | "SELLER" | "READ_ONLY";

export type Permission =
  | "customers.read"
  | "customers.write"
  | "offers.read"
  | "offers.write"
  | "contract_flow.write"
  | "invoices.read"
  | "invoices.write"
  | "subscriptions.manage"
  | "subscriptions.cancel_immediate"
  | "fortnox.sync"
  | "fortnox.disconnect"
  | "receipts.manage"
  | "bookkeeping.read"
  | "admin.manage";

export type AuthenticatedUser = {
  email: string;
  role: Role;
  permissions: Permission[];
};

export const rolePermissions: Record<Role, Permission[]> = {
  ADMIN: [
    "customers.read",
    "customers.write",
    "offers.read",
    "offers.write",
    "contract_flow.write",
    "invoices.read",
    "invoices.write",
    "subscriptions.manage",
    "subscriptions.cancel_immediate",
    "fortnox.sync",
    "fortnox.disconnect",
    "receipts.manage",
    "bookkeeping.read",
    "admin.manage"
  ],
  FINANCE: [
    "customers.read",
    "offers.read",
    "invoices.read",
    "invoices.write",
    "subscriptions.manage",
    "subscriptions.cancel_immediate",
    "fortnox.sync",
    "receipts.manage",
    "bookkeeping.read"
  ],
  SELLER: [
    "customers.read",
    "customers.write",
    "offers.read",
    "offers.write",
    "contract_flow.write",
    "invoices.read",
    "subscriptions.manage"
  ],
  READ_ONLY: [
    "customers.read",
    "offers.read",
    "invoices.read",
    "bookkeeping.read"
  ]
};

type RoleEnvKey = "ADMIN_EMAILS" | "FINANCE_EMAILS" | "SELLER_EMAILS" | "READ_ONLY_EMAILS";

const roleEnvKeys: Array<[Role, RoleEnvKey]> = [
  ["ADMIN", "ADMIN_EMAILS"],
  ["FINANCE", "FINANCE_EMAILS"],
  ["SELLER", "SELLER_EMAILS"],
  ["READ_ONLY", "READ_ONLY_EMAILS"]
];

function envValue(env: Env, key: string): string {
  return String((env as Env & Record<string, string | undefined>)[key] ?? "");
}

function normalizeEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

function configuredEmails(env: Env, key: RoleEnvKey): Set<string> {
  return new Set(
    envValue(env, key)
      .split(/[,\s]+/)
      .map(normalizeEmail)
      .filter(Boolean)
  );
}

export function roleForEmail(env: Env, email: string | null | undefined): Role {
  const normalized = normalizeEmail(email);
  if (!normalized) return "READ_ONLY";
  for (const [role, key] of roleEnvKeys) {
    if (configuredEmails(env, key).has(normalized)) return role;
  }
  return "READ_ONLY";
}

export function userFromEmail(env: Env, email: string | null | undefined): AuthenticatedUser | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const role = roleForEmail(env, normalized);
  return { email: normalized, role, permissions: rolePermissions[role] };
}

export function hasPermission(user: AuthenticatedUser | null | undefined, permission: Permission): boolean {
  return Boolean(user?.permissions.includes(permission));
}

export function requirePermission(permission: Permission): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const user = ((c as any).get("authenticatedUser") as AuthenticatedUser | undefined) ?? currentUserFromRequest(c.env, c.req.raw.headers, null);
    if (!hasPermission(user, permission)) {
      return c.json({ error: "Behörighet saknas.", code: "FORBIDDEN", required_permission: permission }, 403);
    }
    await next();
  };
}

export function currentUserFromRequest(env: Env, headers: Headers, accessEmail: string | null | undefined): AuthenticatedUser | null {
  const email = accessEmail || (env.APP_ENV === "local" ? headers.get("x-test-user-email") || envValue(env, "LOCAL_DEV_EMAIL") : "");
  return userFromEmail(env, email);
}
