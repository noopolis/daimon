# Daimon organization-runtime contract

This folder owns the versioned, organization-neutral contract and host for
isolated Daimon agents and their runtime-native durable schedules. It is not a
compiler, organization graph, Moltnet adapter, or deployment surface.

Keep config parsing pure and strict. The config must never contain credentials,
commands, argument arrays, arbitrary environment maps, process handles, or
caller-selected implementation hooks. The host may route only explicit
agent-id wakes and lifecycle operations; it cannot select, generate, or
coordinate wakes.

Every source file stays below 400 lines. Keep tests beside the contract they
cover.

`grokBrokerProxyRequest.ts` preserves the worker CLI's `x-grok-client-version`
and supplies its `grok-shell` client identity when rebuilding provider headers.
Dropping the version makes the subscription provider reject an otherwise valid
login with HTTP 426; never replace it with a fabricated version or pass
arbitrary worker headers through. The version must equal the pinned
`GROK_ENGINE_BROKER.grokCliVersion` (1.0.34) exactly.

The proxy is also the spend gate for the lean Grok worker. Before a bearer is
attached it refuses any body whose tool names are not exactly
`GROK_WORKER_VISIBLE_TOOLS` (Grok 1.0.34 turns an unmappable `--tools` entry
into its full 19-tool set, and its `session_title` request carries one forced
tool), and any body whose `model`/`reasoning_effort` differ from the declared
`grokBrokerModelPolicy.ts` policy (closed lists; default `grok-4.6`/`low`). The
model override header follows that declaration.

The proxy is the per-turn limit gate too. Every broker turn registers a
`grokBrokerTurnMeter.ts` meter with its registration's model policy, and the
proxy forwards nothing for a turn without one. After a body is proven a lean
worker request and before any upstream call, the meter refuses request
`maxRequests + 1`, any request past `timeoutMs`, and any request once the
upstream-reported running total (prompt tokens *including* cached, plus
completion) has reached `maxTokens` — HTTP 429, and the tripped limit aborts
the worker through the ordinary cancel/kill path. The token ceiling is checked
between requests, so a turn overshoots it by at most the last admitted
request; if an upstream body carries no `usage`, only `maxRequests` and
`timeoutMs` bound that turn mid-flight. A broker timer also trips `timeout`
for a worker that is mid-request. Limits come from `service.json` v2
(`engineBrokerServiceConfig.ts`; v1 gets `GROK_ENGINE_BROKER.turnLimits.v1Defaults`)
and a wake may only lower them: a raise is refused as `invalid_request`, never
clamped.

The broker stays the single sealed usage writer. `grokEngineBrokerTurn.ts`
seals every terminal turn — completed, failed, limit, cancelled — through
`finishBrokerTurnWithUsage` (`grokEngineBrokerMetering.ts`): the turn registry
record v2 stores the control-protocol v2 terminal response *with* its
numeric-only accounting (`usage`, `outcome`, declared `model`, `requests`,
closed `limitReason`), and only then are ledger rows appended. A replay
returns the sealed accounting and never meters again; v1 records still replay
(upgraded with `usage: null`). Completed usage is the terminal `result.usage`;
a failed turn's partial usage is its per-request stream frames
(`../pi/grokStreamUsage.ts`) when output arrived, else the upstream usage the
proxy saw. Usage rows carry `turn` (the idempotency key readers dedupe on —
`wakeFuse.ts` does), `limit_reason` and `model`; per-request rows go to
`requests.jsonl` beside the registration's `usageLedgerPath` with proxy-measured
`started_at`/`ended_at`. A provider-reported model key must map to the declared
model (`grok-4.6-build` → `grok-4.6`), otherwise the turn fails as rejected and
is still metered. Control protocol v2 is refused-v1 on the wire because both
ends ship in this package.

`grokBrokerProjection.ts` is the public, I/O-free projection of one brokered
Grok agent's slot (`noopolis.daimon.grok-broker-projection.v1`): Daimon's own
deny collectors plus the caller's evaluator paths, profile/config/prompt
digests, pinned executable, model, limits and ledger. A Grok agent must declare
`model` and `reasoningEffort` for it; nothing is defaulted, and a supplied
profile digest that differs is refused. `grokSlotPreflightReceipt.ts` is the
zod schema a root slot supervisor's receipt must satisfy
(`noopolis.daimon.grok-slot-preflight.v1`, fixtures under
`fixtures/grok-slot-preflight/`); `verifyGrokSlotPreflightReceipt` binds it to
the projection digest and requires a denied canary for exactly every deny path.

`grokBrokerWorkerConfig.ts` is the only source of worker `config.toml` bytes;
the manifest pins the sha256 of every model/effort combination and the broker
refuses a turn whose worker config does not hash to the declared one. Three
1.0.34 facts shape it, each verified against a loopback stub model:
`[auth_provider.*]` helpers never run for a custom model, so the turn's proxy
capability reaches the model through `env_key = "DAIMON_PROVIDER_CAPABILITY"`
set by the native launcher (as exposed as `DAIMON_MCP_CAPABILITY`); the
per-turn `session_title` request cannot be disabled by any key, so
`[models] session_summary` points it at a hidden model on closed loopback port
9; and effort is only sent when the model declares it, so the declared effort is
the model's single `reasoning_efforts` entry. HTTP MCP needs CA certificates in
the image even for a loopback `http://` URL ("Failed to build HTTP client").

Worker `GROK_HOME` layout the deployment must provision (attested before every
turn by `grokWorkerHomeAttestation.ts`, recorded in `GROK_ENGINE_BROKER.worker.home`):
`$GROK_HOME` and `$GROK_HOME/sessions` `root:<worker> 1771`; `config.toml`,
`sandbox.toml`, `trusted_folders.toml` (empty), `managed_config.toml` (empty)
and `requirements.toml` (empty) `root:root 0444`; and
`sessions/sandbox-events.jsonl` `<worker>:<broker> 0640`. Grok 1.0.34 writes its
sandbox events there (the root `sandbox-events.jsonl` stays empty) and runs
every profile inside bubblewrap, where a non-empty `deny` list is enforced;
`grokWorkerSandboxProfile.ts` renders those profile bytes. A worker-uid process
can neither write, rename, nor unlink any of the root-owned files.

`agySubscriptionRealm.ts` owns the one host-level private D-Bus/Secret Service
realm, durable keyring lease, bounded unlock stdin, and cleanup.
`agySubscriptionBootstrap.ts` owns only the interactive first-enrollment AGY
child; normal engine dispatch remains in `engineDispatcher.ts`.
`portableCredentialMaterial.ts` imports bounded Codex ingress into its
runtime-writable home without clobbering a newer CLI-refreshed credential.
`grokSubscriptionRealm.ts` owns the single durable rotating Grok credential,
the lifetime lease, crash journal, stale fence, and serialized per-turn
stage/promote cycle while each agent retains private non-auth home state.
`../pi/grokSandbox.ts` owns the direct (non-broker) Grok process boundary: it
replaces the provider's fail-open built-in profile with an exact custom profile
denying the realm, bootstrap, and peer roots, and requires a kernel-enforcement
event (read from `$GROK_HOME/sessions/sandbox-events.jsonl`) before every Grok
turn. The direct path registers its per-wake MCP endpoint in the agent's
Daimon-owned `GROK_HOME` config (`../pi/grokHomeMcpRegistration.ts`), because
1.0.34 skips project-scoped MCP servers in untrusted workspaces.
Strict Codex uses its native permission profile only for model-run local
commands: the profile denies current `.codex/auth.json`, current
`.daimon-inbound`, `/proc`, `/run`, shared protected stores, and peer roots
while preserving Codex's own helper files, the workspace's prepared resource
symlink reads, and the current agent's `tool-output/` spill reads. Codex
provider traffic and trusted MCP/provider processes stay outside that native
command sandbox and must keep their own auth.
`organizationRuntimeReadiness.ts` composes portable credential preparation,
AGY realm readiness, and physical path authority before any agent starts. AGY
fails closed on enrolment: `verifyAgySubscriptionEnrollment` runs there at host
start and again through `prepareEngineReadiness` before and after every wake,
so an unenrolled realm or an unopenable keyring refuses the agent with "run the
Daimon AGY bootstrap command" rather than producing credential-less turns.

All three engines now get the same per-wake MCP tool surface. AGY reaches it
through `../pi/cliMcpRegistration.ts` (`agy mcp add --type http` into the
agent's own `$HOME/.gemini/config/mcp_config.json`, removed again after the
turn) rather than a command-line flag, because AGY has no equivalent of Codex's
`-c mcp_servers.daimon.url=`. `AGY_MAX_TOOL_TURNS` in `../pi/cliSession.ts` is
the only place its per-wake tool-call bound is decided. `maxToolTurns` only
mediates daimon-MCP tool calls; Codex's own shell (`exec_command`) is never
routed through it, so Codex gets its own bounds instead —
`DEFAULT_CODEX_WAKE_TIMEOUT_MS` (wall clock) and
`DEFAULT_CODEX_WAKE_TOKEN_CEILING`, both in `../pi/engineWakeLimits.ts`, overridable
via the engine-neutral `DAIMON_ENGINE_WAKE_TIMEOUT_MS`/`DAIMON_ENGINE_WAKE_TOKEN_CEILING`
(the `DAIMON_CODEX_*` names are aliases; conflicting values are refused), which
the dispatcher also passes to the Grok broker as lowering limits. The token
ceiling can only be checked when Codex reports it: its `--json` stream carries
usage exactly once, on the turn's own `turn.completed`, so crossing it kills
the child immediately and fails the wake instead of letting an over-budget
turn resolve as a normal success; the wall-clock bound is what actually
interrupts a runaway turn in progress.

`turnUsageLedger.ts` is engine-neutral: the Grok broker appends through
`finishBrokerTurnWithUsage`, and AGY and Codex — neither of which has a
broker — both append through the session's `onTurnUsage` sink wired in
`engineDispatcher.ts`, fed by their own decoded terminal-frame usage
(`agyHeadlessResult.ts`, `codexHeadlessResult.ts`). `wakeFuse.ts`'s token
ceiling depends on every engine actually reaching this ledger — a
missing/unreadable ledger is a startup failure there, on purpose, rather than
a silent zero that would let the ceiling sum nothing.

A wake that *fails* spends the same money as one that publishes, so usage is
recorded whenever the engine actually reported it, not only when the wake
succeeded. For Codex that means `../pi/cliChildOutput.ts` hands each parsed
`turn.completed` frame's decoded usage to the session as it streams, and
`../pi/cliSession.ts` meters it on the breach, timeout, non-zero-exit, and
rejected-turn paths as well as the published one. The row's `outcome` field
(`completed`/`failed`, plus a closed-vocabulary `reason`) is what tells them
apart; it is an additive field inside the unchanged
`noopolis.daimon.turn-usage.v1` record, because Spawnfile's reader drops every
line whose `v` it does not recognise while ignoring fields it does not know.
Absence of reported usage is still absence: no `turn.completed`, an
undecodable usage block, or two completion frames all write nothing, because a
zero-filled row is byte-identical to a real zero. Before this, a breached
ceiling recorded nothing at all and its spend survived only inside the error
message.

`turnRequestLedger.ts` is a *second*, separate stream beside that ledger, not a
wider row in it. The per-wake row is one sum and cannot distinguish a fixed
prefix replayed once per model request from a context that grows per request —
the two call for opposite optimisations, and 55 production wakes (14,890,263
input against 159,726 output, context flat at 23–32k per request regardless of
request count) look like the first without proving it. `../pi/cliChildOutput.ts`
carries the thread id off Codex's own `thread.started` frame, and
`../pi/codexRolloutUsage.ts` reads that thread's rollout under
`$CODEX_HOME/sessions/**` for the per-request `token_usage_record` frames the
`--json` stream never emits. Each Codex row carries its own `started_at`/`ended_at`
from the rollout frame timestamps (end = the usage frame; start = the first
non-usage frame after the previous request's usage frame, else that request's
end), absent rather than substituted when a frame has no valid timestamp. Rows go to `requests.jsonl` beside `usage.jsonl`
(`DAIMON_TURN_REQUESTS_LEDGER_PATH` relocates it) under the same invariants: a
wake whose rollout is absent, unreadable, or undecodable writes *nothing*,
because a fabricated zero is byte-identical to a measured one; and every failure
is swallowed, because instrumentation must never fail a wake. The existing
ledger's version, path, and field list are untouched, so Spawnfile's
`v`-pinned reader is unaffected.

`testRuntimeSubprocess.ts` is an unexported, explicit-test-only JSONL process
surface for exercising the real control, schedule, and acceptance paths with a
controlled clock and deterministic scripted cognition. Its ephemeral loopback
HTTP listener exposes only the authenticated v2 wake-acceptance route needed by
transport integration tests. Optional bounded cognition actions invoke the real
Moltnet CLI with an explicit compiled client config, and may address only
declared networks and room/DM surfaces. Optional stdio MCP calls consume only a
Spawnfile-compiled, digest-attested test artifact and enforce its agent/server/tool
allowlist. These modules build only into `dist-test-runtime`, never production
`dist`, and remain inert unless the fixed test-mode environment gate is present.
The optional container fixture for that explicit test runtime lives at
`src/runtime/fixtures/Dockerfile.test-runtime`.

Every agent-facing tool in `productionAgentTools.ts` must return its payload in
`details`, not only in `content`. The MCP mount lowers `details` to
`structuredContent` (`src/mcp/toolServer.ts`) and the engines render that in
preference to `content`, so a tool that fills only `content` reaches the model
empty. `moltnet_read` shipped that way and returned nothing but a message count
for its whole life; `memoryTools.ts` and `worldTools.ts` are the pattern to copy.

The declared `mcp_*` tools had the same defect one layer wider: every one of
them returned `details: { server, tool, is_error }`, so an agent calling *any*
declared MCP tool read routing metadata where the tool's own answer should have
been — and, on a failure, read `is_error: true` with no reason for it.
`mcpToolResult.ts` owns that lowering now, under three rules. **Both channels
always carry the payload**, each mirroring whichever one the server left empty,
because being wrong again about which channel an engine renders must cost
nothing; an upstream `structuredContent` is forwarded verbatim so a declared
`outputSchema` still describes what the model sees. **`isError` is raised, not
reported** — Pi's `AgentToolResult` has no error channel, so a failing upstream
tool throws `McpToolCallError` carrying the server's own words, which
`toolServer.ts` lowers to `isError: true` plus that sentence. **The bound
truncates rather than refusing**: an oversized result degrades to a head of
itself plus an explicit marker naming both sizes, where it used to be thrown
away whole. The wake-scoped receipt stores the rendered result so a repeated
identical call replays the answer instead of a digest of it, and a repeated
failing call fails again for the same stated cause.

`toolResultSpill.ts` adds the bound that `mcpToolResult.ts` never had: a
*context* bound, as opposed to a receipt bound. Every tool result stays in the
transcript for every subsequent model request of the wake, and production agents
make 3–37 tool calls per wake against a context that is flat at 23–32k tokens per
request, so one oversized result is not paid once — it is re-billed on every
request that follows it. The 61,440-byte bound in `mcpToolResult.ts` is the
receipt's bound and degrades to a *head only*, unrecoverable. Above
`DAIMON_TOOL_RESULT_MAX_BYTES` (default 16 KiB, ≈4k tokens — a sixth of one
request, where oh-my-pi's 50 KiB default would be half of it) the complete
payload is written under `<runtimeHome>/tool-output/` and the model receives head
**and** tail plus a notice naming the absolute path and the shell command that
reads it. Naming the path is the point: a bare `[truncated]` makes the agent
re-run the same expensive call. Three rules, all borrowed from
`references/oh-my-pi`'s `tools/output-meta.ts`: a failed disk write still
truncates and only withholds the recovery link, never re-exposing the payload; a
result at or under the bound passes through **byte-identical**, so the
`mcp_*` passthrough contract above is untouched for the overwhelming majority of
results; and `DAIMON_TOOL_RESULT_NO_TRUNCATE` exempts named tools outright, for a
deployment where one declared tool's whole answer is load bearing — Daimon cannot
know which, so that judgement stays with whoever declared the tool. Daimon's own
`moltnet_read`/`moltnet_send` are outside this wrapper by construction: they are
already byte-bounded at `MAX_RESULT` and `moltnet_read` pages with a cursor, so
the agent bounds them by asking for less rather than by being handed less.

Daimon does not re-declare an upstream `outputSchema` on its own mount: a
declared output schema obliges every result to carry conforming
`structuredContent`, which neither a content-only response nor a truncation
marker can satisfy, so declaring it would turn a degraded result back into a
lost one. For the same reason `toolServer.ts` names the failing instance path
and keyword when Ajv rejects a call — `Invalid arguments for tool X` on its own
leaves trial and error as an agent's only route to a tool's argument shape.

`fixtures/testMcpServer.mjs` has to keep modelling a server that answers the way
real ones do — content only, structured only, both, an `isError` refusal
carrying its own reason, and a result past the bound. It was a single
never-failing text-only tool, which is exactly why a passthrough that dropped
every payload passed every test.

`moltnet_read` also has to page. Moltnet's frozen machine wire caps a response
line at 16384 bytes and any single message part at 4096, and `projectRead`
refuses an oversized page with `error.code: "transport"` rather than truncating
it, so a single large `limit` can never be served on a busy room.
`moltnetMachineRead.ts` owns that adaptation — small pages, cursor following,
adaptive backoff — and Daimon adapts to the wire rather than changing it. A
`machine` error must always surface its own code; the generic refusal it
replaced hid a never-working tool for as long as the tool existed.

Each engine/tool child receives only the current non-secret wake id in
`DAIMON_WAKE_ID`; it is bound for one turn and cleared afterward. Transports
may use it as an idempotency/cause key, but Daimon does not interpret transport
identities or targets.

`attentionDispatcher.ts` owns execution selection from durable deliveries. The
per-agent claim in `wakeAcceptanceStore.ts` atomically binds all selected ids
before any record transition or engine invocation. Never restore batching by
counting arrivals or marking read messages complete. `attention` is opt-in;
unmarked/deferred deliveries wait for new input without a self-wake loop.
Live turn authority is `activity.executions`, independent of receipt completion;
its execution id must equal the engine wake id. Budget pauses retain acceptance,
and operator stop remains a hard latch.
