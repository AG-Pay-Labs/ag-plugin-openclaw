import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgPayClient } from "../src/client.js";
import {
  OutcomeMonitor,
  type OutcomeNotificationRuntime,
} from "../src/outcome-monitor.js";
import { OutcomeRegistry } from "../src/outcome-registry.js";

import {
  AGENT_ID,
  cartItem,
  checkoutEvent,
  checkoutExecution,
  EVENT_ID,
  jsonResponse,
  REQUEST_ID,
} from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;
const SESSION_KEY = "agent:main:session:purchase";
const SECOND_SESSION_KEY = "agent:main:session:second-purchase";
const SECOND_REQUEST_ID = "88888888-8888-4888-8888-888888888888";
const SECOND_EVENT_ID = "99999999-9999-4999-8999-999999999999";
const SECOND_EXECUTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_PURCHASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRACKED_AT = Date.now();
const SCOPE = { apiUrl: "https://agpay.example.test", agentId: AGENT_ID };
const temporaryRoots: string[] = [];

async function registry(): Promise<OutcomeRegistry> {
  const stateDir = await mkdtemp(join(tmpdir(), "agpay-monitor-"));
  temporaryRoots.push(stateDir);
  return new OutcomeRegistry(stateDir, SCOPE);
}

function client(fetchImplementation: typeof fetch): AgPayClient {
  return new AgPayClient({
    apiUrl: "https://agpay.example.test",
    agentToken: AGENT_TOKEN,
    fetchImplementation,
  });
}

function notificationSpies() {
  const enqueueNextTurnInjection = vi.fn<OutcomeNotificationRuntime["enqueueNextTurnInjection"]>(
    (input) =>
      Promise.resolve({ enqueued: true, id: input.idempotencyKey, sessionKey: input.sessionKey }),
  );
  const enqueueSystemEvent = vi.fn<OutcomeNotificationRuntime["enqueueSystemEvent"]>(() => true);
  const requestHeartbeat = vi.fn<OutcomeNotificationRuntime["requestHeartbeat"]>();
  return {
    runtime: { enqueueNextTurnInjection, enqueueSystemEvent, requestHeartbeat },
    enqueueNextTurnInjection,
    enqueueSystemEvent,
    requestHeartbeat,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OutcomeMonitor", () => {
  it("routes a terminal event to its originating session exactly once", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ events: [checkoutEvent()], next_cursor: 1 })),
      );
    const notifications = notificationSpies();
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();
    await monitor.pollOnce();

    expect(notifications.enqueueNextTurnInjection).toHaveBeenCalledTimes(1);
    const injection = notifications.enqueueNextTurnInjection.mock.calls[0]?.[0];
    expect(injection?.sessionKey).toBe(SESSION_KEY);
    expect(injection?.idempotencyKey).toBe(`agpay-checkout-event-${EVENT_ID}`);
    expect(injection?.metadata).toMatchObject({ request_id: REQUEST_ID, status: "succeeded" });
    expect(notifications.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(REQUEST_ID),
      { sessionKey: SESSION_KEY, contextKey: `agpay-checkout-event-${EVENT_ID}` },
    );
    expect(notifications.requestHeartbeat).toHaveBeenCalledWith({
      source: "other",
      intent: "event",
      reason: "agpay-purchase-outcome",
      sessionKey: SESSION_KEY,
    });
    await expect(state.snapshot()).resolves.toEqual({ cursor: 1, requests: {} });
  });

  it("recovers routing after restart and never injects an unknown backend error code", async () => {
    const first = await registry();
    await first.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const restarted = new OutcomeRegistry(dirname(dirname(first.stateFilePath)), SCOPE);
    const unsafeCode = "merchant_secret_internal_failure";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        events: [checkoutEvent({ status: "failed", purchase_id: null, error_code: unsafeCode })],
        next_cursor: 1,
      }),
    );
    const notifications = notificationSpies();
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: restarted,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();

    const injection = notifications.enqueueNextTurnInjection.mock.calls[0]?.[0];
    expect(injection?.sessionKey).toBe(SESSION_KEY);
    expect(injection?.text).toMatch(/did not complete/i);
    expect(injection?.text).not.toContain(unsafeCode);
    expect(injection?.text).not.toMatch(/secret|browserbase|card/i);
  });

  it("recovers a terminal item directly when its feed event raced ahead of request tracking", async () => {
    const state = await registry();
    await state.advance(10);
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        cartItem({
          status: "purchased",
          checkout_adapter: "demo",
          checkout_url: "https://merchant.example/checkout/123",
          execution: checkoutExecution({
            status: "succeeded",
            attempt_count: 1,
            submitted_at: "2026-08-05T10:16:00.000Z",
            completed_at: "2026-08-05T10:17:00.000Z",
            updated_at: "2026-08-05T10:17:00.000Z",
          }),
        }),
      ),
    );
    const notifications = notificationSpies();
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.recoverRequest(REQUEST_ID);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://agpay.example.test/api/v1/agent/cart-items/${REQUEST_ID}`,
    );
    expect(notifications.enqueueNextTurnInjection).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: SESSION_KEY }),
    );
    await expect(state.snapshot()).resolves.toEqual({ cursor: 10, requests: {} });
  });

  it("retries with a stable idempotency key until injection or the system fallback is accepted", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ events: [checkoutEvent()], next_cursor: 1 })),
    );
    const notifications = notificationSpies();
    notifications.enqueueNextTurnInjection.mockImplementation((input) =>
      Promise.resolve({ enqueued: false, id: input.idempotencyKey, sessionKey: input.sessionKey }),
    );
    notifications.enqueueSystemEvent.mockReturnValueOnce(false);
    const logger = { warn: vi.fn() };
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger,
      notifications: notifications.runtime,
    });

    await expect(monitor.pollOnce()).resolves.toBeUndefined();
    await expect(state.snapshot()).resolves.toEqual({
      cursor: 0,
      requests: { [REQUEST_ID]: { sessionKey: SESSION_KEY, trackedAt: TRACKED_AT } },
    });

    await monitor.pollOnce();
    expect(notifications.enqueueNextTurnInjection).toHaveBeenCalledTimes(2);
    expect(notifications.enqueueNextTurnInjection.mock.calls[0]?.[0].idempotencyKey).toBe(
      notifications.enqueueNextTurnInjection.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/remains pending/i));
    await expect(state.snapshot()).resolves.toEqual({ cursor: 1, requests: {} });
  });

  it("uses a successful system event when durable prompt injection is unavailable", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ events: [checkoutEvent()], next_cursor: 1 }));
    const notifications = notificationSpies();
    notifications.enqueueNextTurnInjection.mockImplementation((input) =>
      Promise.resolve({ enqueued: false, id: "", sessionKey: input.sessionKey }),
    );
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();

    expect(notifications.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringMatching(/agpay_get_purchase_request/),
      expect.objectContaining({ sessionKey: SESSION_KEY }),
    );
    expect(notifications.requestHeartbeat).toHaveBeenCalledOnce();
    await expect(state.snapshot()).resolves.toEqual({ cursor: 1, requests: {} });
  });

  it("accepts a durable injection even when the system-event fallback is unavailable", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ events: [checkoutEvent()], next_cursor: 1 }));
    const notifications = notificationSpies();
    notifications.enqueueSystemEvent.mockReturnValue(false);
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();

    expect(notifications.enqueueNextTurnInjection).toHaveBeenCalledOnce();
    expect(notifications.requestHeartbeat).toHaveBeenCalledOnce();
    await expect(state.snapshot()).resolves.toEqual({ cursor: 1, requests: {} });
  });

  it("does not let a permanently undeliverable session block another terminal request", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    await state.track(SECOND_REQUEST_ID, SECOND_SESSION_KEY, TRACKED_AT);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            checkoutEvent(),
            checkoutEvent({
              cursor: 2,
              event_id: SECOND_EVENT_ID,
              request_id: SECOND_REQUEST_ID,
              purchase_id: SECOND_PURCHASE_ID,
            }),
          ],
          next_cursor: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          cartItem({
            id: SECOND_REQUEST_ID,
            status: "purchased",
            checkout_adapter: "demo",
            checkout_url: "https://merchant.example/checkout/second",
            execution: checkoutExecution({
              id: SECOND_EXECUTION_ID,
              status: "succeeded",
              attempt_count: 1,
              completed_at: "2026-08-05T10:30:00.000Z",
              updated_at: "2026-08-05T10:30:00.000Z",
            }),
          }),
        ),
      );
    const notifications = notificationSpies();
    notifications.enqueueNextTurnInjection.mockImplementation((input) =>
      Promise.resolve({
        enqueued: input.sessionKey === SECOND_SESSION_KEY,
        id: input.sessionKey === SECOND_SESSION_KEY ? input.idempotencyKey : "",
        sessionKey: input.sessionKey,
      }),
    );
    notifications.enqueueSystemEvent.mockImplementation(
      (_text, options) => options.sessionKey === SECOND_SESSION_KEY,
    );
    const logger = { warn: vi.fn() };
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger,
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();

    expect(notifications.enqueueNextTurnInjection).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: SECOND_SESSION_KEY }),
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/remains pending/i));
    await expect(state.snapshot()).resolves.toEqual({
      cursor: 0,
      requests: { [REQUEST_ID]: { sessionKey: SESSION_KEY, trackedAt: TRACKED_AT } },
    });
  });

  it("advances untracked and non-terminal events without waking a session", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const unknownRequest = "99999999-9999-4999-8999-999999999999";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            checkoutEvent({ status: "queued", purchase_id: null }),
            checkoutEvent({
              cursor: 2,
              event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              request_id: unknownRequest,
            }),
          ],
          next_cursor: 2,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          cartItem({
            status: "approved",
            checkout_adapter: "demo",
            checkout_url: "https://merchant.example/checkout/123",
            execution: checkoutExecution(),
          }),
        ),
      );
    const notifications = notificationSpies();
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();

    expect(notifications.enqueueNextTurnInjection).not.toHaveBeenCalled();
    await expect(state.snapshot()).resolves.toEqual({
      cursor: 2,
      requests: { [REQUEST_ID]: { sessionKey: SESSION_KEY, trackedAt: TRACKED_AT } },
    });
  });

  it("removes a managed request mapping after the user cancels it", async () => {
    const state = await registry();
    await state.track(REQUEST_ID, SESSION_KEY, TRACKED_AT);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ events: [], next_cursor: 0 }))
      .mockResolvedValueOnce(
        jsonResponse(
          cartItem({
            status: "cancelled",
            cancelled_at: "2026-08-05T10:20:00.000Z",
            checkout_adapter: "demo",
            checkout_url: "https://merchant.example/checkout/123",
          }),
        ),
      );
    const notifications = notificationSpies();
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notifications.runtime,
    });

    await monitor.pollOnce();

    expect(notifications.enqueueNextTurnInjection).not.toHaveBeenCalled();
    await expect(state.snapshot()).resolves.toEqual({ cursor: 0, requests: {} });
  });

  it("expires a managed request that never reaches execution", async () => {
    const state = await registry();
    const expiredAt = Date.now() - 31 * 24 * 60 * 60 * 1_000;
    await state.track(REQUEST_ID, SESSION_KEY, expiredAt);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ events: [], next_cursor: 0 }))
      .mockResolvedValueOnce(
        jsonResponse(
          cartItem({
            checkout_adapter: "demo",
            checkout_url: "https://merchant.example/checkout/123",
          }),
        ),
      );
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 15,
      logger: { warn: vi.fn() },
      notifications: notificationSpies().runtime,
    });

    await monitor.pollOnce();

    await expect(state.snapshot()).resolves.toEqual({ cursor: 0, requests: {} });
  });

  it("fails closed and stops polling after a 401", async () => {
    const state = await registry();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ detail: "invalid credential" }, { status: 401 }));
    const logger = { warn: vi.fn() };
    const monitor = new OutcomeMonitor({
      client: client(fetchMock),
      registry: state,
      pollIntervalSeconds: 5,
      logger,
      notifications: notificationSpies().runtime,
    });

    monitor.start();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/stopped/)));
    await monitor.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
