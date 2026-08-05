import { afterEach, describe, expect, it, vi } from "vitest";

import { AgPayClient } from "../src/client.js";
import { HeartbeatService } from "../src/heartbeat.js";

import { jsonResponse } from "./fixtures.js";

const AGENT_TOKEN = `agt_${"a".repeat(32)}`;

afterEach(() => {
  vi.useRealTimers();
});

describe("HeartbeatService", () => {
  it("stops scheduling heartbeats after the server rejects the credential", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ detail: "invalid credential" }, { status: 401 }));
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const service = new HeartbeatService({
      client: new AgPayClient({
        apiUrl: "https://agpay.example.test",
        agentToken: AGENT_TOKEN,
        fetchImplementation: fetchMock,
      }),
      intervalSeconds: 15,
      logger,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
