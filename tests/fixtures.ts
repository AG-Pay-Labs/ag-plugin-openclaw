import type {
  CartItemRead,
  CheckoutEventRead,
  CheckoutExecutionRead,
  PurchaseRead,
} from "../src/types.js";

export const AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
export const PAYMENT_METHOD_ID = "33333333-3333-4333-8333-333333333333";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
export const PURCHASE_ID = "55555555-5555-4555-8555-555555555555";
export const EXECUTION_ID = "66666666-6666-4666-8666-666666666666";
export const EVENT_ID = "77777777-7777-4777-8777-777777777777";

export function cartItem(overrides: Partial<CartItemRead> = {}): CartItemRead {
  return {
    id: REQUEST_ID,
    agent_id: AGENT_ID,
    credential_id: CREDENTIAL_ID,
    selected_payment_method_id: null,
    title: "Annual reporting plan",
    description: "Reporting software for the finance team",
    product_url: "https://merchant.example/products/reporting",
    merchant: "Example Merchant",
    reason: "Required for quarterly reporting",
    quantity: 2,
    unit_price: "12.50",
    total_amount: "25.00",
    currency: "EUR",
    billing_period: null,
    status: "proposed",
    decision_note: null,
    account_email: "agent@example.com",
    login_url: "https://merchant.example/login",
    checkout_adapter: null,
    checkout_url: null,
    execution: null,
    approved_at: null,
    cancelled_at: null,
    created_at: "2026-08-05T10:00:00.000Z",
    ...overrides,
  };
}

export function checkoutExecution(
  overrides: Partial<CheckoutExecutionRead> = {},
): CheckoutExecutionRead {
  return {
    id: EXECUTION_ID,
    status: "queued",
    attempt_count: 0,
    approved_amount: "25.00",
    currency: "EUR",
    checkout_origin: "https://merchant.example",
    error_code: null,
    error_message: null,
    submitted_at: null,
    completed_at: null,
    created_at: "2026-08-05T10:15:00.000Z",
    updated_at: "2026-08-05T10:15:00.000Z",
    ...overrides,
  };
}

export function checkoutEvent(overrides: Partial<CheckoutEventRead> = {}): CheckoutEventRead {
  return {
    cursor: 1,
    event_id: EVENT_ID,
    request_id: REQUEST_ID,
    status: "succeeded",
    purchase_id: PURCHASE_ID,
    amount: "25.00",
    currency: "EUR",
    error_code: null,
    occurred_at: "2026-08-05T10:30:00.000Z",
    ...overrides,
  };
}

export function purchase(overrides: Partial<PurchaseRead> = {}): PurchaseRead {
  return {
    id: PURCHASE_ID,
    cart_item_id: REQUEST_ID,
    agent_id: AGENT_ID,
    payment_method_id: PAYMENT_METHOD_ID,
    title: "Annual reporting plan",
    description: "Reporting software for the finance team",
    product_url: "https://merchant.example/products/reporting",
    status: "completed",
    amount: "25.00",
    currency: "EUR",
    provider_reference: "merchant-reference-123",
    receipt_url: "https://merchant.example/receipts/123",
    account_email: "agent@example.com",
    purchased_at: "2026-08-05T10:30:00.000Z",
    subscription: null,
    ...overrides,
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function jsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  return JSON.parse(init.body) as unknown;
}
