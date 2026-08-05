import type { CartItemRead, PurchaseRead } from "../src/types.js";

export const AGENT_ID = "11111111-1111-4111-8111-111111111111";
export const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
export const PAYMENT_METHOD_ID = "33333333-3333-4333-8333-333333333333";
export const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
export const PURCHASE_ID = "55555555-5555-4555-8555-555555555555";

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
    approved_at: null,
    cancelled_at: null,
    created_at: "2026-08-05T10:00:00.000Z",
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
