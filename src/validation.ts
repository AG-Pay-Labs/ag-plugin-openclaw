import type {
  AgentHeartbeatResponse,
  AgentTokenResponse,
  BillingPeriod,
  CartItemRead,
  CartItemStatus,
  PurchaseRead,
  SubscriptionRead,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^(?:0\.(?:[1-9]|0[1-9]|[1-9][0-9])|[1-9][0-9]{0,17}|[1-9][0-9]{0,16}\.[0-9]|[1-9][0-9]{0,15}\.[0-9]{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AGENT_TOKEN_PATTERN = /^agt_[A-Za-z0-9_-]+$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function nullableString(value: unknown, label: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function uuid(value: unknown, label: string): asserts value is string {
  string(value, label);
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function timestamp(value: unknown, label: string): asserts value is string {
  string(value, label);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function nullableTimestamp(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    timestamp(value, label);
  }
}

function money(value: unknown, label: string): asserts value is string {
  string(value, label);
  if (!MONEY_PATTERN.test(value)) {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function currency(value: unknown, label: string): asserts value is string {
  string(value, label);
  if (!CURRENCY_PATTERN.test(value)) {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function cartStatus(value: unknown): asserts value is CartItemStatus {
  if (!new Set(["proposed", "approved", "cancelled", "purchased"]).has(String(value))) {
    throw new Error("AG Pay API returned an invalid cart item status");
  }
}

function billingPeriod(value: unknown): asserts value is BillingPeriod | null {
  if (value !== null && value !== "monthly" && value !== "yearly") {
    throw new Error("AG Pay API returned an invalid billing period");
  }
}

export function validateAgentTokenResponse(value: unknown): asserts value is AgentTokenResponse {
  const data = record(value, "pairing response");
  uuid(data.agent_id, "agent ID");
  string(data.agent_access_token, "agent credential");
  if (
    data.agent_access_token.length < 20 ||
    data.agent_access_token.length > 200 ||
    !AGENT_TOKEN_PATTERN.test(data.agent_access_token)
  ) {
    throw new Error("AG Pay API returned an invalid agent credential");
  }
  if (data.token_type !== "bearer") {
    throw new Error("AG Pay API returned an invalid token type");
  }
  timestamp(data.expires_at, "agent credential expiry");
}

export function validateHeartbeatResponse(value: unknown): asserts value is AgentHeartbeatResponse {
  const data = record(value, "heartbeat response");
  uuid(data.agent_id, "agent ID");
  if (data.connection_state !== "online") {
    throw new Error("AG Pay API returned an invalid connection state");
  }
  timestamp(data.server_time, "server time");
}

export function validateCartItem(value: unknown): asserts value is CartItemRead {
  const data = record(value, "purchase request");
  uuid(data.id, "purchase request ID");
  uuid(data.agent_id, "agent ID");
  uuid(data.credential_id, "credential ID");
  if (data.selected_payment_method_id !== null) {
    uuid(data.selected_payment_method_id, "selected payment method ID");
  }
  string(data.title, "purchase title");
  string(data.description, "purchase description");
  string(data.product_url, "product URL");
  nullableString(data.merchant, "merchant");
  string(data.reason, "purchase reason");
  if (!Number.isInteger(data.quantity) || (data.quantity as number) < 1) {
    throw new Error("AG Pay API returned an invalid quantity");
  }
  money(data.unit_price, "unit price");
  money(data.total_amount, "total amount");
  currency(data.currency, "currency");
  billingPeriod(data.billing_period);
  cartStatus(data.status);
  nullableString(data.decision_note, "decision note");
  string(data.account_email, "merchant account email");
  nullableString(data.login_url, "merchant login URL");
  nullableTimestamp(data.approved_at, "approval timestamp");
  nullableTimestamp(data.cancelled_at, "cancellation timestamp");
  timestamp(data.created_at, "creation timestamp");
}

export function validateCartItemList(value: unknown): asserts value is CartItemRead[] {
  if (!Array.isArray(value)) {
    throw new Error("AG Pay API returned an invalid purchase request list");
  }
  for (const item of value) {
    validateCartItem(item);
  }
}

function validateSubscription(value: unknown): asserts value is SubscriptionRead {
  const data = record(value, "subscription");
  uuid(data.id, "subscription ID");
  uuid(data.purchase_id, "purchase ID");
  uuid(data.agent_id, "agent ID");
  string(data.title, "subscription title");
  billingPeriod(data.billing_period);
  if (data.billing_period === null) {
    throw new Error("AG Pay API returned an invalid subscription billing period");
  }
  if (!new Set(["active", "paused", "cancelled"]).has(String(data.status))) {
    throw new Error("AG Pay API returned an invalid subscription status");
  }
  money(data.amount, "subscription amount");
  currency(data.currency, "subscription currency");
  nullableTimestamp(data.next_billing_at, "next billing timestamp");
  timestamp(data.created_at, "subscription creation timestamp");
}

export function validatePurchase(value: unknown): asserts value is PurchaseRead {
  const data = record(value, "purchase result");
  uuid(data.id, "purchase ID");
  uuid(data.cart_item_id, "purchase request ID");
  uuid(data.agent_id, "agent ID");
  uuid(data.payment_method_id, "payment method ID");
  string(data.title, "purchase title");
  string(data.description, "purchase description");
  string(data.product_url, "product URL");
  if (!new Set(["completed", "failed", "refunded"]).has(String(data.status))) {
    throw new Error("AG Pay API returned an invalid purchase status");
  }
  money(data.amount, "purchase amount");
  currency(data.currency, "purchase currency");
  string(data.provider_reference, "provider reference");
  nullableString(data.receipt_url, "receipt URL");
  string(data.account_email, "merchant account email");
  timestamp(data.purchased_at, "purchase timestamp");
  if (data.subscription !== null) {
    validateSubscription(data.subscription);
  }
}
