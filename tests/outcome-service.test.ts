import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgPayClient } from "../src/client.js";
import type { OutcomeNotificationRuntime } from "../src/outcome-monitor.js";
import { OutcomeRegistry } from "../src/outcome-registry.js";
import { CheckoutOutcomeService } from "../src/outcome-service.js";

import { AGENT_ID, cartItem, jsonResponse, REQUEST_ID } from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;
const SESSION_KEY = "agent:main:session:startup-purchase";
const temporaryRoots: string[] = [];
const services: CheckoutOutcomeService[] = [];

function notifications(): OutcomeNotificationRuntime {
  const enqueueNextTurnInjection = vi.fn<
    OutcomeNotificationRuntime["enqueueNextTurnInjection"]
  >((input) =>
    Promise.resolve({ enqueued: true, id: input.idempotencyKey, sessionKey: input.sessionKey }),
  );
  return {
    enqueueNextTurnInjection,
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeat: vi.fn(),
  };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => service.stop()));
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
  vi.useRealTimers();
});

describe("CheckoutOutcomeService", () => {
  it("retries identity bootstrap and activates polling after the API recovers", async () => {
    vi.useFakeTimers();
    const stateDir = await mkdtemp(join(tmpdir(), "agpay-outcome-service-"));
    temporaryRoots.push(stateDir);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporarily offline"))
      .mockResolvedValueOnce(
        jsonResponse({
          agent_id: AGENT_ID,
          connection_state: "online",
          server_time: "2026-08-05T10:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          cartItem({
            checkout_adapter: "demo",
            checkout_url: "https://merchant.example/checkout/123",
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ events: [], next_cursor: 0 }))
      .mockResolvedValue(
        jsonResponse(
          cartItem({
            checkout_adapter: "demo",
            checkout_url: "https://merchant.example/checkout/123",
          }),
        ),
      );
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new CheckoutOutcomeService({
      client: new AgPayClient({
        apiUrl: "https://agpay.example.test",
        agentToken: AGENT_TOKEN,
        fetchImplementation: fetchMock,
      }),
      stateDir,
      apiUrl: "https://agpay.example.test",
      pollIntervalSeconds: 15,
      logger,
      notifications: notifications(),
    });
    services.push(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.isReady).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/retry with backoff/i));
    await expect(service.track(REQUEST_ID, SESSION_KEY)).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(service.isReady).toBe(true));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://agpay.example.test/api/v1/agent/heartbeat",
    );
    expect(
      fetchMock.mock.calls.some(
        ([url]) => typeof url === "string" && url.includes("/checkout-events?"),
      ),
    ).toBe(true);
    const persisted = new OutcomeRegistry(stateDir, {
      apiUrl: "https://agpay.example.test",
      agentId: AGENT_ID,
    });
    await expect(persisted.snapshot()).resolves.toMatchObject({
      requests: { [REQUEST_ID]: { sessionKey: SESSION_KEY } },
    });

    await service.stop();
    const callsAfterStop = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("aborts a pending bootstrap retry when the service stops", async () => {
    vi.useFakeTimers();
    const stateDir = await mkdtemp(join(tmpdir(), "agpay-outcome-service-"));
    temporaryRoots.push(stateDir);
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("temporarily offline"));
    const service = new CheckoutOutcomeService({
      client: new AgPayClient({
        apiUrl: "https://agpay.example.test",
        agentToken: AGENT_TOKEN,
        fetchImplementation: fetchMock,
      }),
      stateDir,
      apiUrl: "https://agpay.example.test",
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications(),
    });
    services.push(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await service.stop();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.isReady).toBe(false);
  });

  it("drops pending routes when their originating session is reset during bootstrap", async () => {
    vi.useFakeTimers();
    const stateDir = await mkdtemp(join(tmpdir(), "agpay-outcome-service-"));
    temporaryRoots.push(stateDir);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporarily offline"))
      .mockResolvedValueOnce(
        jsonResponse({
          agent_id: AGENT_ID,
          connection_state: "online",
          server_time: "2026-08-05T10:00:00.000Z",
        }),
      )
      .mockResolvedValue(jsonResponse({ events: [], next_cursor: 0 }));
    const service = new CheckoutOutcomeService({
      client: new AgPayClient({
        apiUrl: "https://agpay.example.test",
        agentToken: AGENT_TOKEN,
        fetchImplementation: fetchMock,
      }),
      stateDir,
      apiUrl: "https://agpay.example.test",
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications(),
    });
    services.push(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.track(REQUEST_ID, SESSION_KEY)).resolves.toBe(true);
    await service.forgetSession(SESSION_KEY);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(service.isReady).toBe(true));

    const persisted = new OutcomeRegistry(stateDir, {
      apiUrl: "https://agpay.example.test",
      agentId: AGENT_ID,
    });
    await expect(persisted.snapshot()).resolves.toEqual({ cursor: 0, requests: {} });
    expect(fetchMock.mock.calls.some(([url]) => typeof url === "string" && url.includes(REQUEST_ID)))
      .toBe(false);
  });
});
