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

Each engine/tool child receives only the current non-secret wake id in
`DAIMON_WAKE_ID`; it is bound for one turn and cleared afterward. Transports
may use it as an idempotency/cause key, but Daimon does not interpret transport
identities or targets.
