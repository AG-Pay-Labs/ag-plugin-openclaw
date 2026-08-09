import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OutcomeRegistry } from "../src/outcome-registry.js";

import { AGENT_ID, REQUEST_ID } from "./fixtures.js";

const temporaryRoots: string[] = [];
const SCOPE = { apiUrl: "https://agpay.example.test", agentId: AGENT_ID };

async function temporaryStateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agpay-outcomes-"));
  temporaryRoots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OutcomeRegistry", () => {
  it("persists only nonsecret scope, cursor, and request routing with private permissions", async () => {
    const stateDir = await temporaryStateDir();
    const registry = new OutcomeRegistry(stateDir, SCOPE);

    await registry.initialize();
    await registry.track(REQUEST_ID, "agent:main:session:test", 1_000);
    await registry.advance(7);

    const raw = await readFile(registry.stateFilePath, "utf8");
    expect(JSON.parse(raw)).toEqual({
      scope: { api_url: SCOPE.apiUrl, agent_id: AGENT_ID },
      cursor: 7,
      requests: {
        [REQUEST_ID]: { session_key: "agent:main:session:test", tracked_at: 1_000 },
      },
    });
    expect(raw).not.toMatch(/token|password|browser|card/i);
    if (process.platform !== "win32") {
      expect((await stat(dirname(registry.stateFilePath))).mode & 0o777).toBe(0o700);
      expect((await stat(registry.stateFilePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("recovers routing after restart and atomically removes a terminal mapping", async () => {
    const stateDir = await temporaryStateDir();
    const first = new OutcomeRegistry(stateDir, SCOPE);
    await first.track(REQUEST_ID, "agent:main:session:test", 1_000);

    const restarted = new OutcomeRegistry(stateDir, SCOPE);
    await expect(restarted.snapshot()).resolves.toEqual({
      cursor: 0,
      requests: {
        [REQUEST_ID]: { sessionKey: "agent:main:session:test", trackedAt: 1_000 },
      },
    });

    await restarted.advance(11, REQUEST_ID);
    const afterTerminal = new OutcomeRegistry(stateDir, SCOPE);
    await expect(afterTerminal.snapshot()).resolves.toEqual({ cursor: 11, requests: {} });
  });

  it("forgets every tracked request owned by a reset session", async () => {
    const stateDir = await temporaryStateDir();
    const registry = new OutcomeRegistry(stateDir, SCOPE);
    const otherRequest = "88888888-8888-4888-8888-888888888888";
    await registry.track(REQUEST_ID, "agent:main:session:old", 1_000);
    await registry.track(otherRequest, "agent:main:session:keep", 2_000);

    await registry.forgetSession("agent:main:session:old");

    await expect(registry.snapshot()).resolves.toEqual({
      cursor: 0,
      requests: {
        [otherRequest]: { sessionKey: "agent:main:session:keep", trackedAt: 2_000 },
      },
    });
  });

  it("resets cursor and mappings when the API or authenticated agent scope changes", async () => {
    const stateDir = await temporaryStateDir();
    const original = new OutcomeRegistry(stateDir, SCOPE);
    await original.track(REQUEST_ID, "agent:main:session:test", 1_000);
    await original.advance(99);

    const changedApi = new OutcomeRegistry(stateDir, {
      apiUrl: "https://other-agpay.example.test",
      agentId: AGENT_ID,
    });
    await expect(changedApi.snapshot()).resolves.toEqual({ cursor: 0, requests: {} });
    await changedApi.track(REQUEST_ID, "agent:main:session:test", 2_000);
    await changedApi.advance(5);

    const changedAgent = new OutcomeRegistry(stateDir, {
      apiUrl: "https://other-agpay.example.test",
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await expect(changedAgent.snapshot()).resolves.toEqual({ cursor: 0, requests: {} });
  });

  it("prunes persisted routes older than the bounded tracking lifetime", async () => {
    const stateDir = await temporaryStateDir();
    const registry = new OutcomeRegistry(stateDir, SCOPE);
    const freshRequest = "88888888-8888-4888-8888-888888888888";
    await registry.track(REQUEST_ID, "agent:main:session:old", 1_000);
    await registry.track(freshRequest, "agent:main:session:fresh", 2_000);

    await expect(registry.pruneOlderThan(1_500)).resolves.toBe(1);
    await expect(registry.snapshot()).resolves.toEqual({
      cursor: 0,
      requests: {
        [freshRequest]: { sessionKey: "agent:main:session:fresh", trackedAt: 2_000 },
      },
    });
  });
});
