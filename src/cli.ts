import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

import { AgPayClient } from "./client.js";
import { normalizeApiUrl } from "./config.js";

const DEFAULT_SECRET_PATH = "~/.openclaw/secrets/agpay-agent-token";
interface CommandLike {
  command(name: string): CommandLike;
  description(value: string): CommandLike;
  option(flags: string, description: string, defaultValue?: string | boolean): CommandLike;
  action(handler: (options: PairCommandOptions) => Promise<void>): CommandLike;
}

interface PairCommandOptions {
  apiUrl: string;
  output: string;
  pairingTokenEnv?: string;
  pairingTokenFile?: string;
  instanceId?: string;
  softwareVersion?: string;
  force: boolean;
}

export interface PairAgentOptions extends PairCommandOptions {
  pairingToken: string;
  fetchImplementation?: typeof fetch;
}

export function assertPairingPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    throw new Error(
      "AG Pay pairing is unavailable on Windows because private token-file ACL enforcement is not implemented",
    );
  }
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

function defaultInstanceId(): string {
  const safeHost = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 220);
  return `openclaw-${safeHost || "host"}`;
}

async function inspectOutputTarget(path: string, force: boolean): Promise<void> {
  try {
    const target = await lstat(path);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw new Error("The AG Pay token output must be a regular file, not a symlink");
    }
    if (!force) {
      throw new Error("The AG Pay token file already exists; use --force only when re-pairing");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await mkdir(current, { mode: 0o700 });
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("The AG Pay token directory must not contain symlinked components");
    }
  }
  const directory = await lstat(absolute);
  if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) {
    throw new Error("The AG Pay token directory must not be accessible by group or other users");
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    directory.uid !== process.getuid()
  ) {
    throw new Error("The AG Pay token directory must be owned by the current user");
  }
}

interface SecretFileReservation {
  commit(value: string): Promise<void>;
  abort(): Promise<void>;
}

async function reserveSecretFile(path: string, force: boolean): Promise<SecretFileReservation> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  await inspectOutputTarget(path, force);

  const temporaryPath = join(
    parent,
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  const file = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let closed = false;
  let temporaryPresent = true;

  const close = async () => {
    if (!closed) {
      await file.close();
      closed = true;
    }
  };

  return {
    async commit(value) {
      await file.writeFile(value, { encoding: "utf8" });
      await file.chmod(0o600);
      await file.sync();
      await close();
      if (force) {
        await rename(temporaryPath, path);
        temporaryPresent = false;
      } else {
        await link(temporaryPath, path);
        await unlink(temporaryPath);
        temporaryPresent = false;
      }
      const target = await lstat(path);
      if (
        target.isSymbolicLink() ||
        !target.isFile() ||
        (process.platform !== "win32" && (target.mode & 0o777) !== 0o600)
      ) {
        throw new Error("The AG Pay token file was not stored with private permissions");
      }
    },
    async abort() {
      await close();
      if (temporaryPresent) {
        await unlink(temporaryPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        });
      }
    },
  };
}

async function readBoundedStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 256) {
      throw new Error("Pairing token input is too long");
    }
  }
  return input.trim();
}

async function promptForPairingToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return readBoundedStdin();
  }
  process.stdout.write("AG Pay pairing token: ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolvePrompt, rejectPrompt) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode?.(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          rejectPrompt(new Error("Pairing cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolvePrompt(value.trim());
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (value.length < 256) {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readPairingToken(options: PairCommandOptions): Promise<string> {
  if (options.pairingTokenEnv && options.pairingTokenFile) {
    throw new Error("Use only one of --pairing-token-env or --pairing-token-file");
  }
  if (options.pairingTokenEnv) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(options.pairingTokenEnv)) {
      throw new Error("--pairing-token-env must name a valid uppercase environment variable");
    }
    return process.env[options.pairingTokenEnv]?.trim() ?? "";
  }
  if (options.pairingTokenFile) {
    const inputPath = expandHome(options.pairingTokenFile);
    const inputPathEntry = await lstat(inputPath);
    if (inputPathEntry.isSymbolicLink()) {
      throw new Error("The pairing-token input must be a small regular file, not a symlink");
    }
    const inputFile = await open(
      inputPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const input = await inputFile.stat();
      if (!input.isFile() || input.size > 256) {
        throw new Error("The pairing-token input must be a small regular file, not a symlink");
      }
      if (process.platform !== "win32" && (input.mode & 0o077) !== 0) {
        throw new Error("The pairing-token file must not be accessible by group or other users");
      }
      const buffer = Buffer.alloc(257);
      const { bytesRead } = await inputFile.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256) {
        throw new Error("Pairing token input is too long");
      }
      return buffer.subarray(0, bytesRead).toString("utf8").trim();
    } finally {
      await inputFile.close();
    }
  }
  return promptForPairingToken();
}

export async function pairAgent(options: PairAgentOptions): Promise<{
  agentId: string;
  expiresAt: string;
  outputPath: string;
}> {
  assertPairingPlatform();
  const pairingToken = options.pairingToken;
  if (
    !pairingToken?.startsWith("pair_") ||
    pairingToken.length < 20 ||
    pairingToken.length > 200 ||
    !/^pair_[A-Za-z0-9_-]+$/.test(pairingToken)
  ) {
    throw new Error("A valid AG Pay pairing token is required");
  }
  const instanceId = (options.instanceId ?? defaultInstanceId()).trim();
  if (!instanceId || instanceId.length > 255) {
    throw new Error("The AG Pay instance ID must contain 1 to 255 characters");
  }
  if (options.softwareVersion !== undefined && options.softwareVersion.length > 100) {
    throw new Error("The OpenClaw software version must not exceed 100 characters");
  }

  const outputPath = expandHome(options.output);
  const reservation = await reserveSecretFile(outputPath, options.force);

  try {
    const client = new AgPayClient({
      apiUrl: normalizeApiUrl(options.apiUrl),
      timeoutMs: 10_000,
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
    });
    const response = await client.pair({
      pairing_token: pairingToken,
      instance_id: instanceId,
      ...(options.softwareVersion === undefined
        ? {}
        : { software_version: options.softwareVersion }),
      capabilities: [
        "cart-items.v1",
        "checkout-events.v1",
        "heartbeat.v1",
        "agpay.openclaw-plugin.v1",
      ],
    });
    try {
      await reservation.commit(response.agent_access_token);
    } catch {
      throw new Error(
        "Pairing succeeded but the agent credential could not be stored. Re-pair the AG Pay agent.",
      );
    }
    return { agentId: response.agent_id, expiresAt: response.expires_at, outputPath };
  } finally {
    await reservation.abort();
  }
}

export function registerAgPayCli(program: CommandLike, openClawVersion: string): void {
  const agpay = program
    .command("agpay")
    .description("Pair an OpenClaw runtime with AG Pay");
  agpay
    .command("pair")
    .description("Exchange an AG Pay pairing token and store the agent credential privately")
    .option("--api-url <url>", "AG Pay FastAPI base URL", "http://127.0.0.1:8000")
    .option("--output <path>", "Private output file for the agent token", DEFAULT_SECRET_PATH)
    .option("--pairing-token-env <name>", "Environment variable containing the pairing token")
    .option("--pairing-token-file <path>", "Private file containing the pairing token")
    .option("--instance-id <id>", "Installation-specific identifier")
    .option("--force", "Replace an existing regular token file when re-pairing", false)
    .action(async (options) => {
      assertPairingPlatform();
      const pairingToken = await readPairingToken(options);
      const result = await pairAgent({
        ...options,
        pairingToken,
        softwareVersion: openClawVersion,
      });
      console.log(`Paired AG Pay agent ${result.agentId}.`);
      console.log("Agent credential stored in the configured private output file with mode 0600.");
      console.log(`Credential expires at ${result.expiresAt}.`);
      console.log(
        'Configure plugins.entries.agpay.config.agentToken with { source: "file", provider: "agpay", id: "value" }.',
      );
    });
}
