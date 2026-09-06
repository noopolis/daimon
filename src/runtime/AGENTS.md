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

`agySubscriptionRealm.ts` owns the one host-level private D-Bus/Secret Service
realm, durable keyring lease, bounded unlock stdin, and cleanup.
`agySubscriptionBootstrap.ts` owns only the interactive first-enrollment AGY
child; normal engine dispatch remains in `engineDispatcher.ts`.
`portableCredentialMaterial.ts` imports bounded Codex ingress into its
runtime-writable home without clobbering a newer CLI-refreshed credential.
`grokSubscriptionRealm.ts` owns the single durable rotating Grok credential,
the lifetime lease, crash journal, stale fence, and serialized per-turn
stage/promote cycle while each agent retains private non-auth home state.
`../pi/grokSandbox.ts` owns the production Grok process boundary: it replaces
the provider's fail-open built-in profile with an exact custom profile denying
the realm, bootstrap, and peer roots, and requires a kernel-enforcement event
before every Grok setup, turn, and cleanup process.
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
`DEFAULT_CODEX_WAKE_TOKEN_CEILING`, both in `../pi/cliSession.ts`, overridable
via `DAIMON_CODEX_WAKE_TIMEOUT_MS`/`DAIMON_CODEX_WAKE_TOKEN_CEILING`. The token
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
