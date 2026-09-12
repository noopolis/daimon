# Engines

[Documentation index](README.md)

Daimon has two layers:

- The runtime-neutral harness contract in `src/core`.
- Engine adapters under `src/pi` and `src/runtime`.

The simple one-agent contract is:

```ts
import type { AgentHarnessAdapter, WakeEvent } from "@noopolis/daimon";
```

`AgentHarnessAdapter.startAgent()` receives one agent's id, name,
instructions, workspace path, runtime home, and optional tool names. The
returned handle accepts one `WakeEvent` at a time and returns text, duration,
and status.

## Pi

`@noopolis/daimon/pi` exports `PiHarnessAdapter` and helpers for Pi auth,
models, world tools, and traces:

```ts
import { PiHarnessAdapter } from "@noopolis/daimon/pi";
```

The Pi adapter creates the runtime-home subdirectories it needs, creates the
workspace if absent, resolves a Pi model, mounts optional Mneme and world tools,
and creates awake or dream sessions. Caller instructions are included in the
system prompt; SOUL or identity-like standing instructions belong in the
agent's `instructions` field supplied by the caller.

Model intents support built-in Pi providers and explicit OpenAI-compatible or
Anthropic-compatible endpoints. Endpoint auth is limited to `none` or
`api_key`; Codex and Claude subscription helpers write Pi auth storage instead.

Auth helpers:

- `seedPiOpenAICodexAuthFromCodex`
- `seedPiAnthropicAuthFromClaudeCode`
- `seedPiApiKeyAuth`
- `createPiOpenAICodexAuthFromCodexToken`

## CLI Engines

The organization runtime accepts `codex`, `grok`, and `agy` engine intents. It
does not accept arbitrary commands or environment maps in config.

At startup and before each wake, Daimon resolves the executable from a safe
`PATH`, pins its file identity, probes `--version`, and verifies the selected
auth boundary.

Codex uses a private `.codex/auth.json` under each agent runtime home. Optional
Codex config fields are `model`, `reasoningEffort`, and the fixed no-network
workspace sandbox policy.

The production Grok path uses an external Daimon engine broker with one durable
subscription credential authority. Agent workers receive scoped capabilities;
the broker owns refresh and stale-credential recovery. The runtime checks broker
readiness before admitting Grok agents and verifies their sandbox policy before
turns. The older credential-lease helper is not the production host path.

AGY uses OS-native secure storage through one private D-Bus and Secret Service
realm. Enroll it once with:

```bash
daimon-runtime auth agy login --config /runtime/daimon-runtime.json
```

Daimon does not accept portable AGY token files, API keys, ADC credentials, or
ambient D-Bus sessions.

## Live Checks

`npm test`, `npm run typecheck`, and `npm run build` do not call model
providers.

Live scripts and examples spend real tokens and require local subscription
auth:

- `npm run live:grok-broker`
- `npm run e2e:pi-agent`
- `npm run e2e:pi-memory-org`
- `npm run e2e:jungian-play-org`
- `npm run e2e:jungian-triad-org`
