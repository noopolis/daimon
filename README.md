# Daimon

Daimon is the Noopolis-native per-agent runtime harness.

It defines a small per-agent contract and currently implements that contract on
top of Pi. A Daimon runs one harnessed agent inside a caller-prepared workspace.

Spawnfile compiles and deploys orgs, nested teams, member-owned schedules,
Moltnet wiring, and workspace resources. Daimon executes one agent runtime: it
accepts a wake selected by that runtime's organization policy and runs one
turn. Its strict organization-runtime v2 host owns each configured agent's
durable `cron`, `every`, or `disabled` schedule without learning the Spawnfile
org graph. Simfile and world services do not trigger cognition.

Spawnfile may also compile per-agent production MCP and Moltnet capabilities into this config. Daimon lists each MCP server at startup, mounts only its declared tool allowlist into Codex/Grok cognition turns, and bounds calls to 10 seconds and 64 KiB. Moltnet exposes one scoped natural-language send tool whose deterministic delivery id derives from the active wake, agent, target, and text. Accepted tool receipts are fsynced under the agent runtime home and replayed after restart; transport policy remains Spawnfile/Moltnet-owned.

For a world-capable `kind: every` wake, the harness starts without a decision
token and privately calls `world_claim` before exposing any other world tool.
The claim binds authority to the schedule wake's run/request/wake identity; the
opaque token stays inside the harness. Subsequent observe/affordance/action
calls carry it without placing it in the model prompt or tool schema. Optional
world recommendations are ordinary observation fields discovered after the
independent wake and claim—they are never Daimon wake inputs.

## Install

```bash
npm install @noopolis/daimon
```

The latest published version may differ; this README describes the source tree (0.2.0).

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

## Organization-runtime contract

`@noopolis/daimon/runtime` exports a standard JSON Schema for structural
validation plus the strict, side-effect-free semantic
`validateOrganizationRuntimeConfig` / `parseOrganizationRuntimeConfig` API and
a narrow multi-agent Daimon host:

```ts
import { parseOrganizationRuntimeConfig } from "@noopolis/daimon/runtime";

const config = parseOrganizationRuntimeConfig({
  version: "noopolis.daimon.organization-runtime.v1",
  host: {
    bindHost: "127.0.0.1",
    port: 4318,
    controlTokenEnv: "DAIMON_CONTROL_TOKEN"
  },
  agents: [{
    id: "writer",
    name: "Writer",
    instructions: "Write the report.",
    workspacePath: "/runtime/workspaces/writer",
    runtimeHomePath: "/runtime/homes/writer",
    engine: { kind: "codex" }
  }]
});
```

The package also includes the canonical runtime contract at
`dist/runtime/contract-manifest.json` and its exact-byte SHA-256 sidecar at
`dist/runtime/contract-manifest.sha256`. Every build regenerates both from the
same data-only constants exported as `RUNTIME_CONTRACT_MANIFEST`; the digest is
encoded as `sha256:<lowercase hex>`.

It intentionally contains no teams, roles, parent/member links, wake policies,
deployment settings, Moltnet data, commands, argument arrays, environment maps,
or credentials. V2 agents carry one normalized native schedule; durable state
and acceptance provide restart-safe occurrence execution. `controlTokenEnv` is only the safe name of a
variable; the token value is never serialized. The only organization-host
engine intents are `codex`, `grok`, and `agy`; Pi remains available through the
separate one-agent `@noopolis/daimon/pi` API.

`createOrganizationRuntimeHost(config)` creates an organization runtime host.
Call `await host.start()` to construct one isolated Daimon harness per agent,
after reading the non-blank control token named by `controlTokenEnv`.
It routes only authenticated, targeted wakes; each agent's wakes are serial,
while separate agents can run concurrently. It has no organization or
coordination API. Run the HTTP control process with:

```bash
daimon-runtime run --config /runtime/daimon-runtime.json
```

The process exposes authenticated `POST /v1/wake`, `GET /v1/health`, and
`GET /v1/activity` endpoints. Send the token only as `Authorization: Bearer
<token>`; it never appears in configuration or activity output.

For durable control-plane delivery, provide a caller-created, current-user
owned `0700` directory in `DAIMON_RUNTIME_ACCEPTANCE_STORE`. This enables the
additive authenticated v2 API: `POST /v2/wakes` persistently accepts one
bounded, addressed wake under its `(agent_id, delivery_id, request digest)`
identity before the turn starts, and `GET /v2/wake-receipts/<acceptance_id>`
returns only its strict redacted lifecycle status. The store is a private
runtime authority, not a credential directory; it must be mounted only into
the Daimon host. Equal retries return the original acceptance, while a changed
payload for that delivery id is rejected. There is no v2 list/activity endpoint
and no model output in acceptance or receipt responses. If the variable is not
provided, the v1 endpoints remain available and v2 is not exposed.

Each accepted delivery also has a private, bounded execution claim with an
owner and generation fence. A second host sharing the authority may observe a
receipt but cannot dispatch while the live claimant owns it; only the matching,
unexpired fence can record its terminal state. Claim revalidation and receipt
replacement are covered by a separate exclusive, fsynced per-receipt transition
lock; a recovered generation fences an older paused writer before replacement.
After a host crash, a bounded stale claim can be recovered and replayed. This is durable at-least-once turn
delivery, not exactly-once cognition: if an engine has an external effect and
the host crashes before its terminal receipt is persisted, recovery can run the
turn again. Callers requiring exactly-once external effects must fence or
deduplicate those effects at their own destination.

The durable v2 store is a Linux-container contract. Its non-expiring commit
lock records the owner PID, Linux `/proc` process-start identity, boot id, and
PID-namespace device/inode identity; recovery is allowed only after that exact
owner is proven dead in the same namespace, so PID reuse cannot unlock a live
writer. A different or unobservable PID namespace raises the typed,
path-free `WakeTransitionLockBlockedError` with code
`offline_reconciliation_required`; it is never automatically cleared. For a
replacement container, deployment authority must first prove the prior
container absent or quiescent, then perform an explicit offline stale-lock
reconciliation. On a platform where this identity cannot be proven, v2 fails
closed rather than using a clock-based lock; v1 remains available without the
v2 store.

### Offline transition reconciliation

`reconcileOfflineWakeTransition` is a deployment-admin library operation, not
an HTTP endpoint and never a normal host action. It accepts only the versioned
`noopolis.daimon.offline-transition-reconciliation.v1` request, including the
exact store and lock device/inode identities, owner/generation/PID-namespace
identity, and an opaque absent-or-quiescent deployment attestation. The caller
must mount the store exclusively offline and supply the deployment authority's
attestation verifier. Daimon gives that verifier a canonical immutable
authorization context (deployment identity, nonce, request digest, every
store/delivery/lock identity, and every stale host registration's exact file
device/inode, owner, process, boot, and PID-namespace identity); its returned
proof receipt must echo that exact digest and nonce and certify
`exclusive_store: true`. A same-namespace registration is cleared only when
its owner is proven dead. A cross-namespace registration is cleared only when
the proof authorizes that exact canonical registration digest after deployment
has proven the old container absent or quiescent. Unknown, live, unlisted, or
changed registrations block. Daimon validates the physical store, delivery
record, and lock again immediately before its fsynced removal. The proof
itself is never persisted or returned; the durable redacted receipt records
only cleared registration digests.

The operation writes a durable redacted receipt and returns it on an identical
replay. An identity mismatch, invalid proof, concurrent administrative lease,
or changed replay returns the stable blocked result
`{ state: "blocked", code: "offline_reconciliation_required" }`. It performs
no runtime auto-clear and has no CLI or public-server admin route in C0. The
admin lease itself carries PID/start/boot/PID-namespace identity: a retry may
recover it only after proving the prior owner dead in the same namespace. Lease
unlink and directory fsync failures prevent a successful result; the durable
prepared receipt lets an authorized offline retry finish after a crash.

Every running wake-acceptance store also holds its own fsynced host-lifetime
registration with the same process identity. A host writes that registration
before becoming usable and rechecks the offline lease; the offline operation
takes its lease first, then rejects live or unprovable host registrations.
This permits normal concurrent hosts, but prevents either startup/admin race
from overlapping an administrative reconciliation.

The runtime may bind `0.0.0.0` when its caller places it on a dedicated private
container network. Daimon neither publishes ports nor selects networks; the
deployer must keep the control endpoint un-published and allow only its
authorized control-plane client to reach it.

The JSON Schema is deliberately standard and structural. The pure parser and
validator are normative for semantic checks that standard JSON Schema cannot
express, including unique ids, own-property records, and pairwise
non-overlapping canonical POSIX workspace/runtime-home paths; call the parser
before runtime side effects. The parser canonicalizes absolute path spellings
before retaining or comparing them. Before creating agents, the host verifies
that caller-created roots are real, current-user-owned directories without
symlink components; runtime homes must be exactly `0700`, and workspaces must
not be group/other writable. Daimon never creates or removes these roots.

For a production CLI engine, Daimon resolves the engine from `PATH` once,
pins its canonical executable identity, probes only `--version`, and rechecks
that identity before every child process. Codex uses a caller-provisioned
private `.codex/auth.json` refresh credential beneath each agent's
`runtimeHomePath`. Grok instead uses one host-wide durable subscription realm:
a read-only operator bootstrap seeds the authority, and Daimon serializes
turns while staging and reconciling the rotating credential into each private
agent home. Sessions and non-auth state remain isolated per agent. Engine
children receive only the matching engine home, runtime/XDG paths,
locale/timezone, and a PATH sufficient for the already pinned executable.
Before every Grok process, Daimon rewrites its exact custom sandbox profile and
requires a fresh kernel-enforcement receipt covering the durable realm,
read-only bootstrap, and every peer workspace/runtime home. A fail-open
Landlock/Seatbelt warning, missing deny path, or profile mutation fails the
wake before cognition.
They never inherit arbitrary host variables. Missing, replaced, malformed,
stale, or unsafe engine authority prevents startup or fails the affected wake
without publishing credential contents or file paths.

AGY subscription authentication is different: it uses OS-native secure
storage. Daimon supervises one private D-Bus plus Secret Service realm for all
AGY agents on the host, holds an exclusive lease on its durable encrypted
keyring volume, and unlocks it from an independent caller-owned `0600`
read-only mount through bounded stdin. Only AGY children receive that realm's
exact bus address. Normal startup proves enrollment with `agy models` before
any agent starts.

Enroll an empty realm once from an interactive terminal:

```bash
daimon-runtime auth agy login --config /runtime/daimon-runtime.json
```

The command starts the same realm and launches the pinned `agy` as a Daimon
child with no AGY arguments, allowing its remote URL-and-code sign-in flow.
After the operator exits AGY, Daimon runs the noninteractive enrollment proof
and preserves the durable keyring state. It never accepts a portable AGY token
file, API key, ADC credential, token export, or ambient D-Bus session.

By default, the in-process Mneme runtime uses the same path as each agent's
`runtimeHomePath`. If you need agents to keep separate Pi/runtime directories but
share one memory bank, pass an explicit `memory.runtimeHomePath` in
`PiHarnessOptions`.

```ts
const adapter = new PiHarnessAdapter({
  authPath: "/tmp/daimon-auth.json",
  memory: {
    runtimeHomePath: "/shared/memory/bank"
  }
});
```

Pi agents receive Mneme tools in awake mode for normal work. Dream wakes use a
fresh one-off Pi session under `sessions/dream/<wake-id>-<random>` and inject
the Mneme dream guidance instead. Daimon does not automatically record every
turn as memory; agents write memories only by calling Mneme tools such as
`memory_register`, `memory_summarize`, and `memory_forget`.

## Tests

The package has a non-live test suite covering auth seeding, Pi model config
generation, the harness contract, memory tool wiring, wake and turn traces, and
the org observer:

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

These are live runs: they spend real tokens and require local engine auth
(`~/.codex/auth.json` for Pi/Codex; mixed-engine and triad additionally need
authenticated `grok` and `agy` CLIs on PATH). They are not part of `npm test`.

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
- `ENGINE-SYSTEM.md` describes the engine abstraction plan: Pi, local/API
  model providers, and CLI-backed engines such as `codex`, `claude`, `grok`,
  and `agy`.
- Mneme is a sibling package, `@noopolis/mneme`, published separately and used
  by Daimon in-process for Pi agents. Other runtimes can use Mneme through its
  MCP server. The agent-facing tools stay named `memory_search`,
  `memory_register`, and `memory.*` at the protocol boundary because those names
  are clearer to agents.
