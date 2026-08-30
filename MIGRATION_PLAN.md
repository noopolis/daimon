# Daimon organization-runtime migration plan

## Phase 1A: public contract — complete

- Add only the versioned, organization-neutral
  `noopolis.daimon.organization-runtime.v1` parser, schema, public types, and
  `@noopolis/daimon/runtime` export.
- The v1 config is a strict flat projection: host control binding plus an
  unordered, non-empty collection of isolated agent records. It cannot carry
  organization graph, coordination, scheduling, deployment, or Moltnet data.
  The standard JSON Schema covers structure; the pure public parser is
  normative for semantic checks such as duplicate agent ids.
- Define the host, wake, activity, health, and shutdown interfaces now. Phase
  1A is validation-only; Phase 1B provides the host, process, server, engine
  dispatch, and CLI implementation while retaining the same public contract.

## Phase 1B: isolated runtime host — complete

- Add the organization-neutral `noopolis.daimon.organization-runtime.v1`
  host implementation behind the already published public API.
- A host reads one config, validates it, creates one isolated existing Daimon
  harness per agent record, routes authenticated wake, health, and activity
  operations by agent id, serializes each agent's wakes independently, and
  quiesces all children on shutdown.
- The schema is a strict flat projection. It enumerates only: schema version,
  agent id, runtime-home path, workspace path, engine intent, control endpoint,
  and surface bindings. It rejects every unknown field and specifically rejects
  team, parent, member, role, edge, schedule, wake-selection, deployment, and
  Moltnet-topology semantics. The host does no wake generation or coordination;
  it only provides agent-id routing, per-agent queue/lifecycle/health/activity.
- Engine process creation remains in Daimon. The public runtime does not accept
  arbitrary commands, raw process handles, or caller-supplied environment maps.
  Fake engines are test-only injection points and make this phase deterministic.

The exact v1 JSON shape is:

```ts
type OrganizationRuntimeEngineIntent =
  | { kind: "codex" | "grok" | "agy" };
type OrganizationRuntimeAgentConfig = Readonly<{
  id: string;
  name: string;
  instructions: string;
  runtimeHomePath: string;
  workspacePath: string;
  engine: OrganizationRuntimeEngineIntent;
}>;
type OrganizationRuntimeConfig = Readonly<{
  version: "noopolis.daimon.organization-runtime.v1";
  host: Readonly<{
    bindHost: string;
    port: number;
    controlTokenEnv: string;
  }>;
  agents: readonly OrganizationRuntimeAgentConfig[];
}>;
```

All objects are strict; there are no optional properties or arbitrary metadata
bags in v1. `id` is unique, root agent paths are absolute, caller-created real
directories, and physically isolated by held directory identities. Runtime
homes must be owned `0700`; workspaces must be owned and not group/other
writable. The
control token is identified only by a safe environment-variable name; secret
material never appears in the config. Unknown schema versions are rejected
before a host starts or a child is constructed. The public signatures are:

```ts
parseOrganizationRuntimeConfig(value: unknown): OrganizationRuntimeConfig;

interface OrganizationRuntimeHost {
  start(): Promise<void>;
  wake(request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult>;
  health(agentId?: string): Promise<OrganizationRuntimeHealth>;
  activity(request: OrganizationRuntimeActivityRequest): Promise<OrganizationRuntimeActivityPage>;
  stop(): Promise<OrganizationRuntimeShutdownCompletion>;
}
```

`OrganizationRuntimeHost` exposes `wake`, `health`, `activity`, and idempotent
`stop`; each request is keyed by an agent id and the host exposes no
coordination/wake-generation API. Fake engine construction is internal
test-only injection, never config data or a public production escape hatch.
The CLI is exactly `daimon-runtime run --config <path>`.

## Files

- Add `src/runtime/` with its own `AGENTS.md` and `CLAUDE.md` symlink. It now
  contains the strict contract, isolated host, control server, CLI, and focused
  tests, with each source file kept below 400 lines.
- Additive pre-1.0 bump to `0.2.0`; retain the existing `.`, `./pi`, and
  `./observability` entrypoints unchanged, then add `./runtime`.
- Update docs only as required to expose this exact contract and retain safe
  compatible per-agent APIs.

## Tests and verification

- Contract coverage: invalid config; forbidden organization fields; safe auth
  environment names; agent-home/workspace path syntax and physical roots;
  duplicate ids; closed Codex/Grok/AGY engine intents; public method types;
  retained imports; package closure.
- Run typecheck, focused tests, full unit suite, build, `npm pack`, install the
  packed tarball into a clean temporary consumer, import the retained and new
  entrypoints there, and inspect the final diff for forbidden consumer
  terminology and raw credential/process APIs.

## Migration and terminal conditions

- This completed phase introduces the Daimon host and public contract only; it does not
  change any downstream consumer. A deferred downstream compiler/consumer E2E
  phase will emit one compiled v1 config, start one container entrypoint/host
  process, verify N isolated one-agent runtimes with targeted and concurrent
  fake wakes, and prove that the consumer never instantiates Daimon handles or
  engines. No Docker work is permitted in this Daimon phase.
- Stop and return for review when implementation, test evidence, package
  closure, and an explicit public-contract summary are complete. Do not touch
  credentials, Docker, live repositories, or external services.
