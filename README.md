# Daimon

Daimon is the Noopolis-native per-agent runtime harness.

It defines a small per-agent contract and currently implements that contract on
top of Pi. A Daimon runs one harnessed agent inside a caller-prepared workspace.

Spawnfile should own orgs, nested teams, schedules, Moltnet wiring, workspace
resource compilation, and the app that starts many harnessed agents. This package
should not know what an org is.

## Install

```bash
npm install @noopolis/daimon
```

For Pi agents with memory enabled, install Mneme too:

```bash
npm install @noopolis/daimon @noopolis/mneme
```

During local incubation, use the sibling Mneme checkout:

```json
{
  "devDependencies": {
    "@noopolis/mneme": "file:../mneme"
  }
}
```

Pi-specific exports live under the Pi subpath:

```ts
import { PiHarnessAdapter } from "@noopolis/daimon/pi";
```

## Tests

The package has a non-live test suite for auth seeding and Pi model config
generation:

```bash
npm test
npm run typecheck
npm run build
```

These tests do not call a model provider.

## Model And Auth Helpers

The Pi adapter supports the same model intent shape Spawnfile lowers for Pi:

- OpenAI Codex subscription auth maps to Pi's `openai-codex` OAuth auth store.
- Claude Code subscription auth maps to Pi's Anthropic auth store.
- API-key credentials can be written directly into Pi auth storage.
- Local and custom OpenAI-compatible endpoints render Pi `models.json`.

For Ollama-style local models, use a local endpoint with `auth.method: none`.
Pi still requires an API-key field for custom providers, so the helper writes the
upstream-documented dummy `ollama` value.

## Pi E2E

The Pi E2E uses the local Codex CLI subscription auth file to seed an ignored Pi
`auth.json` under `.runtime/`.

```bash
npm install
npm run e2e:pi-agent
npm run e2e:pi-memory-org
npm run e2e:mixed-engine-org
npm run e2e:jungian-play-org
npm run e2e:jungian-triad-org
```

The example starts two harnessed Pi agents from plain caller code. The example
creates the workspaces and shared resource itself to demonstrate the intended
boundary: the caller prepares files, the harness runs agent turns.

The memory-org example starts three harnessed Pi agents, gives each agent a
private marker memory, clears Pi session history, then runs a room-style recall
conversation. It restarts one agent again before the final check, so the final
answer must come from Daimon's persisted memory rather than Pi's live chat
session.

The mixed-engine example starts a small org backed by real local CLIs:
Navigator uses Codex, Cartographer uses Grok, and Sentinel uses Agy. Each engine
invents its own private signal, then the room conversation verifies that later
turns recall those LLM-generated signals through Daimon memory.

The Jungian play example starts two selves as characters in a play. Each self
has archetype voices such as Persona, Shadow, Anima/Animus, Wise One, Great
Mother, Hero, and Trickster. The inner voices run first, the representative self
then speaks externally, and the run writes play traces plus memory/latency
telemetry under `.runtime/jungian-play-org/`.

The Jungian triad example uses three complete Jungian selves in one
conversation: Maya speaks through Codex CLI, Leo speaks through Grok, and Priya
speaks through a Pi agent seeded from local Codex subscription auth. All three
selves carry the same full archetype set, rotated through the run so every
archetype gets consulted.

## Design Notes

- `MEMORY-SYSTEM.md` describes the implemented scoped memory runtime.
- `ENGINE-SYSTEM.md` describes the next engine abstraction plan: Pi, Ollama,
  API providers, and CLI-backed engines such as `agy`, `grok`, and `gemini`.
- Mneme is a sibling package, `@noopolis/mneme`, published separately and used
  by Daimon in-process for Pi agents. Other runtimes can use Mneme through its
  MCP server. The agent-facing tools stay named `memory_search`,
  `memory_register`, and `memory.*` at the protocol boundary because those names
  are clearer to agents.

## Runtime Artifact Image

Daimon can build a local copy-only runtime artifact image for Spawnfile:

```bash
npm run image:runtime:local
```

This creates:

```text
noopolis/spawnfile-runtime-daimon:0.1.1-local
```

The image is not a full organization image and is not intended to be run
directly. It contains only:

```text
/opt/spawnfile/runtime-installs/daimon
```

Spawnfile can copy that path into generated organization images:

```bash
SPAWNFILE_DAIMON_RUNTIME_IMAGE=noopolis/spawnfile-runtime-daimon:0.1.1-local \
  spawnfile build ./agentic-org
```

This keeps mixed-runtime organizations composable: a generated image can copy
Daimon, OpenClaw, PicoClaw, or any future runtime artifact independently instead
of depending on one prebuilt image for every runtime combination.
