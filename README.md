# AG Pay for OpenClaw

An installable OpenClaw plugin that connects one OpenClaw runtime to the AG Pay
agent API. It lets the runtime request supervised purchase approval, inspect a
request, and optionally record a confirmed sandbox or external result.

AG Pay is currently a control plane. This plugin does **not** charge a card,
expose card credentials, or execute a live payment.

## What the plugin adds

- `agpay_request_purchase`: create a purchase request for the paired agent;
- `agpay_get_purchase_request`: read the current state of one request;
- `agpay_record_purchase_result`: record a confirmed sandbox/external result,
  disabled by default and exposed as an optional OpenClaw tool;
- `openclaw agpay pair`: exchange a one-time pairing token without placing it
  in an LLM prompt or shell argument;
- a background heartbeat service that keeps the paired agent online.

The purchase-request tool generates a unique merchant password inside the
trusted plugin runtime and submits it directly to AG Pay. The password is never
returned to the model or written to plugin logs.

This repository ships a native OpenClaw package because the integration needs
more than request/response tools: it also owns a pairing CLI and a heartbeat
service. The AG Pay HTTP API remains the boundary behind the plugin. A separate
MCP adapter can be added later for other agent runtimes without changing these
tool contracts.

## Current boundary

The generated merchant password is currently only a planned credential stored
by the AG Pay control plane. This plugin does not create the merchant account,
navigate checkout, or inject that credential into a browser. A future trusted
checkout executor should receive an opaque credential handle; the password
must not be returned to the model or copied into a second plaintext store.

An `approved` result therefore means that human approval is recorded and an
external executor is required. It does not mean that checkout already happened.

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
plugin or exact tool names. Both `agpay_request_purchase` and
`agpay_record_purchase_result` are optional tools and must be explicitly
allowlisted. Result recording also requires `allowSandboxCompletion: true`.
`agpay_get_purchase_request` is read-only and registered by default.
`allowSandboxCompletion` is a local plugin/tool-policy gate; it is not a scope
encoded in or enforced by the `agt_...` bearer token.

SecretRefs and `0600` files reduce accidental disclosure and access by other OS
users. They do not protect a bearer token from an agent with unrestricted shell
or same-user filesystem access. Run OpenClaw with a tool/filesystem policy that
does not expose its secret provider or token file to model-controlled code.

Mutation requests are never retried automatically. If a proposal or result
recording call loses its response, the plugin reports the outcome as unknown;
inspect AG Pay state before any human-directed recovery action.

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
| Get request | `GET /api/v1/agent/cart-items`, then owner-safe local selection |
| Record result | `POST /api/v1/agent/cart-items/{id}/purchase` |

The current backend does not have an agent-scoped single-item read endpoint, so
the plugin lists only the authenticated agent's items and selects the requested
UUID locally. When that endpoint is added, the client adapter can change without
changing the model-facing tool contract.
