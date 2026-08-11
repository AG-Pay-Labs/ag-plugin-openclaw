import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgPayClient } from "../src/client.js";
import { OutcomeRegistry } from "../src/outcome-registry.js";
import { persistCreatedRequestRoute } from "../src/outcome-routing.js";

import { AGENT_ID, jsonResponse, REQUEST_ID } from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;
const API_URL = "https://agpay.example.test";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("cross-process outcome routing", () => {
  it("persists the tool session under its heartbeat-derived agent scope", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agpay-outcome-routing-"));
    temporaryRoots.push(stateDir);
    const runningRegistry = new OutcomeRegistry(stateDir, {
      apiUrl: API_URL,
      agentId: AGENT_ID,
    });
    await runningRegistry.initialize();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        agent_id: AGENT_ID,
        connection_state: "online",
        server_time: "2026-08-10T10:00:00.000Z",
      }),
    );

    await persistCreatedRequestRoute({
      client: new AgPayClient({
        apiUrl: API_URL,
        agentToken: AGENT_TOKEN,
        fetchImplementation: fetchMock,
      }),
      stateDir,
      apiUrl: API_URL,
      requestId: REQUEST_ID,
      sessionKey: "agent:main:session:tool-process",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_URL}/api/v1/agent/heartbeat`,
      expect.objectContaining({ method: "POST" }),
    );
    await expect(runningRegistry.snapshot()).resolves.toMatchObject({
      requests: {
        [REQUEST_ID]: { sessionKey: "agent:main:session:tool-process" },
      },
    });
  });
});
