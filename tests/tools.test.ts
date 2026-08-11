import { describe, expect, it, vi } from "vitest";

import { AgPayClient } from "../src/client.js";
import type { AgPayPluginConfig } from "../src/config.js";
import {
  createRequestPurchaseTool,
  getPurchaseRequest,
  hasManagedCheckout,
  type PurchaseRequestResult,
  recordPurchaseResult,
  requestPurchase,
} from "../src/tools.js";

import {
  cartItem,
  checkoutExecution,
  jsonRequestBody,
  jsonResponse,
  purchase,
  REQUEST_ID,
} from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;

function clientWith(fetchImplementation: typeof fetch): AgPayClient {
  return new AgPayClient({
    apiUrl: "https://agpay.example.test",
    agentToken: AGENT_TOKEN,
    fetchImplementation,
  });
}

function config(
  allowSandboxCompletion: boolean,
  checkoutDefaults: Pick<
    AgPayPluginConfig,
    "defaultCheckoutAdapter" | "defaultCheckoutUrl"
  > = {},
): AgPayPluginConfig {
  return {
    apiUrl: "https://agpay.example.test",
    agentToken: AGENT_TOKEN,
    heartbeatIntervalSeconds: 60,
    requestTimeoutMs: 10_000,
    outcomePollIntervalSeconds: 15,
    outcomeDeliveryTarget: "last",
    ...checkoutDefaults,
    allowSandboxCompletion,
  };
}

describe("purchase tool safety", () => {
  it("generates the merchant password internally and exposes it only to the outbound API", async () => {
    let outboundBody: unknown;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
      outboundBody = jsonRequestBody(init);
      return Promise.resolve(jsonResponse(cartItem()));
    });

    const result = await requestPurchase(clientWith(fetchMock), {
      title: "Annual reporting plan",
      description: "Reporting software for the finance team",
      product_url: "https://merchant.example/products/reporting",
      merchant: "Example Merchant",
      reason: "Required for quarterly reporting",
      quantity: 2,
      unit_price: "12.50",
      currency: "eur",
      billing_period: null,
      account_email: "agent@example.com",
      account_login_url: "https://merchant.example/login",
      checkout_adapter: "demo",
      checkout_url: "https://merchant.example/checkout/123",
    });

    expect(outboundBody).toMatchObject({
      currency: "EUR",
      account: {
        email: "agent@example.com",
        login_url: "https://merchant.example/login",
      },
      checkout: {
        adapter: "demo",
        checkout_url: "https://merchant.example/checkout/123",
      },
    });
    const outboundPassword = (outboundBody as { account: { password: unknown } }).account.password;
    expect(outboundPassword).toEqual(expect.any(String));
    expect(String(outboundPassword).length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(result)).not.toContain(String(outboundPassword));
    expect(result).not.toHaveProperty("account");
    expect(result).not.toHaveProperty("credential_id");
  });

  it("requires the managed checkout adapter and URL as a pair before contacting AG Pay", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      requestPurchase(clientWith(fetchMock), {
        title: "Annual reporting plan",
        description: "Reporting software for the finance team",
        product_url: "https://merchant.example/products/reporting",
        reason: "Required for quarterly reporting",
        unit_price: "12.50",
        currency: "EUR",
        account_email: "agent@example.com",
        checkout_adapter: "demo",
      }),
    ).rejects.toThrow(/both checkout_adapter and checkout_url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects a configured checkout pair when product facts omit explicit checkout fields", async () => {
    let outboundBody: unknown;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
      outboundBody = jsonRequestBody(init);
      return Promise.resolve(
        jsonResponse(
          cartItem({
            checkout_adapter: "stripe-hosted",
            checkout_url: "https://checkout.stripe.com/",
          }),
        ),
      );
    });
    const onRequestCreated = vi
      .fn<(result: PurchaseRequestResult) => Promise<void>>()
      .mockResolvedValue();
    const tool = createRequestPurchaseTool(
      () => ({
        client: clientWith(fetchMock),
        config: config(false, {
          defaultCheckoutAdapter: "stripe-hosted",
          defaultCheckoutUrl: "https://checkout.stripe.com/",
        }),
      }),
      { onRequestCreated },
    );

    await tool.execute("tool-call", {
      title: "Desk lamp",
      description: "Adjustable LED desk lamp",
      product_url: "https://merchant.example/products/desk-lamp",
      merchant: "Example Merchant",
      reason: "Needed for the office",
      quantity: 1,
      unit_price: "39.00",
      currency: "EUR",
      account_email: "agent@example.com",
    });

    expect(outboundBody).toMatchObject({
      product_url: "https://merchant.example/products/desk-lamp",
      checkout: {
        adapter: "stripe-hosted",
        checkout_url: "https://checkout.stripe.com/",
      },
    });
    expect(onRequestCreated).toHaveBeenCalledOnce();
  });

  it("keeps an explicit checkout pair authoritative over configured defaults", async () => {
    let outboundBody: unknown;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
      outboundBody = jsonRequestBody(init);
      return Promise.resolve(jsonResponse(cartItem()));
    });

    await requestPurchase(
      clientWith(fetchMock),
      {
        title: "Desk lamp",
        description: "Adjustable LED desk lamp",
        product_url: "https://merchant.example/products/desk-lamp",
        reason: "Needed for the office",
        unit_price: "39.00",
        currency: "EUR",
        account_email: "agent@example.com",
        checkout_adapter: "merchant-specific",
        checkout_url: "https://merchant.example/checkout",
      },
      {
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl: "https://checkout.stripe.com/",
      },
    );

    expect(outboundBody).toMatchObject({
      checkout: {
        adapter: "merchant-specific",
        checkout_url: "https://merchant.example/checkout",
      },
    });
  });

  it("does not complete a partial explicit pair from configured defaults", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      requestPurchase(
        clientWith(fetchMock),
        {
          title: "Desk lamp",
          description: "Adjustable LED desk lamp",
          product_url: "https://merchant.example/products/desk-lamp",
          reason: "Needed for the office",
          unit_price: "39.00",
          currency: "EUR",
          account_email: "agent@example.com",
          checkout_adapter: "merchant-specific",
        },
        {
          defaultCheckoutAdapter: "stripe-hosted",
          defaultCheckoutUrl: "https://checkout.stripe.com/",
        },
      ),
    ).rejects.toThrow(/both checkout_adapter and checkout_url/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps recurring requests approval-only instead of injecting a one-time default", async () => {
    let outboundBody: unknown;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
      outboundBody = jsonRequestBody(init);
      return Promise.resolve(jsonResponse(cartItem({ billing_period: "monthly" })));
    });

    await requestPurchase(
      clientWith(fetchMock),
      {
        title: "Monthly reporting plan",
        description: "Reporting software for the finance team",
        product_url: "https://merchant.example/products/reporting",
        reason: "Required for quarterly reporting",
        unit_price: "12.50",
        currency: "EUR",
        billing_period: "monthly",
        account_email: "agent@example.com",
      },
      {
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl: "https://checkout.stripe.com/",
      },
    );

    expect(outboundBody).not.toHaveProperty("checkout");
  });

  it("rejects recurring billing with managed checkout before contacting AG Pay", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      requestPurchase(clientWith(fetchMock), {
        title: "Monthly reporting plan",
        description: "Reporting software for the finance team",
        product_url: "https://merchant.example/products/reporting",
        reason: "Required for quarterly reporting",
        unit_price: "12.50",
        currency: "EUR",
        billing_period: "monthly",
        account_email: "agent@example.com",
        checkout_adapter: "demo",
        checkout_url: "https://merchant.example/checkout/123",
      }),
    ).rejects.toThrow(/managed checkout.*one-time|billing_period.*null/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts a generated password even when the API echoes it in an error detail", async () => {
    let outboundPassword = "";
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
      const outboundBody = jsonRequestBody(init) as { account: { password: string } };
      outboundPassword = outboundBody.account.password;
      return Promise.resolve(
        jsonResponse({ detail: `Invalid planned credential ${outboundPassword}` }, { status: 422 }),
      );
    });

    const error = await requestPurchase(clientWith(fetchMock), {
      title: "Annual reporting plan",
      description: "Reporting software for the finance team",
      product_url: "https://merchant.example/products/reporting",
      reason: "Required for quarterly reporting",
      unit_price: "12.50",
      currency: "EUR",
      account_email: "agent@example.com",
    }).catch((caught: unknown) => caught);

    expect(outboundPassword).toHaveLength(32);
    expect(String(error)).not.toContain(outboundPassword);
  });

  it("does not contact the API when sandbox completion is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      recordPurchaseResult(clientWith(fetchMock), config(false), {
        request_id: REQUEST_ID,
        provider_reference: "merchant-reference-123",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not record completion unless the server says the request is approved", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(cartItem()));

    await expect(
      recordPurchaseResult(clientWith(fetchMock), config(true), {
        request_id: REQUEST_ID,
        provider_reference: "merchant-reference-123",
      }),
    ).rejects.toThrow(/approved/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a next billing date for a one-time purchase", async () => {
    const approvedOneTimeRequest = cartItem({
      status: "approved",
      approved_at: "2026-08-05T10:15:00.000Z",
      billing_period: null,
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(approvedOneTimeRequest))
      .mockResolvedValueOnce(jsonResponse(purchase()));

    await expect(
      recordPurchaseResult(clientWith(fetchMock), config(true), {
        request_id: REQUEST_ID,
        provider_reference: "merchant-reference-123",
        next_billing_at: "2026-09-05T10:30:00.000Z",
      }),
    ).rejects.toThrow(/billing|recurring|subscription/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("derives completion amount and currency from the approved server record", async () => {
    const approvedRequest = cartItem({
      status: "approved",
      approved_at: "2026-08-05T10:15:00.000Z",
      total_amount: "31.47",
      currency: "GBP",
    });
    let completionBody: unknown;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse(approvedRequest));
      }
      completionBody = jsonRequestBody(init);
      return Promise.resolve(jsonResponse(purchase({ amount: "31.47", currency: "GBP" })));
    });

    await expect(
      recordPurchaseResult(clientWith(fetchMock), config(true), {
        request_id: REQUEST_ID,
        provider_reference: "merchant-reference-123",
        receipt_url: "https://merchant.example/receipts/123",
      }),
    ).resolves.toMatchObject({ amount: "31.47", currency: "GBP" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(completionBody).toEqual({
      amount: "31.47",
      currency: "GBP",
      provider_reference: "merchant-reference-123",
      receipt_url: "https://merchant.example/receipts/123",
    });
  });

  it("refuses legacy completion when the platform owns a managed checkout", async () => {
    const managedRequest = cartItem({
      status: "approved",
      approved_at: "2026-08-05T10:15:00.000Z",
      checkout_adapter: "sandbox",
      checkout_url: "https://merchant.example/checkout",
      execution: checkoutExecution(),
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(managedRequest));

    await expect(
      recordPurchaseResult(clientWith(fetchMock), config(true), {
        request_id: REQUEST_ID,
        provider_reference: "merchant-reference-123",
      }),
    ).rejects.toThrow(/platform-managed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns only the safe execution summary and normalizes unknown error codes", async () => {
    const rawError = "merchant_secret_stacktrace";
    const managedRequest = cartItem({
      status: "approved",
      approved_at: "2026-08-05T10:15:00.000Z",
      checkout_adapter: "sandbox",
      checkout_url: "https://merchant.example/checkout",
      execution: checkoutExecution({
        status: "failed",
        attempt_count: 1,
        error_code: rawError,
        error_message: "raw browser failure containing a card-adjacent secret",
        submitted_at: "2026-08-05T10:16:00.000Z",
        completed_at: "2026-08-05T10:17:00.000Z",
      }),
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(managedRequest));

    const result = await getPurchaseRequest(clientWith(fetchMock), { request_id: REQUEST_ID });

    expect(result).toMatchObject({
      next_action: "review_checkout_failure_in_agpay",
      human_review_required: false,
      execution: { status: "failed", attempt_count: 1, error_code: "checkout_failed" },
    });
    expect(JSON.stringify(result)).not.toContain(rawError);
    expect(JSON.stringify(result)).not.toMatch(/stacktrace|browser failure|checkout_origin/i);
  });

  it("tracks the originating request only after a definite successful creation", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        cartItem({
          checkout_adapter: "demo",
          checkout_url: "https://merchant.example/checkout/123",
        }),
      ),
    );
    const onRequestCreated = vi
      .fn<(result: PurchaseRequestResult) => Promise<void>>()
      .mockResolvedValue();
    const tool = createRequestPurchaseTool(
      () => ({ client: clientWith(fetchMock), config: config(false) }),
      { onRequestCreated },
    );

    await tool.execute("tool-call", {
      title: "Annual reporting plan",
      description: "Reporting software for the finance team",
      product_url: "https://merchant.example/products/reporting",
      reason: "Required for quarterly reporting",
      unit_price: "12.50",
      currency: "EUR",
      account_email: "agent@example.com",
      checkout_adapter: "demo",
      checkout_url: "https://merchant.example/checkout/123",
    });

    expect(onRequestCreated).toHaveBeenCalledOnce();
    const tracked = onRequestCreated.mock.calls[0]?.[0];
    expect(tracked?.request_id).toBe(REQUEST_ID);
    if (!tracked) {
      throw new Error("Expected a managed purchase tracking callback");
    }
    expect(hasManagedCheckout(tracked)).toBe(true);
  });

  it("does not register lifecycle tracking for a successful unmanaged request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(cartItem()));
    const onRequestCreated = vi
      .fn<(result: PurchaseRequestResult) => Promise<void>>()
      .mockResolvedValue();
    const tool = createRequestPurchaseTool(
      () => ({ client: clientWith(fetchMock), config: config(false) }),
      { onRequestCreated },
    );

    await tool.execute("tool-call", {
      title: "Annual reporting plan",
      description: "Reporting software for the finance team",
      product_url: "https://merchant.example/products/reporting",
      reason: "Required for quarterly reporting",
      unit_price: "12.50",
      currency: "EUR",
      account_email: "agent@example.com",
    });

    expect(onRequestCreated).not.toHaveBeenCalled();
  });

  it("does not track a request after an ambiguous creation outcome", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("connection reset"));
    const onRequestCreated = vi
      .fn<(result: PurchaseRequestResult) => Promise<void>>()
      .mockResolvedValue();
    const tool = createRequestPurchaseTool(
      () => ({ client: clientWith(fetchMock), config: config(false) }),
      { onRequestCreated },
    );

    await expect(
      tool.execute("tool-call", {
        title: "Annual reporting plan",
        description: "Reporting software for the finance team",
        product_url: "https://merchant.example/products/reporting",
        reason: "Required for quarterly reporting",
        unit_price: "12.50",
        currency: "EUR",
        account_email: "agent@example.com",
        checkout_adapter: "demo",
        checkout_url: "https://merchant.example/checkout/123",
      }),
    ).rejects.toThrow(/outcome is unknown/i);
    expect(onRequestCreated).not.toHaveBeenCalled();
  });
});
