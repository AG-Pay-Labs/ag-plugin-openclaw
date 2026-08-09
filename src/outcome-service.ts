import { AgPayApiError, type AgPayClient } from "./client.js";
import {
  OutcomeMonitor,
  type OutcomeMonitorLogger,
  type OutcomeNotificationRuntime,
} from "./outcome-monitor.js";
import { OutcomeRegistry } from "./outcome-registry.js";

const INITIAL_BOOTSTRAP_BACKOFF_MS = 1_000;
const MAX_BOOTSTRAP_BACKOFF_MS = 300_000;
const MAX_PENDING_ROUTES = 1_000;
const MAX_PENDING_ROUTE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_SESSION_KEY_LENGTH = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PendingRoute {
  requestId: string;
  sessionKey: string;
  trackedAt: number;
}

interface CheckoutOutcomeServiceOptions {
  client: AgPayClient;
  stateDir: string;
  apiUrl: string;
  pollIntervalSeconds: number;
  logger: OutcomeMonitorLogger;
  notifications: OutcomeNotificationRuntime;
}

/**
 * Owns the identity-scoped registry and monitor lifecycle. Bootstrap is kept
 * separate from the monitor so a temporary API outage at Gateway startup does
 * not require a Gateway restart.
 */
export class CheckoutOutcomeService {
  readonly #client: AgPayClient;
  readonly #stateDir: string;
  readonly #apiUrl: string;
  readonly #pollIntervalSeconds: number;
  readonly #logger: OutcomeMonitorLogger;
  readonly #notifications: OutcomeNotificationRuntime;
  #bootstrapAbort: AbortController | undefined;
  #bootstrapTask: Promise<void> | undefined;
  #registry: OutcomeRegistry | undefined;
  #monitor: OutcomeMonitor | undefined;
  #acceptingRoutes = false;
  #monitorRunning = false;
  readonly #pendingRoutes = new Map<string, PendingRoute>();
  #routeOperations: Promise<void> = Promise.resolve();

  constructor(options: CheckoutOutcomeServiceOptions) {
    this.#client = options.client;
    this.#stateDir = options.stateDir;
    this.#apiUrl = options.apiUrl;
    this.#pollIntervalSeconds = options.pollIntervalSeconds;
    this.#logger = options.logger;
    this.#notifications = options.notifications;
  }

  get isReady(): boolean {
    return this.#monitorRunning;
  }

  start(): void {
    if (this.#bootstrapTask || this.#monitor) {
      return;
    }
    const controller = new AbortController();
    this.#acceptingRoutes = true;
    this.#bootstrapAbort = controller;
    const task = this.#bootstrap(controller.signal).finally(() => {
      if (this.#bootstrapTask === task) {
        this.#bootstrapTask = undefined;
      }
      if (this.#bootstrapAbort === controller) {
        this.#bootstrapAbort = undefined;
      }
    });
    this.#bootstrapTask = task;
  }

  async stop(): Promise<void> {
    this.#acceptingRoutes = false;
    this.#bootstrapAbort?.abort();
    await this.#bootstrapTask;
    await this.#serializeRoute(() => Promise.resolve());
    const monitor = this.#monitor;
    this.#monitor = undefined;
    this.#monitorRunning = false;
    this.#registry = undefined;
    this.#pendingRoutes.clear();
    await monitor?.stop();
  }

  async track(requestId: string, sessionKey: string): Promise<boolean> {
    return this.#serializeRoute(async () => {
      if (!this.#acceptingRoutes) {
        return false;
      }
      const registry = this.#registry;
      const monitor = this.#monitor;
      if (!registry || !monitor) {
        this.#queuePendingRoute(requestId, sessionKey);
        return true;
      }
      await registry.track(requestId, sessionKey);
      await monitor.recoverRequest(requestId);
      return true;
    });
  }

  async forgetSession(sessionKey: string): Promise<void> {
    await this.#serializeRoute(async () => {
      for (const [requestId, route] of this.#pendingRoutes) {
        if (route.sessionKey === sessionKey) {
          this.#pendingRoutes.delete(requestId);
        }
      }
      await this.#registry?.forgetSession(sessionKey);
    });
  }

  async #bootstrap(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const identity = await this.#client.heartbeat(signal);
        if (signal.aborted) {
          return;
        }
        const registry = new OutcomeRegistry(this.#stateDir, {
          apiUrl: this.#apiUrl,
          agentId: identity.agent_id,
        });
        await registry.initialize();
        if (signal.aborted) {
          return;
        }
        const monitor = new OutcomeMonitor({
          client: this.#client,
          registry,
          pollIntervalSeconds: this.#pollIntervalSeconds,
          logger: this.#logger,
          notifications: this.#notifications,
        });
        this.#registry = registry;
        this.#monitor = monitor;
        await this.#flushPendingRoutes(registry, monitor, signal);
        if (signal.aborted) {
          return;
        }
        monitor.start();
        this.#monitorRunning = true;
        this.#logger.debug?.("AG Pay checkout outcome polling started");
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (!this.#monitorRunning) {
          this.#registry = undefined;
          this.#monitor = undefined;
        }
        if (error instanceof AgPayApiError && error.status === 401) {
          this.#acceptingRoutes = false;
          this.#pendingRoutes.clear();
          this.#logger.warn(
            "AG Pay checkout outcome polling rejected the agent credential; startup is stopped",
          );
          return;
        }
        consecutiveFailures += 1;
        this.#logger.warn(
          "AG Pay checkout outcome polling could not start; it will retry with backoff",
        );
      }

      const delay = Math.min(
        INITIAL_BOOTSTRAP_BACKOFF_MS * 2 ** Math.min(consecutiveFailures - 1, 8),
        MAX_BOOTSTRAP_BACKOFF_MS,
      );
      await waitFor(delay, signal);
    }
  }

  #queuePendingRoute(requestId: string, sessionKey: string): void {
    if (!UUID_PATTERN.test(requestId)) {
      throw new Error("AG Pay purchase request ID is invalid");
    }
    if (sessionKey.length < 1 || sessionKey.length > MAX_SESSION_KEY_LENGTH) {
      throw new Error("OpenClaw session key is invalid");
    }
    const now = Date.now();
    for (const [pendingRequestId, route] of this.#pendingRoutes) {
      if (route.trackedAt < now - MAX_PENDING_ROUTE_AGE_MS) {
        this.#pendingRoutes.delete(pendingRequestId);
      }
    }
    if (!this.#pendingRoutes.has(requestId) && this.#pendingRoutes.size >= MAX_PENDING_ROUTES) {
      const oldestRequestId = this.#pendingRoutes.keys().next().value;
      if (oldestRequestId !== undefined) {
        this.#pendingRoutes.delete(oldestRequestId);
      }
    }
    this.#pendingRoutes.delete(requestId);
    this.#pendingRoutes.set(requestId, { requestId, sessionKey, trackedAt: now });
  }

  async #flushPendingRoutes(
    registry: OutcomeRegistry,
    monitor: OutcomeMonitor,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const flushed = await this.#serializeRoute(async () => {
        const next = this.#pendingRoutes.values().next().value;
        if (!next) {
          return false;
        }
        if (next.trackedAt < Date.now() - MAX_PENDING_ROUTE_AGE_MS) {
          this.#pendingRoutes.delete(next.requestId);
          return true;
        }
        await registry.track(next.requestId, next.sessionKey, next.trackedAt);
        if (this.#pendingRoutes.get(next.requestId) !== next) {
          return true;
        }
        this.#pendingRoutes.delete(next.requestId);
        try {
          await monitor.recoverRequest(next.requestId);
        } catch {
          this.#logger.warn(
            "AG Pay persisted startup purchase routing but could not immediately reconcile it",
          );
        }
        return true;
      });
      if (!flushed) {
        return;
      }
    }
  }

  #serializeRoute<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#routeOperations.then(operation, operation);
    this.#routeOperations = result.then(
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
