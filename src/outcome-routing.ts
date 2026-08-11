import type { AgPayClient } from "./client.js";
import { enqueueOutcomeRoute } from "./outcome-registry.js";

interface PersistCreatedRequestRouteOptions {
  client: AgPayClient;
  stateDir: string;
  apiUrl: string;
  requestId: string;
  sessionKey: string;
}

/**
 * Resolves the bearer token's agent identity before writing a scoped handoff.
 * No credential or checkout payload is persisted in OpenClaw state.
 */
export async function persistCreatedRequestRoute(
  options: PersistCreatedRequestRouteOptions,
): Promise<void> {
  const identity = await options.client.heartbeat();
  await enqueueOutcomeRoute(
    options.stateDir,
    { apiUrl: options.apiUrl, agentId: identity.agent_id },
    options.requestId,
    options.sessionKey,
  );
}
