import { randomBytes } from "node:crypto";

import { Type } from "typebox";

import type { AgPayClient } from "./client.js";
import { safeCheckoutErrorCode } from "./checkout-safety.js";
import { validateManagedCheckoutUrl } from "./checkout-url.js";
import type { AgPayPluginConfig } from "./config.js";
import type {
  BillingPeriod,
  CartItemRead,
  CheckoutExecutionStatus,
} from "./types.js";

const CurrencySchema = Type.String({ pattern: "^[A-Z]{3}$" });
const MoneySchema = Type.String({
  pattern:
    "^(?:0\\.(?:[1-9]|0[1-9]|[1-9][0-9])|[1-9][0-9]{0,17}|[1-9][0-9]{0,16}\\.[0-9]|[1-9][0-9]{0,15}\\.[0-9]{2})$",
});
const UuidSchema = Type.String({ format: "uuid" });
const HttpUrlSchema = Type.String({ format: "uri", pattern: "^https?://" });
const HttpsUrlSchema = Type.String({ format: "uri", pattern: "^https://", maxLength: 2_048 });
const CheckoutAdapterSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
const NonWhitespaceSchema = { pattern: "\\S" } as const;

export interface RequestPurchaseParameters {
  title: string;
  description: string;
  product_url: string;
  merchant?: string;
  reason: string;
  quantity?: number;
  unit_price: string;
  currency: string;
  billing_period?: BillingPeriod | null;
  account_email: string;
  account_login_url?: string;
  checkout_adapter: string;
  checkout_url: string;
}

export interface GetPurchaseRequestParameters {
  request_id: string;
}

export interface RecordPurchaseResultParameters {
  request_id: string;
  provider_reference: string;
  receipt_url?: string;
  next_billing_at?: string;
}

export interface PurchaseRequestResult {
  request_id: string;
  status: CartItemRead["status"];
  title: string;
  total_amount: string;
  currency: string;
  billing_period: BillingPeriod | null;
  checkout_adapter: string | null;
  checkout_url: string | null;
  human_review_required: boolean;
  execution: {
    status: CheckoutExecutionStatus;
    attempt_count: number;
    approved_amount: string;
    currency: string;
    error_code: string | null;
    submitted_at: string | null;
    completed_at: string | null;
  } | null;
  approved_at: string | null;
  created_at: string;
  next_action:
    | "wait_for_human_approval"
    | "wait_for_agpay_checkout"
    | "review_checkout_failure_in_agpay"
    | "human_action_required_in_agpay"
    | "reconcile_checkout_outcome_in_agpay"
    | "stop_cancelled"
    | "none_completed";
}

export type ClientFactory = () => { client: AgPayClient; config: AgPayPluginConfig };

export function hasManagedCheckout(result: PurchaseRequestResult): boolean {
  return result.checkout_adapter !== null && result.checkout_url !== null;
}

function nextAction(item: CartItemRead): PurchaseRequestResult["next_action"] {
  switch (item.execution?.status) {
    case "queued":
    case "running":
      return "wait_for_agpay_checkout";
    case "succeeded":
      return "none_completed";
    case "failed":
      return "review_checkout_failure_in_agpay";
    case "action_required":
      return "human_action_required_in_agpay";
    case "outcome_unknown":
      return "reconcile_checkout_outcome_in_agpay";
  }
  switch (item.status) {
    case "proposed":
      return "wait_for_human_approval";
    case "approved":
      return "wait_for_agpay_checkout";
    case "cancelled":
      return "stop_cancelled";
    case "purchased":
      return "none_completed";
  }
}

export function safePurchaseRequest(item: CartItemRead): PurchaseRequestResult {
  const execution = item.execution;
  return {
    request_id: item.id,
    status: item.status,
    title: item.title,
    total_amount: item.total_amount,
    currency: item.currency,
    billing_period: item.billing_period,
    checkout_adapter: item.checkout_adapter,
    checkout_url: item.checkout_url,
    human_review_required:
      item.status === "proposed" ||
      execution?.status === "action_required" ||
      execution?.status === "outcome_unknown",
    execution: execution
      ? {
          status: execution.status,
          attempt_count: execution.attempt_count,
          approved_amount: execution.approved_amount,
          currency: execution.currency,
          error_code: safeCheckoutErrorCode(execution.error_code),
          submitted_at: execution.submitted_at,
          completed_at: execution.completed_at,
        }
      : null,
    approved_at: item.approved_at,
    created_at: item.created_at,
    next_action: nextAction(item),
  };
}

export async function requestPurchase(
  client: AgPayClient,
  parameters: RequestPurchaseParameters,
): Promise<PurchaseRequestResult> {
  if (parameters.checkout_adapter === undefined || parameters.checkout_url === undefined) {
    throw new Error(
      "OpenClaw purchase requests require both checkout_adapter and checkout_url",
    );
  }
  validateManagedCheckoutUrl(parameters.checkout_adapter, parameters.checkout_url);
  if (parameters.billing_period != null) {
    throw new Error(
      "AG Pay managed checkout supports one-time purchases only; billing_period must be null or omitted",
    );
  }
  const generatedMerchantPassword = randomBytes(24).toString("base64url");
  const item = await client.requestPurchase({
    title: parameters.title,
    description: parameters.description,
    product_url: parameters.product_url,
    ...(parameters.merchant === undefined ? {} : { merchant: parameters.merchant }),
    reason: parameters.reason,
    quantity: parameters.quantity ?? 1,
    unit_price: parameters.unit_price,
    currency: parameters.currency.toUpperCase(),
    billing_period: parameters.billing_period ?? null,
    account: {
      email: parameters.account_email,
      password: generatedMerchantPassword,
      ...(parameters.account_login_url === undefined
        ? {}
        : { login_url: parameters.account_login_url }),
    },
    checkout: {
      adapter: parameters.checkout_adapter,
      checkout_url: parameters.checkout_url,
    },
  });
  return safePurchaseRequest(item);
}

export async function getPurchaseRequest(
  client: AgPayClient,
  parameters: GetPurchaseRequestParameters,
): Promise<PurchaseRequestResult> {
  return safePurchaseRequest(await client.getPurchaseRequest(parameters.request_id));
}

export async function recordPurchaseResult(
  client: AgPayClient,
  config: AgPayPluginConfig,
  parameters: RecordPurchaseResultParameters,
): Promise<{
  purchase_id: string;
  request_id: string;
  status: string;
  amount: string;
  currency: string;
  purchased_at: string;
}> {
  if (!config.allowSandboxCompletion) {
    throw new Error(
      "AG Pay sandbox result recording is disabled. An operator must enable allowSandboxCompletion.",
    );
  }
  const request = await client.getPurchaseRequest(parameters.request_id);
  if (request.execution !== null) {
    throw new Error(
      "AG Pay legacy sandbox result recording is unavailable for a platform-managed checkout",
    );
  }
  if (request.status !== "approved") {
    throw new Error("AG Pay purchase result can only be recorded for an approved request");
  }
  if (parameters.next_billing_at !== undefined && request.billing_period === null) {
    throw new Error("next_billing_at is only valid for an approved recurring request");
  }
  const purchase = await client.recordPurchaseResult(parameters.request_id, {
    amount: request.total_amount,
    currency: request.currency,
    provider_reference: parameters.provider_reference,
    ...(parameters.receipt_url === undefined ? {} : { receipt_url: parameters.receipt_url }),
    ...(parameters.next_billing_at === undefined
      ? {}
      : { next_billing_at: parameters.next_billing_at }),
  });
  return {
    purchase_id: purchase.id,
    request_id: purchase.cart_item_id,
    status: purchase.status,
    amount: purchase.amount,
    currency: purchase.currency,
    purchased_at: purchase.purchased_at,
  };
}

const PurchaseRequestOutputSchema = Type.Object(
  {
    request_id: UuidSchema,
    status: Type.Union([
      Type.Literal("proposed"),
      Type.Literal("approved"),
      Type.Literal("cancelled"),
      Type.Literal("purchased"),
    ]),
    title: Type.String(),
    total_amount: MoneySchema,
    currency: CurrencySchema,
    billing_period: Type.Union([Type.Literal("monthly"), Type.Literal("yearly"), Type.Null()]),
    checkout_adapter: Type.Union([CheckoutAdapterSchema, Type.Null()]),
    checkout_url: Type.Union([HttpsUrlSchema, Type.Null()]),
    human_review_required: Type.Boolean(),
    execution: Type.Union([
      Type.Object(
        {
          status: Type.Union([
            Type.Literal("queued"),
            Type.Literal("running"),
            Type.Literal("succeeded"),
            Type.Literal("failed"),
            Type.Literal("action_required"),
            Type.Literal("outcome_unknown"),
          ]),
          attempt_count: Type.Integer({ minimum: 0 }),
          approved_amount: MoneySchema,
          currency: CurrencySchema,
          error_code: Type.Union([CheckoutAdapterSchema, Type.Null()]),
          submitted_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
          completed_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    approved_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    created_at: Type.String({ format: "date-time" }),
    next_action: Type.Union([
      Type.Literal("wait_for_human_approval"),
      Type.Literal("wait_for_agpay_checkout"),
      Type.Literal("review_checkout_failure_in_agpay"),
      Type.Literal("human_action_required_in_agpay"),
      Type.Literal("reconcile_checkout_outcome_in_agpay"),
      Type.Literal("stop_cancelled"),
      Type.Literal("none_completed"),
    ]),
  },
  { additionalProperties: false },
);

function jsonToolResult(details: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

export function createRequestPurchaseTool(
  getClient: ClientFactory,
  options: {
    onRequestCreated?: (result: PurchaseRequestResult) => void | Promise<void>;
  } = {},
) {
  return {
    name: "agpay_request_purchase",
    label: "Request purchase approval",
    description:
      "Create a supervised AG Pay managed-checkout request for a one-time purchase; omit billing_period or set it to null. Before calling this tool, navigate from the exact offer to its checkout and capture the complete offer-specific URL. Copy title verbatim from that checkout's visible product summary; never synthesize, prepend, or append merchant, storefront, page, playground, or other branding. Always pass both checkout_adapter and checkout_url. For stripe-hosted, checkout_url must be the complete Stripe test Checkout Session URL beginning https://checkout.stripe.com/c/pay/cs_test_, including its existing fragment; never use the generic https://checkout.stripe.com/ root, a Payment Link, or a URL for another offer. Use only an adapter known to be configured by the AG Pay operator. After human approval, AG Pay may execute checkout without exposing payment credentials to the model. Call only after product, merchant, quantity, and exact price are known.",
    parameters: Type.Object(
      {
        title: Type.String({
          description:
            "Exact product-summary title visible in the selected checkout, copied verbatim. Never add merchant, storefront, page, playground, or other branding.",
          minLength: 1,
          maxLength: 255,
          ...NonWhitespaceSchema,
        }),
        description: Type.String({ minLength: 1, maxLength: 10_000, ...NonWhitespaceSchema }),
        product_url: HttpUrlSchema,
        merchant: Type.Optional(
          Type.String({ minLength: 1, maxLength: 255, ...NonWhitespaceSchema }),
        ),
        reason: Type.String({ minLength: 1, maxLength: 10_000, ...NonWhitespaceSchema }),
        quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000, default: 1 })),
        unit_price: MoneySchema,
        currency: CurrencySchema,
        billing_period: Type.Optional(
          Type.Union([Type.Literal("monthly"), Type.Literal("yearly"), Type.Null()]),
        ),
        account_email: Type.String({ format: "email" }),
        account_login_url: Type.Optional(HttpUrlSchema),
        checkout_adapter: CheckoutAdapterSchema,
        checkout_url: HttpsUrlSchema,
      },
      { additionalProperties: false },
    ),
    outputSchema: PurchaseRequestOutputSchema,
    async execute(_toolCallId: string, parameters: RequestPurchaseParameters) {
      const { client } = getClient();
      const result = await requestPurchase(client, parameters);
      if (hasManagedCheckout(result)) {
        await options.onRequestCreated?.(result);
      }
      return jsonToolResult(result);
    },
  };
}

export function createGetPurchaseRequestTool(getClient: ClientFactory) {
  return {
    name: "agpay_get_purchase_request",
    label: "Check purchase request",
    description:
      "Read the approval and sanitized managed-checkout status of one request belonging to this paired agent. It cannot approve, cancel, or reveal payment or browser credentials.",
    parameters: Type.Object(
      { request_id: UuidSchema },
      { additionalProperties: false },
    ),
    outputSchema: PurchaseRequestOutputSchema,
    async execute(_toolCallId: string, parameters: GetPurchaseRequestParameters) {
      const { client } = getClient();
      return jsonToolResult(await getPurchaseRequest(client, parameters));
    },
  };
}

export function createRecordPurchaseResultTool(getClient: ClientFactory) {
  return {
    name: "agpay_record_purchase_result",
    label: "Record legacy sandbox purchase result",
    description:
      "Legacy test-only tool for recording a sandbox result when no AG Pay managed checkout exists. It never executes payment and refuses platform-managed requests. Never call after a timeout or ambiguous merchant outcome.",
    parameters: Type.Object(
      {
        request_id: UuidSchema,
        provider_reference: Type.String({
          minLength: 1,
          maxLength: 255,
          ...NonWhitespaceSchema,
        }),
        receipt_url: Type.Optional(HttpUrlSchema),
        next_billing_at: Type.Optional(Type.String({ format: "date-time" })),
      },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        purchase_id: UuidSchema,
        request_id: UuidSchema,
        status: Type.String(),
        amount: MoneySchema,
        currency: CurrencySchema,
        purchased_at: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId: string, parameters: RecordPurchaseResultParameters) {
      const { client, config } = getClient();
      return jsonToolResult(await recordPurchaseResult(client, config, parameters));
    },
  };
}
