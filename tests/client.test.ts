import { describe, expect, it, vi } from "vitest";

import { AgPayApiError, AgPayClient, AgPayOutcomeUnknownError } from "../src/client.js";

import { AGENT_ID, jsonResponse } from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;

function clientWith(fetchImplementation: typeof fetch): AgPayClient {
  return new AgPayClient({
    apiUrl: "https://agpay.example.test",
    agentToken: AGENT_TOKEN,
    timeoutMs: 1_000,
    fetchImplementation,
  });
}

describe("AgPayClient transport safety", () => {
  it("rejects bearer-token clients configured with external plaintext HTTP", () => {
    expect(
      () =>
        new AgPayClient({
          apiUrl: "http://agpay.example.test",
          agentToken: AGENT_TOKEN,
        }),
    ).toThrow(/HTTPS/i);
  });

  it("authenticates requests, rejects redirects, and does not retry a failed request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("connection reset"));
    const client = clientWith(fetchMock);

    await expect(client.heartbeat()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://agpay.example.test/api/v1/agent/heartbeat");
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${AGENT_TOKEN}`);
  });

  it("rejects a response whose declared size exceeds the one MiB bound", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-length": "1048577", "content-type": "application/json" },
      }),
    );

    await expect(clientWith(fetchMock).heartbeat()).rejects.toThrow(/size/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an undeclared response body larger than one MiB", async () => {
    const oversizedBody = JSON.stringify({ padding: "x".repeat(1_048_576) });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(oversizedBody, { status: 200 }));

    await expect(clientWith(fetchMock).heartbeat()).rejects.toThrow(/size/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose backend error details that may contain credentials", async () => {
    const secret = `agt_${"sensitive".repeat(5)}`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        { detail: `Credential ${secret} was rejected for tenant internal-tenant-id` },
        { status: 401 },
      ),
    );

    const error = await clientWith(fetchMock).heartbeat().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgPayApiError);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("internal-tenant-id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid bounded heartbeat response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        agent_id: AGENT_ID,
        connection_state: "online",
        server_time: "2026-08-05T10:00:00.000Z",
      }),
    );

    await expect(clientWith(fetchMock).heartbeat()).resolves.toMatchObject({
      agent_id: AGENT_ID,
      connection_state: "online",
    });
  });

  it("treats a malformed credential in a successful pairing response as unknown", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        agent_id: AGENT_ID,
        agent_access_token: `agt_${"a".repeat(197)}`,
        token_type: "bearer",
        expires_at: "2026-08-06T10:00:00.000Z",
      }),
    );
    const client = new AgPayClient({
      apiUrl: "https://agpay.example.test",
      fetchImplementation: fetchMock,
    });

    await expect(
      client.pair({
        pairing_token: `pair_${"p".repeat(32)}`,
        instance_id: "test-openclaw-instance",
        capabilities: [],
      }),
    ).rejects.toBeInstanceOf(AgPayOutcomeUnknownError);
  });

  it("reports a mutation transport failure as an unknown outcome without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("connection reset"));

    const error = await clientWith(fetchMock)
      .requestPurchase({
        title: "Reporting plan",
        description: "Reporting software",
        product_url: "https://merchant.example/product",
        reason: "Quarterly reporting",
        quantity: 1,
        unit_price: "10.00",
        currency: "EUR",
        billing_period: null,
        account: { email: "agent@example.com", password: "generated-in-runtime" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgPayOutcomeUnknownError);
    expect(String(error)).toMatch(/outcome is unknown/i);
    expect(String(error)).toMatch(/do not retry automatically/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a server error after a mutation as an unknown outcome without retrying", async () => {
    const secret = `agt_${"server-echo".repeat(4)}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ detail: `post-commit failure ${secret}` }, { status: 503 }),
      );

    const error = await clientWith(fetchMock)
      .requestPurchase({
        title: "Reporting plan",
        description: "Reporting software",
        product_url: "https://merchant.example/product",
        reason: "Quarterly reporting",
        quantity: 1,
        unit_price: "10.00",
        currency: "EUR",
        billing_period: null,
        account: { email: "agent@example.com", password: "generated-in-runtime" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgPayOutcomeUnknownError);
    expect(String(error)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
