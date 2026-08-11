import { AgPayApiError, type AgPayClient } from "./client.js";
import { formatSafeCheckoutOutcome, isTerminalCheckoutStatus } from "./checkout-safety.js";
import type { OutcomeDeliveryTarget } from "./config.js";
import type { OutcomeRegistry } from "./outcome-registry.js";
import type { CartItemRead, CheckoutEventRead } from "./types.js";

const MAX_BACKOFF_MS = 300_000;
const MAX_SEEN_EVENT_IDS = 1_000;
const MAX_TRACKING_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_RECONCILIATIONS_PER_POLL = 5;

export interface OutcomeMonitorLogger {
  debug?(message: string): void;
  warn(message: string): void;
}

export interface OutcomeNotificationRuntime {
  enqueueNextTurnInjection(input: {
    sessionKey: string;
    text: string;
    idempotencyKey: string;
    placement: "append_context";
    ttlMs: number;
    metadata: {
      request_id: string;
      event_id: string;
      status: string;
    };
  }): Promise<{ enqueued: boolean; id: string; sessionKey: string }>;
  enqueueSystemEvent(
    text: string,
    options: { sessionKey: string; contextKey: string },
  ): boolean;
  requestHeartbeat(options: {
    source: "hook";
    intent: "immediate";
    reason: "agpay-purchase-outcome";
    sessionKey: string;
    heartbeat: { target: OutcomeDeliveryTarget };
  }): void;
}

interface OutcomeMonitorOptions {
  client: AgPayClient;
  registry: OutcomeRegistry;
  pollIntervalSeconds: number;
  logger: OutcomeMonitorLogger;
  notifications: OutcomeNotificationRuntime;
  outcomeDeliveryTarget?: OutcomeDeliveryTarget;
}

export class OutcomeMonitor {
  readonly #client: AgPayClient;
  readonly #registry: OutcomeRegistry;
  readonly #pollIntervalMs: number;
  readonly #logger: OutcomeMonitorLogger;
  readonly #notifications: OutcomeNotificationRuntime;
  readonly #outcomeDeliveryTarget: OutcomeDeliveryTarget;
  readonly #seenEventIds = new Set<string>();
  #abortController: AbortController | undefined;
  #running: Promise<void> | undefined;
  #operations: Promise<void> = Promise.resolve();
  #reconciliationOffset = 0;

  constructor(options: OutcomeMonitorOptions) {
    this.#client = options.client;
    this.#registry = options.registry;
    this.#pollIntervalMs = options.pollIntervalSeconds * 1_000;
    this.#logger = options.logger;
    this.#notifications = options.notifications;
    this.#outcomeDeliveryTarget = options.outcomeDeliveryTarget ?? "last";
  }

  start(): void {
    if (this.#running) {
      return;
    }
    this.#abortController = new AbortController();
    this.#running = this.#run(this.#abortController.signal).finally(() => {
      this.#running = undefined;
      this.#abortController = undefined;
    });
  }

  async stop(): Promise<void> {
    this.#abortController?.abort();
    await this.#running;
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    await this.#serialize(async () => this.#pollOnce(signal));
  }

  async recoverRequest(requestId: string): Promise<void> {
    await this.#serialize(async () => {
      const item = await this.#client.getPurchaseRequest(requestId);
      await this.#recoverItem(item);
    });
  }

  async #pollOnce(signal?: AbortSignal): Promise<void> {
    const snapshot = await this.#registry.snapshot();
    const page = await this.#client.listCheckoutEvents(snapshot.cursor, signal);
    const failedDeliveryRequestIds = new Set<string>();
    let feedBlocked = false;
    for (const event of page.events) {
      const current = await this.#registry.snapshot();
      if (event.cursor <= current.cursor) {
        continue;
      }
      if (this.#seenEventIds.has(event.event_id)) {
        await this.#registry.advance(event.cursor);
        continue;
      }
      try {
        await this.#handleEvent(event, current.requests[event.request_id]?.sessionKey);
        this.#rememberEvent(event.event_id);
      } catch {
        failedDeliveryRequestIds.add(event.request_id);
        feedBlocked = true;
        this.#logger.warn(
          "AG Pay could not deliver one checkout outcome; its route remains pending while other requests are reconciled",
        );
        break;
      }
    }

    const current = await this.#registry.snapshot();
    if (!feedBlocked && page.next_cursor > current.cursor) {
      await this.#registry.advance(page.next_cursor);
    }
    await this.#reconcileTrackedRequests(failedDeliveryRequestIds);
    await this.#registry.pruneOlderThan(Math.max(0, Date.now() - MAX_TRACKING_AGE_MS));
  }

  async #recoverItem(item: CartItemRead): Promise<void> {
    const requestId = item.id;
    if (!item.checkout_adapter || !item.checkout_url || item.status === "cancelled") {
      await this.#registry.forgetRequest(requestId);
      return;
    }
    const execution = item.execution;
    if (!execution || !isTerminalCheckoutStatus(execution.status)) {
      if (item.status === "purchased") {
        await this.#registry.forgetRequest(requestId);
      }
      return;
    }
    if (execution.status === "succeeded" && item.status !== "purchased") {
      throw new Error("AG Pay returned checkout success before recording the purchase");
    }
    const snapshot = await this.#registry.snapshot();
    const sessionKey = snapshot.requests[requestId]?.sessionKey;
    if (!sessionKey) {
      return;
    }
    await this.#handleEvent(
      {
        cursor: snapshot.cursor,
        event_id: execution.id,
        request_id: requestId,
        status: execution.status,
        purchase_id: null,
        amount: execution.approved_amount,
        currency: execution.currency,
        error_code: execution.error_code,
        occurred_at: execution.completed_at ?? execution.updated_at,
      },
      sessionKey,
    );
    this.#rememberEvent(execution.id);
  }

  async #reconcileTrackedRequests(skipRequestIds: ReadonlySet<string>): Promise<void> {
    const snapshot = await this.#registry.snapshot();
    const requestIds = Object.keys(snapshot.requests);
    if (requestIds.length === 0) {
      this.#reconciliationOffset = 0;
      return;
    }
    const count = Math.min(requestIds.length, MAX_RECONCILIATIONS_PER_POLL);
    const start = this.#reconciliationOffset % requestIds.length;
    const selected = Array.from(
      { length: count },
      (_, index) => requestIds[(start + index) % requestIds.length],
    ).filter((requestId): requestId is string => requestId !== undefined);
    this.#reconciliationOffset = (start + count) % requestIds.length;

    for (const requestId of selected) {
      if (skipRequestIds.has(requestId)) {
        continue;
      }
      try {
        await this.#recoverItem(await this.#client.getPurchaseRequest(requestId));
      } catch (error) {
        if (error instanceof AgPayApiError && error.status === 404) {
          await this.#registry.forgetRequest(requestId);
          continue;
        }
        if (error instanceof AgPayApiError && error.status === 401) {
          throw error;
        }
        this.#logger.warn(
          "AG Pay could not reconcile one tracked checkout outcome; other requests will continue",
        );
      }
    }
  }

  async #handleEvent(event: CheckoutEventRead, sessionKey: string | undefined): Promise<void> {
    if (!sessionKey || !isTerminalCheckoutStatus(event.status)) {
      await this.#registry.advance(event.cursor);
      return;
    }

    const safeOutcome = formatSafeCheckoutOutcome(event);
    if (!safeOutcome) {
      await this.#registry.advance(event.cursor);
      return;
    }
    const message = `${safeOutcome} Report this checkout outcome to the user now.`;
    const idempotencyKey = `agpay-checkout-event-${event.event_id}`;
    let durableInjectionQueued = false;
    try {
      const injection = await this.#notifications.enqueueNextTurnInjection({
        sessionKey,
        text: message,
        idempotencyKey,
        placement: "append_context",
        ttlMs: 30 * 24 * 60 * 60 * 1_000,
        metadata: {
          request_id: event.request_id,
          event_id: event.event_id,
          status: event.status,
        },
      });
      durableInjectionQueued = injection.enqueued;
    } catch {
      this.#logger.warn(
        "AG Pay durable checkout outcome injection was unavailable; attempting a safe system-event fallback",
      );
    }

    let systemEventQueued = false;
    try {
      systemEventQueued = this.#notifications.enqueueSystemEvent(
        `AG Pay has a checkout outcome for purchase request ${event.request_id}. Use agpay_get_purchase_request to read its sanitized status, then report that outcome to the user.`,
        { sessionKey, contextKey: idempotencyKey },
      );
    } catch {
      systemEventQueued = false;
    }
    if (!durableInjectionQueued && !systemEventQueued) {
      throw new Error("AG Pay checkout outcome notification was not queued");
    }
    try {
      this.#notifications.requestHeartbeat({
        source: "hook",
        intent: "immediate",
        reason: "agpay-purchase-outcome",
        sessionKey,
        heartbeat: { target: this.#outcomeDeliveryTarget },
      });
    } catch {
      this.#logger.warn(
        "AG Pay queued a checkout outcome but could not request an immediate OpenClaw turn",
      );
    }
    await this.#registry.advance(event.cursor, event.request_id);
  }

  async #run(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof AgPayApiError && error.status === 401) {
          this.#logger.warn(
            "AG Pay checkout outcome polling rejected the agent credential; polling is stopped",
          );
          return;
        }
        consecutiveFailures += 1;
        this.#logger.warn("AG Pay checkout outcome polling failed; it will retry with backoff");
      }

      const delay = Math.min(
        this.#pollIntervalMs * 2 ** Math.min(consecutiveFailures, 8),
        MAX_BACKOFF_MS,
      );
      await waitFor(delay, signal);
    }
  }

  #rememberEvent(eventId: string): void {
    this.#seenEventIds.add(eventId);
    if (this.#seenEventIds.size <= MAX_SEEN_EVENT_IDS) {
      return;
    }
    const oldest = this.#seenEventIds.values().next().value;
    if (oldest !== undefined) {
      this.#seenEventIds.delete(oldest);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation, operation);
    this.#operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
