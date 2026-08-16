import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { pluginConfigJsonSchema } from "../src/config.js";
import plugin from "../src/index.js";

interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  uiHints: Record<string, unknown>;
  configSchema: Record<string, unknown>;
}

interface PackageMetadata {
  version: string;
  openclaw: {
    extensions: string[];
    runtimeExtensions: string[];
  };
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

describe("OpenClaw package metadata", () => {
  it("keeps runtime identity, version, and config schema aligned with the manifest", () => {
    const manifest = readJson<PluginManifest>("../openclaw.plugin.json");
    const packageMetadata = readJson<PackageMetadata>("../package.json");
    expect({
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
    }).toEqual({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
    });
    expect(pluginConfigJsonSchema).toEqual(manifest.configSchema);
    expect(packageMetadata.version).toBe(manifest.version);
    expect(packageMetadata.openclaw.extensions).toContain("./src/index.ts");
    expect(packageMetadata.openclaw.runtimeExtensions).toContain("./dist/index.js");
  });

  it("accepts a SecretRef-shaped agent token before OpenClaw materializes it", () => {
    const safeParse = plugin.configSchema?.safeParse;
    if (!safeParse) {
      throw new Error("AG Pay plugin config schema is unavailable");
    }
    const result = safeParse({
      agentToken: {
        source: "file",
        provider: "agpay",
        id: "value",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects removed managed-checkout defaults at schema level", () => {
    const safeParse = plugin.configSchema?.safeParse;
    if (!safeParse) {
      throw new Error("AG Pay plugin config schema is unavailable");
    }
    const manifest = readJson<PluginManifest>("../openclaw.plugin.json");

    expect(
      safeParse({
        defaultCheckoutAdapter: "stripe-hosted",
        defaultCheckoutUrl:
          "https://checkout.stripe.com/c/pay/cs_test_Manifest123#stripe-generated-fragment",
      }).success,
    ).toBe(false);
    expect(safeParse({ defaultCheckoutAdapter: "stripe-hosted" }).success).toBe(false);
    expect(
      safeParse({
        defaultCheckoutUrl:
          "https://checkout.stripe.com/c/pay/cs_test_Manifest123#stripe-generated-fragment",
      }).success,
    ).toBe(false);
    expect(manifest.uiHints).not.toHaveProperty("defaultCheckoutAdapter");
    expect(manifest.uiHints).not.toHaveProperty("defaultCheckoutUrl");
    expect(manifest.configSchema).not.toHaveProperty(
      "properties.defaultCheckoutAdapter",
    );
    expect(manifest.configSchema).not.toHaveProperty("properties.defaultCheckoutUrl");
  });
});
