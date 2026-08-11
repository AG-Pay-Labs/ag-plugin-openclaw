import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginDefinition,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

import { AgPayClient } from "./client.js";
import { registerAgPayCli } from "./cli.js";
import { parsePluginConfig, pluginConfigJsonSchema, requireAgentToken } from "./config.js";
import { HeartbeatService } from "./heartbeat.js";
import { persistCreatedRequestRoute } from "./outcome-routing.js";
import { CheckoutOutcomeService } from "./outcome-service.js";
import {
  createGetPurchaseRequestTool,
  createRecordPurchaseResultTool,
  createRequestPurchaseTool,
  hasManagedCheckout,
  type ClientFactory,
} from "./tools.js";

export { AgPayApiError, AgPayClient, AgPayOutcomeUnknownError } from "./client.js";
export type * from "./types.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "agpay",
  name: "AG Pay",
  description:
    "Request supervised purchases and receive sanitized managed-checkout outcomes through AG Pay.",
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

    let outcomeService: CheckoutOutcomeService | undefined;

    api.registerTool(
      (ctx: OpenClawPluginToolContext) =>
        createRequestPurchaseTool(getClient, {
          async onRequestCreated(result) {
            if (!ctx.sessionKey || !hasManagedCheckout(result)) {
              return;
            }
            try {
              const { client, config } = getClient();
              await persistCreatedRequestRoute({
                client,
                stateDir: resolveStateDir(),
                apiUrl: config.apiUrl,
                requestId: result.request_id,
                sessionKey: ctx.sessionKey,
              });
            } catch {
              api.logger.warn(
                "AG Pay could not persist purchase outcome session routing",
              );
            }
          },
        }),
      { name: "agpay_request_purchase", optional: true },
    );
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

    api.registerService({
      id: "agpay-outcome-monitor",
      start(ctx) {
        try {
          const { client, config } = getClient();
          outcomeService = new CheckoutOutcomeService({
            client,
            stateDir: ctx.stateDir,
            apiUrl: config.apiUrl,
            pollIntervalSeconds: config.outcomePollIntervalSeconds,
            outcomeDeliveryTarget: config.outcomeDeliveryTarget,
            logger: api.logger,
            notifications: {
              enqueueNextTurnInjection: (input) =>
                api.session.workflow.enqueueNextTurnInjection(input),
              enqueueSystemEvent: (text, options) =>
                api.runtime.system.enqueueSystemEvent(text, options),
              requestHeartbeat: (options) => api.runtime.system.requestHeartbeat(options),
            },
          });
          outcomeService.start();
        } catch {
          api.logger.warn(
            "AG Pay checkout outcome polling is inactive until its credential and private state are available",
          );
        }
      },
      async stop() {
        const service = outcomeService;
        outcomeService = undefined;
        await service?.stop();
      },
    });

    api.lifecycle.registerRuntimeLifecycle({
      id: "agpay-outcome-session-cleanup",
      async cleanup({ reason, sessionKey }) {
        if ((reason !== "reset" && reason !== "delete") || !sessionKey) {
          return;
        }
        try {
          await outcomeService?.forgetSession(sessionKey);
        } catch {
          api.logger.warn("AG Pay could not remove stale purchase outcome session routing");
        }
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
