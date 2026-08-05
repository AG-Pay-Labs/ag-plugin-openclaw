import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertPairingPlatform, pairAgent } from "../src/cli.js";

import { AGENT_ID, jsonRequestBody, jsonResponse } from "./fixtures.js";

const PAIRING_TOKEN = `pair_${"p".repeat(32)}`;
const AGENT_TOKEN = `agt_${"a".repeat(32)}`;
const temporaryRoots: string[] = [];

describe("AG Pay pairing platform support", () => {
  it("fails closed when Windows token-file ACLs cannot be enforced", () => {
    expect(() => assertPairingPlatform("win32")).toThrow(
      /unavailable on Windows/,
    );
    expect(() => assertPairingPlatform("darwin")).not.toThrow();
    expect(() => assertPairingPlatform("linux")).not.toThrow();
  });
});

async function privateTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(await realpath(tmpdir()), "agpay-openclaw-test-"));
  await chmod(path, 0o700);
  temporaryRoots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AG Pay pairing credential storage", () => {
  it("publishes the returned credential as a private file without returning the secret", async () => {
    const directory = await privateTemporaryDirectory();
    const output = join(directory, "agent-token");
    let handshakeBody: unknown;
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce((_input, init) => {
      handshakeBody = jsonRequestBody(init);
      return Promise.resolve(
        jsonResponse({
          agent_id: AGENT_ID,
          agent_access_token: AGENT_TOKEN,
          token_type: "bearer",
          expires_at: "2026-08-06T10:00:00.000Z",
        }),
      );
    });

    const result = await pairAgent({
      apiUrl: "https://agpay.example.test",
      output,
      force: false,
      pairingToken: PAIRING_TOKEN,
      instanceId: "test-openclaw-instance",
      softwareVersion: "test",
      fetchImplementation: fetchMock,
    });

    expect(handshakeBody).toMatchObject({
      pairing_token: PAIRING_TOKEN,
      instance_id: "test-openclaw-instance",
    });
    expect(await readFile(output, "utf8")).toBe(AGENT_TOKEN);
    if (process.platform !== "win32") {
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    }
    expect(result).toEqual({
      agentId: AGENT_ID,
      expiresAt: "2026-08-06T10:00:00.000Z",
      outputPath: output,
    });
    expect(JSON.stringify(result)).not.toContain(AGENT_TOKEN);
  });

  it("leaves no destination or temporary credential when the handshake fails", async () => {
    const directory = await privateTemporaryDirectory();
    const output = join(directory, "agent-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "pairing rejected" }, { status: 401 }));

    await expect(
      pairAgent({
        apiUrl: "https://agpay.example.test",
        output,
        force: false,
        pairingToken: PAIRING_TOKEN,
        fetchImplementation: fetchMock,
      }),
    ).rejects.toThrow();

    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("does not overwrite an existing destination or consume a pairing token without force", async () => {
    const directory = await privateTemporaryDirectory();
    const output = join(directory, "agent-token");
    await writeFile(output, "existing-agent-token", { mode: 0o600 });
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      pairAgent({
        apiUrl: "https://agpay.example.test",
        output,
        force: false,
        pairingToken: PAIRING_TOKEN,
        fetchImplementation: fetchMock,
      }),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readFile(output, "utf8")).resolves.toBe("existing-agent-token");
  });

  it("preserves an existing credential when a forced re-pair handshake fails", async () => {
    const directory = await privateTemporaryDirectory();
    const output = join(directory, "agent-token");
    await writeFile(output, "existing-agent-token", { mode: 0o600 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: "pairing rejected" }, { status: 401 }));

    await expect(
      pairAgent({
        apiUrl: "https://agpay.example.test",
        output,
        force: true,
        pairingToken: PAIRING_TOKEN,
        fetchImplementation: fetchMock,
      }),
    ).rejects.toThrow();

    await expect(readFile(output, "utf8")).resolves.toBe("existing-agent-token");
    await expect(readdir(directory)).resolves.toEqual(["agent-token"]);
  });
});
