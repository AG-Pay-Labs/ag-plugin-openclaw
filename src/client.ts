import type {
  AgentHandshakeRequest,
  AgentHeartbeatResponse,
  AgentTokenResponse,
  CartItemCreate,
  CartItemRead,
  CartItemStatus,
  CheckoutEventPage,
  PurchaseComplete,
  PurchaseRead,
} from "./types.js";
import { normalizeApiUrl } from "./config.js";
import {
  validateAgentTokenResponse,
  validateCartItem,
  validateCartItemList,
  validateCheckoutEventPage,
  validateHeartbeatResponse,
  validatePurchase,
} from "./validation.js";

const API_PREFIX = "/api/v1";
const MAX_RESPONSE_BYTES = 1_048_576;

type FetchImplementation = typeof fetch;

interface ClientOptions {
  apiUrl: string;
  agentToken?: string;
  timeoutMs?: number;
  fetchImplementation?: FetchImplementation;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  authenticated?: boolean;
  outcomeSensitive?: boolean;
  signal?: AbortSignal;
}

class AgPayResponseSizeError extends Error {
  constructor() {
    super("AG Pay API response exceeded the allowed size");
    this.name = "AgPayResponseSizeError";
  }
}

function statusMessage(status: number): string {
  switch (status) {
    case 400:
      return "AG Pay rejected the request (HTTP 400)";
    case 401:
      return "AG Pay rejected the agent credential (HTTP 401); re-pair the agent";
    case 403:
      return "AG Pay denied this agent operation (HTTP 403)";
    case 404:
      return "AG Pay could not find the requested resource for this agent (HTTP 404)";
    case 409:
      return "AG Pay rejected the operation in the resource's current state (HTTP 409)";
    case 422:
      return "AG Pay rejected invalid request data (HTTP 422)";
    case 429:
      return "AG Pay rate-limited the request (HTTP 429)";
    default:
      return `AG Pay API returned HTTP ${status}`;
  }
}

function isAmbiguousMutationStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new AgPayResponseSizeError();
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AgPayResponseSizeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
}

export class AgPayApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgPayApiError";
    this.status = status;
  }
}

export class AgPayOutcomeUnknownError extends Error {
  constructor() {
    super(
      "AG Pay mutation outcome is unknown because no valid success response was received. Do not retry automatically.",
    );
    this.name = "AgPayOutcomeUnknownError";
  }
}

export class AgPayClient {
  readonly #apiUrl: string;
  readonly #agentToken: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: FetchImplementation;

  constructor(options: ClientOptions) {
    this.#apiUrl = normalizeApiUrl(options.apiUrl);
    this.#agentToken = options.agentToken;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async pair(payload: AgentHandshakeRequest): Promise<AgentTokenResponse> {
    const response = await this.#request(`${API_PREFIX}/agent/handshake`, {
      method: "POST",
      body: payload,
      authenticated: false,
      outcomeSensitive: true,
    });
    try {
      validateAgentTokenResponse(response);
    } catch {
      throw new AgPayOutcomeUnknownError();
    }
    return response;
  }

  async heartbeat(signal?: AbortSignal): Promise<AgentHeartbeatResponse> {
    const response = await this.#request(`${API_PREFIX}/agent/heartbeat`, {
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
    validateHeartbeatResponse(response);
    return response;
  }

  async requestPurchase(payload: CartItemCreate): Promise<CartItemRead> {
    const response = await this.#request(`${API_PREFIX}/agent/cart-items`, {
      method: "POST",
      body: payload,
      outcomeSensitive: true,
    });
    try {
      validateCartItem(response);
    } catch {
      throw new AgPayOutcomeUnknownError();
    }
    return response;
  }

  async listPurchaseRequests(status?: CartItemStatus): Promise<CartItemRead[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await this.#request(`${API_PREFIX}/agent/cart-items${query}`);
    validateCartItemList(response);
    return response;
  }

  async getPurchaseRequest(requestId: string): Promise<CartItemRead> {
    const response = await this.#request(
      `${API_PREFIX}/agent/cart-items/${encodeURIComponent(requestId)}`,
    );
    validateCartItem(response);
    return response;
  }

  async listCheckoutEvents(afterCursor: number, signal?: AbortSignal): Promise<CheckoutEventPage> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new Error("Checkout event cursor must be a non-negative safe integer");
    }
    const response = await this.#request(
      `${API_PREFIX}/agent/checkout-events?after_cursor=${afterCursor}&limit=100`,
      { ...(signal === undefined ? {} : { signal }) },
    );
    validateCheckoutEventPage(response);
    return response;
  }

  async recordPurchaseResult(
    requestId: string,
    payload: PurchaseComplete,
  ): Promise<PurchaseRead> {
    const response = await this.#request(
      `${API_PREFIX}/agent/cart-items/${encodeURIComponent(requestId)}/purchase`,
      { method: "POST", body: payload, outcomeSensitive: true },
    );
    try {
      validatePurchase(response);
    } catch {
      throw new AgPayOutcomeUnknownError();
    }
    return response;
  }

  async #request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const authenticated = options.authenticated ?? true;
    if (authenticated && !this.#agentToken) {
      throw new Error("AG Pay agent credential is not configured");
    }

    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (authenticated) {
      headers.set("Authorization", `Bearer ${this.#agentToken}`);
    }

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      if (options.outcomeSensitive) {
        throw new AgPayOutcomeUnknownError();
      }
      throw new Error("AG Pay API request failed before a response was received");
    }

    let text: string;
    try {
      text = await readBoundedResponse(response);
    } catch (error) {
      if (
        options.outcomeSensitive &&
        (response.ok || isAmbiguousMutationStatus(response.status))
      ) {
        throw new AgPayOutcomeUnknownError();
      }
      if (!response.ok) {
        throw new AgPayApiError(response.status, statusMessage(response.status));
      }
      if (error instanceof AgPayResponseSizeError) {
        throw error;
      }
      throw new Error("AG Pay API response could not be read safely");
    }

    if (!response.ok) {
      if (options.outcomeSensitive && isAmbiguousMutationStatus(response.status)) {
        throw new AgPayOutcomeUnknownError();
      }
      throw new AgPayApiError(response.status, statusMessage(response.status));
    }

    let decoded: unknown = null;
    if (text) {
      try {
        decoded = JSON.parse(text) as unknown;
      } catch {
        if (options.outcomeSensitive) {
          throw new AgPayOutcomeUnknownError();
        }
        throw new AgPayApiError(response.status, "AG Pay API returned an invalid JSON response");
      }
    }
    return decoded;
  }
}
