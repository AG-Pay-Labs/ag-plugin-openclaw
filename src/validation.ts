import type {
  AgentHeartbeatResponse,
  AgentTokenResponse,
  BillingPeriod,
  CartItemRead,
  CartItemStatus,
  CheckoutEventPage,
  CheckoutEventRead,
  CheckoutExecutionRead,
  CheckoutExecutionStatus,
  PurchaseRead,
  SubscriptionRead,
} from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^(?:0\.(?:[1-9]|0[1-9]|[1-9][0-9])|[1-9][0-9]{0,17}|[1-9][0-9]{0,16}\.[0-9]|[1-9][0-9]{0,15}\.[0-9]{2})$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AGENT_TOKEN_PATTERN = /^agt_[A-Za-z0-9_-]+$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SAFE_URL_LENGTH = 2_048;

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

function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is string {
  string(value, label);
  if (value.length < minimum || value.length > maximum) {
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

function nullableUuid(value: unknown, label: string): asserts value is string | null {
  if (value !== null) {
    uuid(value, label);
  }
}

function nullableSafeCode(value: unknown, label: string): asserts value is string | null {
  if (value === null) {
    return;
  }
  boundedString(value, label, 1, 64);
  if (!SAFE_CODE_PATTERN.test(value)) {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
}

function nullableHttpUrl(value: unknown, label: string): asserts value is string | null {
  if (value === null) {
    return;
  }
  boundedString(value, label, 1, MAX_SAFE_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`AG Pay API returned an invalid ${label}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`AG Pay API returned an invalid ${label}`);
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

function checkoutStatus(value: unknown): asserts value is CheckoutExecutionStatus {
  if (
    !new Set([
      "queued",
      "running",
      "succeeded",
      "failed",
      "action_required",
      "outcome_unknown",
    ]).has(String(value))
  ) {
    throw new Error("AG Pay API returned an invalid checkout execution status");
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
  nullableSafeCode(data.checkout_adapter, "checkout adapter");
  nullableHttpUrl(data.checkout_url, "checkout URL");
  if (data.execution !== null) {
    validateCheckoutExecution(data.execution);
  }
  nullableTimestamp(data.approved_at, "approval timestamp");
  nullableTimestamp(data.cancelled_at, "cancellation timestamp");
  timestamp(data.created_at, "creation timestamp");
}

export function validateCheckoutExecution(
  value: unknown,
): asserts value is CheckoutExecutionRead {
  const data = record(value, "checkout execution");
  uuid(data.id, "checkout execution ID");
  checkoutStatus(data.status);
  if (
    !Number.isSafeInteger(data.attempt_count) ||
    (data.attempt_count as number) < 0 ||
    (data.attempt_count as number) > 1_000_000
  ) {
    throw new Error("AG Pay API returned an invalid checkout attempt count");
  }
  money(data.approved_amount, "approved checkout amount");
  currency(data.currency, "checkout currency");
  boundedString(data.checkout_origin, "checkout origin", 1, MAX_SAFE_URL_LENGTH);
  nullableSafeCode(data.error_code, "checkout error code");
  if (data.error_message !== null) {
    boundedString(data.error_message, "checkout error message", 1, 2_000);
  }
  nullableTimestamp(data.submitted_at, "checkout submission timestamp");
  nullableTimestamp(data.completed_at, "checkout completion timestamp");
  timestamp(data.created_at, "checkout creation timestamp");
  timestamp(data.updated_at, "checkout update timestamp");
}

function validateCheckoutEvent(value: unknown): asserts value is CheckoutEventRead {
  const data = record(value, "checkout event");
  if (!Number.isSafeInteger(data.cursor) || (data.cursor as number) < 0) {
    throw new Error("AG Pay API returned an invalid checkout event cursor");
  }
  uuid(data.event_id, "checkout event ID");
  uuid(data.request_id, "purchase request ID");
  checkoutStatus(data.status);
  nullableUuid(data.purchase_id, "purchase ID");
  if (data.status === "succeeded" && data.purchase_id === null) {
    throw new Error("AG Pay API returned a successful checkout event without a purchase ID");
  }
  money(data.amount, "checkout event amount");
  currency(data.currency, "checkout event currency");
  nullableSafeCode(data.error_code, "checkout error code");
  timestamp(data.occurred_at, "checkout event timestamp");
}

export function validateCheckoutEventPage(value: unknown): asserts value is CheckoutEventPage {
  const data = record(value, "checkout event page");
  if (!Array.isArray(data.events) || data.events.length > 100) {
    throw new Error("AG Pay API returned an invalid checkout event list");
  }
  if (!Number.isSafeInteger(data.next_cursor) || (data.next_cursor as number) < 0) {
    throw new Error("AG Pay API returned an invalid next checkout event cursor");
  }

  let previousCursor = -1;
  for (const event of data.events) {
    validateCheckoutEvent(event);
    if (event.cursor <= previousCursor || event.cursor > (data.next_cursor as number)) {
      throw new Error("AG Pay API returned checkout events out of order");
    }
    previousCursor = event.cursor;
  }
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
