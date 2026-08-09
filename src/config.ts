const DEFAULT_API_URL = "http://127.0.0.1:8000";
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OUTCOME_POLL_INTERVAL_SECONDS = 15;

export const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    apiUrl: {
      type: "string",
      format: "uri",
      default: DEFAULT_API_URL,
      description: "Root URL of the AG Pay FastAPI service. HTTPS is required outside loopback.",
    },
    agentToken: {
      type: ["string", "object"],
      minLength: 20,
      maxLength: 200,
      pattern: "^agt_[A-Za-z0-9_-]+$",
      description: "Agent bearer credential. Configure it through an OpenClaw SecretRef.",
    },
    heartbeatIntervalSeconds: {
      type: "integer",
      minimum: 15,
      maximum: 110,
      default: DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
    },
    requestTimeoutMs: {
      type: "integer",
      minimum: 1_000,
      maximum: 60_000,
      default: DEFAULT_REQUEST_TIMEOUT_MS,
    },
    outcomePollIntervalSeconds: {
      type: "integer",
      minimum: 5,
      maximum: 300,
      default: DEFAULT_OUTCOME_POLL_INTERVAL_SECONDS,
      description: "Seconds between sanitized managed-checkout outcome polls.",
    },
    allowSandboxCompletion: {
      type: "boolean",
      default: false,
    },
  },
};

export interface AgPayPluginConfig {
  apiUrl: string;
  agentToken?: string;
  heartbeatIntervalSeconds: number;
  requestTimeoutMs: number;
  outcomePollIntervalSeconds: number;
  allowSandboxCompletion: boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AG Pay plugin configuration must be an object");
  }
  return value as Record<string, unknown>;
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

export function normalizeApiUrl(value: unknown): string {
  if (value !== undefined && typeof value !== "string") {
    throw new Error("apiUrl must be an HTTP(S) URL");
  }
  let url: URL;
  try {
    url = new URL(value ?? DEFAULT_API_URL);
  } catch {
    throw new Error("apiUrl must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("apiUrl must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("apiUrl must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("apiUrl must not contain a query string or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("apiUrl must be the service root and must not contain a path");
  }
  const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "https:" && !loopbackHostnames.has(url.hostname)) {
    throw new Error("apiUrl must use HTTPS except for an explicit loopback address");
  }
  return url.toString().replace(/\/$/, "");
}

export function parsePluginConfig(value: unknown): AgPayPluginConfig {
  const raw = objectValue(value);
  const token = raw.agentToken;
  if (
    token !== undefined &&
    (typeof token !== "string" ||
      token.length < 20 ||
      token.length > 200 ||
      !/^agt_[A-Za-z0-9_-]+$/.test(token))
  ) {
    throw new Error(
      "agentToken is unavailable or invalid; configure a resolved agt_ SecretRef for the AG Pay plugin",
    );
  }
  if (raw.allowSandboxCompletion !== undefined && typeof raw.allowSandboxCompletion !== "boolean") {
    throw new Error("allowSandboxCompletion must be a boolean");
  }

  return {
    apiUrl: normalizeApiUrl(raw.apiUrl),
    ...(token === undefined ? {} : { agentToken: token }),
    heartbeatIntervalSeconds: integerInRange(
      raw.heartbeatIntervalSeconds,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
      15,
      110,
      "heartbeatIntervalSeconds",
    ),
    requestTimeoutMs: integerInRange(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1_000,
      60_000,
      "requestTimeoutMs",
    ),
    outcomePollIntervalSeconds: integerInRange(
      raw.outcomePollIntervalSeconds,
      DEFAULT_OUTCOME_POLL_INTERVAL_SECONDS,
      5,
      300,
      "outcomePollIntervalSeconds",
    ),
    allowSandboxCompletion: raw.allowSandboxCompletion ?? false,
  };
}

export function requireAgentToken(config: AgPayPluginConfig): string {
  if (!config.agentToken) {
    throw new Error(
      "AG Pay is not paired. Configure plugins.entries.agpay.config.agentToken with an OpenClaw SecretRef.",
    );
  }
  return config.agentToken;
}
