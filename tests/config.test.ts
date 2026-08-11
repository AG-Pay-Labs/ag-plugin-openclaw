import { describe, expect, it } from "vitest";

import { normalizeApiUrl, parsePluginConfig, requireAgentToken } from "../src/config.js";

describe("AG Pay plugin configuration", () => {
  it("uses conservative defaults without inventing a credential", () => {
    expect(parsePluginConfig(undefined)).toEqual({
      apiUrl: "http://127.0.0.1:8000",
      heartbeatIntervalSeconds: 60,
      requestTimeoutMs: 10_000,
      outcomePollIntervalSeconds: 15,
      outcomeDeliveryTarget: "last",
      allowSandboxCompletion: false,
    });
  });

  it("normalizes an HTTPS base URL and accepts a resolved agent token", () => {
    const token = `agt_${"a".repeat(32)}`;

    expect(
      parsePluginConfig({
        apiUrl: "https://agpay.example.test/",
        agentToken: token,
        heartbeatIntervalSeconds: 30,
        requestTimeoutMs: 5_000,
        outcomePollIntervalSeconds: 10,
        outcomeDeliveryTarget: "none",
        allowSandboxCompletion: true,
      }),
    ).toEqual({
      apiUrl: "https://agpay.example.test",
      agentToken: token,
      heartbeatIntervalSeconds: 30,
      requestTimeoutMs: 5_000,
      outcomePollIntervalSeconds: 10,
      outcomeDeliveryTarget: "none",
      allowSandboxCompletion: true,
    });
  });

  it("accepts a paired managed-checkout default", () => {
    expect(
      parsePluginConfig({
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl: "https://checkout.stripe.com",
      }),
    ).toMatchObject({
      defaultCheckoutAdapter: "stripe-hosted",
      defaultCheckoutUrl: "https://checkout.stripe.com/",
    });
  });

  it.each([
    [{ defaultCheckoutAdapter: "stripe-hosted" }, /configured together/i],
    [{ defaultCheckoutUrl: "https://checkout.stripe.com/" }, /configured together/i],
    [
      {
        defaultCheckoutAdapter: "Stripe Hosted",
        defaultCheckoutUrl: "https://checkout.stripe.com/",
      },
      /defaultCheckoutAdapter/i,
    ],
    [
      {
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl: "http://checkout.stripe.com/",
      },
      /must use HTTPS/i,
    ],
    [
      {
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl: "https://user:password@checkout.stripe.com/",
      },
      /must not contain credentials/i,
    ],
    [
      {
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl: "https://checkout.stripe.com/?session=secret",
      },
      /query string or fragment/i,
    ],
  ])("rejects an unsafe or incomplete managed-checkout default (%j)", (value, message) => {
    expect(() => parsePluginConfig(value)).toThrow(message);
  });

  it.each([
    ["non-loopback plaintext HTTP", "http://agpay.example.test"],
    ["embedded username", "https://operator@agpay.example.test"],
    ["embedded password", "https://operator:secret@agpay.example.test"],
    ["query string", "https://agpay.example.test?tenant=other"],
    ["fragment", "https://agpay.example.test/#token"],
    ["unexpected base path", "https://agpay.example.test/tenant/other"],
    ["non-HTTP scheme", "file:///tmp/agpay"],
  ])("rejects %s in apiUrl", (_caseName, value) => {
    expect(() => normalizeApiUrl(value)).toThrow();
  });

  it.each(["not-a-token", "agt_short", { source: "env", id: "AGPAY_TOKEN" }])(
    "rejects an unresolved or malformed agent token (%j)",
    (agentToken) => {
      expect(() => parsePluginConfig({ agentToken })).toThrow();
    },
  );

  it("requires explicit pairing before authenticated operations", () => {
    expect(() => requireAgentToken(parsePluginConfig({}))).toThrow();
  });

  it.each([
    ["heartbeatIntervalSeconds", 14],
    ["heartbeatIntervalSeconds", 111],
    ["requestTimeoutMs", 999],
    ["requestTimeoutMs", 60_001],
    ["outcomePollIntervalSeconds", 4],
    ["outcomePollIntervalSeconds", 301],
  ])("rejects an out-of-range %s", (key, value) => {
    expect(() => parsePluginConfig({ [key]: value })).toThrow();
  });

  it("rejects an unsupported checkout outcome delivery target", () => {
    expect(() => parsePluginConfig({ outcomeDeliveryTarget: "telegram" })).toThrow(
      /outcomeDeliveryTarget/i,
    );
  });
});
