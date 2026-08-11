import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_STATE_BYTES = 1_048_576;
const MAX_INBOX_ROUTE_BYTES = 8_192;
const MAX_TRACKED_REQUESTS = 1_000;
const MAX_SESSION_KEY_LENGTH = 1_024;
const MAX_API_URL_LENGTH = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INBOX_DIRECTORY_NAME = "checkout-outcome-routes";
const INBOX_FILE_PATTERN = new RegExp(
  `^checkout-route-(${UUID_PATTERN.source.slice(1, -1)})-(${UUID_PATTERN.source.slice(1, -1)})\\.json$`,
  "i",
);

interface StoredOutcomeScope {
  api_url: string;
  agent_id: string;
}

export interface OutcomeRegistryScope {
  apiUrl: string;
  agentId: string;
}

export interface OutcomeRoute {
  sessionKey: string;
  trackedAt: number;
}

interface StoredOutcomeRoute {
  session_key: string;
  tracked_at: number;
}

interface StoredInboxRoute extends StoredOutcomeRoute {
  scope: StoredOutcomeScope;
  request_id: string;
}

interface OutcomeRegistryState {
  scope: StoredOutcomeScope;
  cursor: number;
  requests: Record<string, StoredOutcomeRoute>;
}

export interface OutcomeRegistrySnapshot {
  cursor: number;
  requests: Readonly<Record<string, OutcomeRoute>>;
}

function normalizeScope(value: OutcomeRegistryScope): StoredOutcomeScope {
  if (value.apiUrl.length < 1 || value.apiUrl.length > MAX_API_URL_LENGTH) {
    throw new Error("AG Pay outcome registry API scope is invalid");
  }
  let apiUrl: URL;
  try {
    apiUrl = new URL(value.apiUrl);
  } catch {
    throw new Error("AG Pay outcome registry API scope is invalid");
  }
  if (
    (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error("AG Pay outcome registry API scope is invalid");
  }
  if (!UUID_PATTERN.test(value.agentId)) {
    throw new Error("AG Pay outcome registry agent scope is invalid");
  }
  return { api_url: value.apiUrl, agent_id: value.agentId.toLowerCase() };
}

function emptyState(scope: StoredOutcomeScope): OutcomeRegistryState {
  return { scope, cursor: 0, requests: {} };
}

function storedScope(value: unknown): StoredOutcomeScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (
    typeof data.api_url !== "string" ||
    data.api_url.length < 1 ||
    data.api_url.length > MAX_API_URL_LENGTH ||
    typeof data.agent_id !== "string" ||
    !UUID_PATTERN.test(data.agent_id)
  ) {
    return null;
  }
  return { api_url: data.api_url, agent_id: data.agent_id.toLowerCase() };
}

function scopesEqual(left: StoredOutcomeScope, right: StoredOutcomeScope): boolean {
  return left.api_url === right.api_url && left.agent_id === right.agent_id;
}

function validateRouteValues(requestId: string, sessionKey: string, trackedAt: number): void {
  if (!UUID_PATTERN.test(requestId)) {
    throw new Error("AG Pay purchase request ID is invalid");
  }
  if (sessionKey.length < 1 || sessionKey.length > MAX_SESSION_KEY_LENGTH) {
    throw new Error("OpenClaw session key is invalid");
  }
  if (!Number.isSafeInteger(trackedAt) || trackedAt < 0) {
    throw new Error("AG Pay outcome tracking timestamp is invalid");
  }
}

function storedInboxRoute(value: unknown, scope: StoredOutcomeScope): StoredInboxRoute | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  const routeScope = storedScope(data.scope);
  if (
    !routeScope ||
    !scopesEqual(routeScope, scope) ||
    typeof data.request_id !== "string" ||
    !UUID_PATTERN.test(data.request_id) ||
    typeof data.session_key !== "string" ||
    data.session_key.length < 1 ||
    data.session_key.length > MAX_SESSION_KEY_LENGTH ||
    !Number.isSafeInteger(data.tracked_at) ||
    (data.tracked_at as number) < 0
  ) {
    return null;
  }
  return {
    scope: routeScope,
    request_id: data.request_id.toLowerCase(),
    session_key: data.session_key,
    tracked_at: data.tracked_at as number,
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("AG Pay outcome routing path must be a private directory");
  }
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function validateState(value: unknown, scope: StoredOutcomeScope): OutcomeRegistryState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("AG Pay outcome registry is invalid");
  }
  const data = value as Record<string, unknown>;
  const existingScope = storedScope(data.scope);
  if (!existingScope || !scopesEqual(existingScope, scope)) {
    return null;
  }
  if (!Number.isSafeInteger(data.cursor) || (data.cursor as number) < 0) {
    throw new Error("AG Pay outcome registry cursor is invalid");
  }
  if (typeof data.requests !== "object" || data.requests === null || Array.isArray(data.requests)) {
    throw new Error("AG Pay outcome registry request map is invalid");
  }
  const entries = Object.entries(data.requests as Record<string, unknown>);
  if (entries.length > MAX_TRACKED_REQUESTS) {
    throw new Error("AG Pay outcome registry contains too many requests");
  }
  const requests: Record<string, StoredOutcomeRoute> = {};
  for (const [requestId, rawRoute] of entries) {
    if (typeof rawRoute !== "object" || rawRoute === null || Array.isArray(rawRoute)) {
      throw new Error("AG Pay outcome registry contains an invalid request mapping");
    }
    const route = rawRoute as Record<string, unknown>;
    if (
      !UUID_PATTERN.test(requestId) ||
      typeof route.session_key !== "string" ||
      route.session_key.length < 1 ||
      route.session_key.length > MAX_SESSION_KEY_LENGTH ||
      !Number.isSafeInteger(route.tracked_at) ||
      (route.tracked_at as number) < 0
    ) {
      throw new Error("AG Pay outcome registry contains an invalid request mapping");
    }
    requests[requestId] = {
      session_key: route.session_key,
      tracked_at: route.tracked_at as number,
    };
  }
  return { scope, cursor: data.cursor as number, requests };
}

function publicRoutes(
  requests: Readonly<Record<string, StoredOutcomeRoute>>,
): Record<string, OutcomeRoute> {
  return Object.fromEntries(
    Object.entries(requests).map(([requestId, route]) => [
      requestId,
      { sessionKey: route.session_key, trackedAt: route.tracked_at },
    ]),
  );
}

/**
 * Writes one immutable routing message for the long-running outcome monitor.
 * The tool runtime can execute in a separate process, so it must never mutate
 * the monitor's cursor registry directly.
 */
export async function enqueueOutcomeRoute(
  stateDir: string,
  scope: OutcomeRegistryScope,
  requestId: string,
  sessionKey: string,
  trackedAt = Date.now(),
): Promise<void> {
  if (!isAbsolute(stateDir)) {
    throw new Error("OpenClaw state directory must be absolute");
  }
  const normalizedScope = normalizeScope(scope);
  validateRouteValues(requestId, sessionKey, trackedAt);
  const directory = join(stateDir, "agpay");
  const inboxDirectory = join(directory, INBOX_DIRECTORY_NAME);
  await ensurePrivateDirectory(directory);
  await ensurePrivateDirectory(inboxDirectory);
  const inboxEntries = await readdir(inboxDirectory, { withFileTypes: true });
  if (
    inboxEntries.filter((entry) => INBOX_FILE_PATTERN.test(entry.name)).length >=
    MAX_TRACKED_REQUESTS
  ) {
    throw new Error("AG Pay outcome routing inbox is full");
  }

  const route: StoredInboxRoute = {
    scope: normalizedScope,
    request_id: requestId.toLowerCase(),
    session_key: sessionKey,
    tracked_at: trackedAt,
  };
  const serialized = `${JSON.stringify(route)}\n`;
  if (Buffer.byteLength(serialized) > MAX_INBOX_ROUTE_BYTES) {
    throw new Error("AG Pay outcome routing message exceeds the allowed size");
  }
  const messageId = randomUUID();
  const filePath = join(
    inboxDirectory,
    `checkout-route-${requestId.toLowerCase()}-${messageId}.json`,
  );
  const temporaryPath = join(inboxDirectory, `.checkout-route-${messageId}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, PRIVATE_FILE_MODE);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlinkIfPresent(temporaryPath);
  }
}

export class OutcomeRegistry {
  readonly #directory: string;
  readonly #inboxDirectory: string;
  readonly #filePath: string;
  readonly #scope: StoredOutcomeScope;
  #state: OutcomeRegistryState | undefined;
  #operations: Promise<void> = Promise.resolve();

  constructor(stateDir: string, scope: OutcomeRegistryScope) {
    this.#directory = join(stateDir, "agpay");
    this.#inboxDirectory = join(this.#directory, INBOX_DIRECTORY_NAME);
    this.#filePath = join(this.#directory, "checkout-outcomes.json");
    this.#scope = normalizeScope(scope);
  }

  get stateFilePath(): string {
    return this.#filePath;
  }

  async initialize(): Promise<void> {
    await this.#serialize(async () => {
      await this.#ensureInitialized();
    });
  }

  async snapshot(): Promise<OutcomeRegistrySnapshot> {
    return this.#serialize(async () => {
      const state = await this.#ensureInitialized();
      await this.#drainInbox(state);
      return { cursor: state.cursor, requests: publicRoutes(state.requests) };
    });
  }

  async track(requestId: string, sessionKey: string, trackedAt = Date.now()): Promise<void> {
    validateRouteValues(requestId, sessionKey, trackedAt);
    await this.#serialize(async () => {
      const state = await this.#ensureInitialized();
      await this.#drainInbox(state);
      const previousRequests = { ...state.requests };
      this.#storeRoute(
        state,
        requestId.toLowerCase(),
        { session_key: sessionKey, tracked_at: trackedAt },
        true,
      );
      try {
        await this.#persist(state);
      } catch (error) {
        state.requests = previousRequests;
        throw error;
      }
    });
  }

  async advance(cursor: number, removeRequestId?: string): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("AG Pay checkout event cursor is invalid");
    }
    await this.#serialize(async () => {
      const state = await this.#ensureInitialized();
      await this.#drainInbox(state);
      const previousCursor = state.cursor;
      const previousRoute = removeRequestId ? state.requests[removeRequestId] : undefined;
      state.cursor = Math.max(state.cursor, cursor);
      if (removeRequestId) {
        delete state.requests[removeRequestId];
      }
      if (state.cursor === previousCursor && previousRoute === undefined) {
        return;
      }
      try {
        await this.#persist(state);
      } catch (error) {
        state.cursor = previousCursor;
        if (removeRequestId && previousRoute !== undefined) {
          state.requests[removeRequestId] = previousRoute;
        }
        throw error;
      }
    });
  }

  async forgetRequest(requestId: string): Promise<void> {
    await this.#serialize(async () => {
      const state = await this.#ensureInitialized();
      await this.#drainInbox(state);
      const previous = state.requests[requestId];
      if (!previous) {
        return;
      }
      delete state.requests[requestId];
      try {
        await this.#persist(state);
      } catch (error) {
        state.requests[requestId] = previous;
        throw error;
      }
    });
  }

  async pruneOlderThan(cutoff: number): Promise<number> {
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new Error("AG Pay outcome pruning timestamp is invalid");
    }
    return this.#serialize(async () => {
      const state = await this.#ensureInitialized();
      await this.#drainInbox(state);
      const removed = Object.entries(state.requests).filter(([, route]) => route.tracked_at < cutoff);
      if (removed.length === 0) {
        return 0;
      }
      for (const [requestId] of removed) {
        delete state.requests[requestId];
      }
      try {
        await this.#persist(state);
      } catch (error) {
        for (const [requestId, route] of removed) {
          state.requests[requestId] = route;
        }
        throw error;
      }
      return removed.length;
    });
  }

  async forgetSession(sessionKey: string): Promise<void> {
    await this.#serialize(async () => {
      const state = await this.#ensureInitialized();
      await this.#drainInbox(state);
      const removed = Object.entries(state.requests).filter(
        ([, route]) => route.session_key === sessionKey,
      );
      if (removed.length === 0) {
        return;
      }
      for (const [requestId] of removed) {
        delete state.requests[requestId];
      }
      try {
        await this.#persist(state);
      } catch (error) {
        for (const [requestId, route] of removed) {
          state.requests[requestId] = route;
        }
        throw error;
      }
    });
  }

  async #drainInbox(state: OutcomeRegistryState): Promise<void> {
    await ensurePrivateDirectory(this.#inboxDirectory);
    const entries = (await readdir(this.#inboxDirectory, { withFileTypes: true }))
      .filter((entry) => INBOX_FILE_PATTERN.test(entry.name))
      .slice(0, MAX_TRACKED_REQUESTS);
    if (entries.length === 0) {
      return;
    }

    const previousRequests = { ...state.requests };
    const consumedPaths: string[] = [];
    let changed = false;
    for (const entry of entries) {
      const filePath = join(this.#inboxDirectory, entry.name);
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size < 1 ||
        metadata.size > MAX_INBOX_ROUTE_BYTES
      ) {
        if (metadata.isFile() || metadata.isSymbolicLink()) {
          await unlinkIfPresent(filePath);
        }
        continue;
      }

      let route: StoredInboxRoute | null = null;
      try {
        route = storedInboxRoute(
          JSON.parse(await readFile(filePath, "utf8")) as unknown,
          this.#scope,
        );
      } catch {
        route = null;
      }
      const filenameRequestId = INBOX_FILE_PATTERN.exec(entry.name)?.[1]?.toLowerCase();
      if (!route || route.request_id !== filenameRequestId) {
        await unlinkIfPresent(filePath);
        continue;
      }
      consumedPaths.push(filePath);
      changed = this.#storeRoute(state, route.request_id, route) || changed;
    }

    if (changed) {
      try {
        await this.#persist(state);
      } catch (error) {
        state.requests = previousRequests;
        throw error;
      }
    }
    await Promise.all(consumedPaths.map(async (path) => unlinkIfPresent(path)));
  }

  #storeRoute(
    state: OutcomeRegistryState,
    requestId: string,
    route: StoredOutcomeRoute,
    replaceExisting = false,
  ): boolean {
    const existing = state.requests[requestId];
    if (
      existing &&
      !replaceExisting &&
      existing.tracked_at >= route.tracked_at
    ) {
      return false;
    }
    if (
      existing &&
      existing.tracked_at === route.tracked_at &&
      existing.session_key === route.session_key
    ) {
      return false;
    }
    if (!existing && Object.keys(state.requests).length >= MAX_TRACKED_REQUESTS) {
      const oldest = Object.entries(state.requests).sort(
        ([, left], [, right]) => left.tracked_at - right.tracked_at,
      )[0];
      if (oldest) {
        delete state.requests[oldest[0]];
      }
    }
    state.requests[requestId] = {
      session_key: route.session_key,
      tracked_at: route.tracked_at,
    };
    return true;
  }

  async #ensureInitialized(): Promise<OutcomeRegistryState> {
    if (this.#state) {
      return this.#state;
    }
    await ensurePrivateDirectory(this.#directory);
    try {
      const metadata = await lstat(this.#filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("AG Pay outcome registry must be a regular file");
      }
      if (metadata.size > MAX_STATE_BYTES) {
        throw new Error("AG Pay outcome registry exceeds the allowed size");
      }
      await chmod(this.#filePath, PRIVATE_FILE_MODE);
      const raw = await readFile(this.#filePath, "utf8");
      const loaded = validateState(JSON.parse(raw) as unknown, this.#scope);
      this.#state = loaded ?? emptyState(this.#scope);
      if (!loaded) {
        await this.#persist(this.#state);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.#state = emptyState(this.#scope);
      await this.#persist(this.#state);
    }
    return this.#state;
  }

  async #persist(state: OutcomeRegistryState): Promise<void> {
    const temporaryPath = join(this.#directory, `.checkout-outcomes-${randomUUID()}.tmp`);
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new Error("AG Pay outcome registry exceeds the allowed size");
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);
      await chmod(this.#filePath, PRIVATE_FILE_MODE);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlinkIfPresent(temporaryPath);
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
