import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

import { AgPayClient } from "./client.js";
import { registerAgPayCli } from "./cli.js";
import { parsePluginConfig, pluginConfigJsonSchema, requireAgentToken } from "./config.js";
import { HeartbeatService } from "./heartbeat.js";
import {
  createGetPurchaseRequestTool,
  createRecordPurchaseResultTool,
  createRequestPurchaseTool,
  type ClientFactory,
} from "./tools.js";

export { AgPayApiError, AgPayClient, AgPayOutcomeUnknownError } from "./client.js";
export type * from "./types.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "agpay",
  name: "AG Pay",
  description:
    "Request supervised purchase approval and record sandbox or external results through AG Pay.",
  configSchema: buildJsonPluginConfigSchema(pluginConfigJsonSchema),
  register(api) {
    const getClient: ClientFactory = () => {
      const config = parsePluginConfig(api.pluginConfig);
      return {
        config,
        client: new AgPayClient({
          apiUrl: config.apiUrl,
          agentToken: requireAgentToken(config),
          timeoutMs: config.requestTimeoutMs,
        }),
      };
    };

    api.registerTool(createRequestPurchaseTool(getClient), { optional: true });
    api.registerTool(createGetPurchaseRequestTool(getClient));
    api.registerTool(createRecordPurchaseResultTool(getClient), { optional: true });

    let heartbeat: HeartbeatService | undefined;
    api.registerService({
      id: "agpay-heartbeat",
      start() {
        try {
          const { client, config } = getClient();
          heartbeat = new HeartbeatService({
            client,
            intervalSeconds: config.heartbeatIntervalSeconds,
            logger: api.logger,
          });
          heartbeat.start();
        } catch {
          api.logger.warn(
            "AG Pay heartbeat is inactive until a valid agentToken SecretRef is configured",
          );
        }
      },
      stop() {
        heartbeat?.stop();
        heartbeat = undefined;
      },
    });

    api.registerCli(
      ({ program }) => registerAgPayCli(program, api.runtime.version),
      {
        descriptors: [
          {
            name: "agpay",
            description: "Pair an OpenClaw runtime with AG Pay",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});

export default plugin;
