<p align="center">
  <img src="assets/agpay-mark.png" width="112" alt="AG Pay logo" />
</p>

# AG Pay for OpenClaw

An installable OpenClaw plugin that connects one OpenClaw runtime to the AG Pay
agent API. It lets the runtime request supervised purchase approval, inspect a
request, and receive sanitized outcomes after the AG Pay platform handles a
supported configured checkout.

This plugin never receives, injects, logs, or returns card or protected-browser
credentials. Checkout execution belongs to the trusted AG Pay platform and is
available only for adapters explicitly configured there.

## What the plugin adds

- `agpay_request_purchase`: create a purchase request for the paired agent;
- `agpay_get_purchase_request`: read approval and sanitized checkout state;
- `agpay_record_purchase_result`: legacy test-only recording for a request with
  no platform-managed checkout, disabled by default;
- `openclaw agpay pair`: exchange a one-time pairing token without placing it
  in an LLM prompt or shell argument;
- a background heartbeat service that keeps the paired agent online;
- a private outcome monitor that wakes the originating OpenClaw session with a
  fixed, sanitized completion, failure, action-required, or unknown-outcome
  message and, by default, requests delivery of that session's reply to its
  last external user channel.

The purchase-request tool generates a unique merchant password inside the
trusted plugin runtime and submits it directly to AG Pay. The password is never
returned to the model or written to plugin logs.

This repository ships a native OpenClaw package because the integration needs
more than request/response tools: it also owns a pairing CLI and a heartbeat
service. The AG Pay HTTP API remains the boundary behind the plugin. A separate
MCP adapter can be added later for other agent runtimes without changing these
tool contracts.

## Checkout boundary

After approval, the AG Pay platform may queue a checkout through a supported
configured adapter. Managed checkout currently supports one-time purchases
only; recurring requests with a non-null `billing_period` remain approval-only
and cannot include managed-checkout parameters. Browser automation, Browserbase
credentials and session IDs, merchant-account credentials, payment credentials,
and provider secrets remain inside that trusted platform path. They are never
sent to OpenClaw, its model, this plugin's state file, or plugin logs. The plugin
stores only a nonsecret API/agent scope, an event cursor, and bounded
purchase-request-to-session routing metadata so it can route sanitized
outcomes. Because an OpenClaw tool and service may execute in separate
processes, the tool publishes each route as an atomic private state message;
the monitor folds those messages into its cursor registry without either
process overwriting the other's state. Scope changes reset the cursor and
routes; cancelled, unmanaged, and 30-day stale routes are pruned.

An undeliverable outcome keeps its own route and feed cursor pending for retry;
direct reconciliation continues for other tracked requests. If durable prompt
injection is unavailable, the plugin advances only after OpenClaw accepts a
safe system-event fallback that directs the session to read the sanitized
request status.

Each accepted terminal outcome requests an immediate heartbeat for the exact
session that created the purchase request. The wake is hook-scoped so OpenClaw
inspects that session's queued outcome even when `HEARTBEAT.md` is empty.
`outcomeDeliveryTarget: "last"` is
the default and asks OpenClaw to deliver that turn's reply to the last external
channel recorded for that same session; it does not select another session or
an arbitrary recipient. Set it to `"none"` to let the originating session
consume the outcome without an external message. If no last route is available
or channel policy blocks delivery, the scoped turn can still consume the
outcome but OpenClaw will not send an external message. If the immediate wake
cannot be requested, the durable injection remains queued for that session's
next turn.

An `approved` result means checkout is awaiting or entering AG Pay execution;
it is not purchase confirmation. Only a `succeeded` execution event confirms a
recorded purchase. `outcome_unknown` must be reconciled in AG Pay and must never
be retried automatically.

Operators may configure `defaultCheckoutAdapter` and `defaultCheckoutUrl` as a
pair. For a one-time request that omits both model-facing checkout fields, the
plugin injects that non-secret pair directly into the AG Pay API request. This
lets OpenClaw submit a product URL and verified product facts without having to
know the platform's checkout bootstrap URL. An explicit `checkout_adapter` plus
`checkout_url` pair remains authoritative; a partial explicit pair is rejected
rather than combined with a default. When the default pair is absent, omitted
checkout fields preserve the legacy approval-only behavior.

## Requirements

- Node.js `>=22.22.3 <23`, `>=24.15 <25`, or `>=25.9`;
- OpenClaw 2026.7.1-2 or a newer compatible release;
- a reachable AG Pay FastAPI service;
- an AG Pay agent created by the human owner.

The `openclaw agpay pair` command requires a host with POSIX private-file
permissions and is tested on macOS and Linux. It fails closed on Windows
because Node's POSIX file mode does not establish a private Windows ACL. A
Windows runtime may still use the plugin when `agentToken` is provisioned out
of band through a trusted OpenClaw SecretRef provider.

## Development

```bash
pnpm install
make check
make pack-check
```

`make pack-check` runs `pnpm pack --dry-run`; it does not publish anything.
Before a release, install the ClawHub CLI and run `make clawhub-validate`.
OpenClaw's `plugins build` and `plugins validate` authoring commands only apply
to tool-only plugins; this package also registers a CLI and service.

For an end-to-end local runtime, use the sibling
[`ag-openclaw-playground`](https://github.com/AG-Pay-Labs/ag-openclaw-playground)
repository. The complete base, platform, plugin, and playground clone/start
sequence is in the [AG Pay quick start](https://github.com/AG-Pay-Labs/ag-pay#quick-start).

## Pair an agent

On a POSIX host, create or re-pair an agent in the AG Pay web application and
copy its one-time `pair_...` token. Run the plugin-owned command and enter the
token at its hidden prompt; the token is never placed in a command argument:

```bash
openclaw agpay pair \
  --api-url http://127.0.0.1:8000 \
  --output ~/.openclaw/secrets/agpay-agent-token
```

For non-interactive setup, use `--pairing-token-file /private/path` with a
regular `0600` file, or `--pairing-token-env NAME` only when a secret manager
already populated the environment. Do not paste a literal token into `export`
or another shell command: normal shell history may retain it.

The command refuses to overwrite an existing token file unless `--force` is
explicitly supplied. It validates the destination before consuming the one-time
pairing token, rejects symlinked paths, writes through a same-directory
temporary file, and atomically publishes the new credential with mode `0600`.
It never prints the credential.

Configure the file as an OpenClaw SecretRef provider:

```json5
{
  secrets: {
    providers: {
      agpay: {
        source: "file",
        path: "~/.openclaw/secrets/agpay-agent-token",
        mode: "singleValue",
      },
    },
  },
  plugins: {
    entries: {
      agpay: {
        enabled: true,
        config: {
          apiUrl: "http://127.0.0.1:8000",
          agentToken: { source: "file", provider: "agpay", id: "value" },
          heartbeatIntervalSeconds: 60,
          requestTimeoutMs: 10000,
          outcomePollIntervalSeconds: 15,
          outcomeDeliveryTarget: "last",
          defaultCheckoutAdapter: "stripe-hosted",
          defaultCheckoutUrl: "https://checkout.stripe.com/",
          allowSandboxCompletion: false,
        },
      },
    },
  },
}
```

Restart or reload the Gateway, then verify registration:

```bash
openclaw plugins inspect agpay --runtime --json
openclaw secrets audit --check
```

If the OpenClaw installation uses a restrictive tool policy, allow the `agpay`
plugin or exact tool names. `agpay_request_purchase` is optional and must be
explicitly allowlisted. `agpay_get_purchase_request` is read-only and registered
by default. The legacy `agpay_record_purchase_result` tool is also optional,
requires `allowSandboxCompletion: true`, and refuses any request that already
has a platform-managed execution. The flag is a local legacy test gate; it is
not a scope encoded in or enforced by the `agt_...` bearer token.

Pairings created before checkout outcome support should be renewed so the
runtime advertises the `checkout-events.v1` capability.

The example default pair is suitable only when the platform operator has
enabled a matching `stripe-hosted` adapter. Both values are optional, but they
must be configured together, and the URL must use HTTPS without embedded
credentials, a query string, or a fragment. Removing both values restores
approval-only behavior for requests that omit checkout fields.

SecretRefs and `0600` files reduce accidental disclosure and access by other OS
users. They do not protect a bearer token from an agent with unrestricted shell
or same-user filesystem access. Run OpenClaw with a tool/filesystem policy that
does not expose its secret provider or token file to model-controlled code.

Mutation requests are never retried automatically. If a proposal or legacy
result-recording call loses its response, the plugin reports the outcome as
unknown; inspect AG Pay state before any human-directed recovery action. Event
polling uses cursor persistence and retries only the read operation.

## Install a local package build

```bash
pnpm build
pnpm pack
openclaw plugins install ./agpay-openclaw-plugin-0.1.0.tgz
openclaw plugins inspect agpay --runtime --json
```

Publishing to npm or ClawHub is intentionally a separate release action.

## Current API mapping

| Plugin operation | AG Pay endpoint |
| --- | --- |
| Pair | `POST /api/v1/agent/handshake` |
| Heartbeat | `POST /api/v1/agent/heartbeat` |
| Request purchase | `POST /api/v1/agent/cart-items` |
| Get request | `GET /api/v1/agent/cart-items/{id}` |
| Poll sanitized checkout events | `GET /api/v1/agent/checkout-events` |
| Record legacy test result | `POST /api/v1/agent/cart-items/{id}/purchase` |

All reads are scoped by the paired agent credential. Outcome notifications use
fixed plugin-owned wording and normalized reason codes; raw platform, merchant,
browser, or provider errors are never injected into the model.
