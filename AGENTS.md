# AG Pay OpenClaw plugin development guide

## Repository boundary

This repository is an independently versioned child repository. It owns the
OpenClaw plugin, its AG Pay agent API client, tests, package metadata, and
release documentation. Do not stage it in the parent `ag-pay` repository or
turn it into a submodule.

The versioned FastAPI agent API in `../ag-platform` remains the authoritative
business and authorization boundary. The plugin may adapt that API but must not
reimplement approval, tenant, assignment, or purchase-transition policy.

## Product and security invariants

- Describe the current integration as requesting approval and recording a
  sandbox/external result. It does not charge a card or pay a merchant.
- Never accept, return, log, or persist raw PAN, CVC, PIN, or 3-D Secure
  secrets.
- Keep pairing and agent bearer tokens out of model prompts, tool arguments,
  tool results, logs, committed configuration, and test fixtures.
- Declare `agentToken` as an OpenClaw SecretRef-compatible config input. Any
  plaintext fallback is for controlled development only and must be called out.
- The model-facing purchase-request tool generates the merchant password
  inside the trusted plugin runtime. It must never return that password.
- The generated merchant password is only a planned control-plane credential
  until a trusted external checkout executor creates or accesses the account.
- Agent identity always comes from the configured bearer token. Never accept
  an owner or agent ID as a model-controlled tool parameter.
- Keep completion reporting disabled by default. Enabling it only permits
  recording a confirmed sandbox/external result; it does not execute payment.
- Tool and API errors must be redacted. Never include request headers, request
  bodies, pairing tokens, agent tokens, or generated passwords in errors.
- Pairing must fail closed on Windows until the CLI can establish and verify a
  private Windows ACL for the agent-token file.

## Required checks

Run these from this repository:

```bash
make lint
make test
make build
make pack-check
```

Before publishing, also run `make clawhub-validate` with the ClawHub CLI and
perform the packaged OpenClaw install/inspect smoke test documented in the
README. OpenClaw's `plugins build` and `plugins validate` commands are only for
tool-only `defineToolPlugin` packages and do not apply to this mixed plugin.

Keep `openclaw.plugin.json`, the runtime registrations, and the package entry
metadata aligned. The package must ship built JavaScript under `dist/`.
