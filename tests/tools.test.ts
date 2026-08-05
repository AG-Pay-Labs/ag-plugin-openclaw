import { describe, expect, it, vi } from "vitest";

import { AgPayClient } from "../src/client.js";
import type { AgPayPluginConfig } from "../src/config.js";
import { recordPurchaseResult, requestPurchase } from "../src/tools.js";

import { cartItem, jsonRequestBody, jsonResponse, purchase, REQUEST_ID } from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;

function clientWith(fetchImplementation: typeof fetch): AgPayClient {
  return new AgPayClient({
    apiUrl: "https://agpay.example.test",
    agentToken: AGENT_TOKEN,
    fetchImplementation,
  });
}

function config(allowSandboxCompletion: boolean): AgPayPluginConfig {
  return {
    apiUrl: "https://agpay.example.test",
    agentToken: AGENT_TOKEN,
    heartbeatIntervalSeconds: 60,
    requestTimeoutMs: 10_000,
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
    });

    expect(outboundBody).toMatchObject({
      currency: "EUR",
      account: {
        email: "agent@example.com",
        login_url: "https://merchant.example/login",
      },
    });
    const outboundPassword = (outboundBody as { account: { password: unknown } }).account.password;
    expect(outboundPassword).toEqual(expect.any(String));
    expect(String(outboundPassword).length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(result)).not.toContain(String(outboundPassword));
    expect(result).not.toHaveProperty("account");
    expect(result).not.toHaveProperty("credential_id");
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse([cartItem()]));

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
      .mockResolvedValueOnce(jsonResponse([approvedOneTimeRequest]))
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
        return Promise.resolve(jsonResponse([approvedRequest]));
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
});
