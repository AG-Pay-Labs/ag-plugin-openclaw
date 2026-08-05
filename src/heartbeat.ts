import { AgPayApiError, type AgPayClient } from "./client.js";

export interface HeartbeatLogger {
  debug?(message: string): void;
  warn(message: string): void;
}

interface HeartbeatOptions {
  client: AgPayClient;
  intervalSeconds: number;
  logger: HeartbeatLogger;
}

export class HeartbeatService {
  readonly #client: AgPayClient;
  readonly #intervalMs: number;
  readonly #logger: HeartbeatLogger;
  #timer: NodeJS.Timeout | undefined;
  #requestInFlight = false;
  #credentialRejected = false;

  constructor(options: HeartbeatOptions) {
    this.#client = options.client;
    this.#intervalMs = options.intervalSeconds * 1_000;
    this.#logger = options.logger;
  }

  start(): void {
    if (this.#timer || this.#credentialRejected) {
      return;
    }
    void this.#send();
    this.#timer = setInterval(() => void this.#send(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #send(): Promise<void> {
    if (this.#requestInFlight) {
      return;
    }
    this.#requestInFlight = true;
    try {
      await this.#client.heartbeat();
      this.#logger.debug?.("AG Pay agent heartbeat succeeded");
    } catch (error) {
      if (error instanceof AgPayApiError && error.status === 401) {
        this.#credentialRejected = true;
        this.#logger.warn("AG Pay heartbeat rejected the agent credential; heartbeats are stopped");
        this.stop();
        return;
      }
      this.#logger.warn("AG Pay agent heartbeat failed; the credential or API may be unavailable");
    } finally {
      this.#requestInFlight = false;
    }
  }
}
