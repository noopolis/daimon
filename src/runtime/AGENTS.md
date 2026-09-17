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
request. That bound holds only because a turn has at most one upstream request
in flight: an overlapping request is refused (429, uncounted), and Grok's loop
is sequential in every live capture. A per-request usage block above
`turnLimits.requestUsageMaxTokens` (500k) is invalid, and a response without
valid usage is charged `ceil(bodyBytes/2) + 4096` tokens (rows say
`usage_source: "estimated"`, usage rows `estimated_requests`), so a missing
`usage` never disables the ceiling. A broker timer also trips `timeout` for a
worker that is mid-request, and any trip aborts the in-flight upstream call. Limits come from `service.json` v2
(`engineBrokerServiceConfig.ts`; v1 gets `GROK_ENGINE_BROKER.turnLimits.v1Defaults`)
and a wake may only lower them: a raise is refused as `invalid_request`, never
clamped.

The broker stays the single sealed usage writer. `grokEngineBrokerTurn.ts`
seals every terminal turn — completed, failed, limit, cancelled — through
`finishBrokerTurnWithUsage` (`grokEngineBrokerMetering.ts`): the turn registry
record v2 stores the control-protocol v2 terminal response *with* its
numeric-only accounting (`usage`, `outcome`, declared `model`, `requests`,
closed `limitReason`) *and the exact ledger bytes it owes*, and only then are
those bytes appended. A replay returns the sealed accounting and never meters
again; it only appends the sealed bytes when the ledger has no row for that
`turn` (a crash between seal and append). Two replays of one sealed turn in
the same broker may both append those identical bytes (a second broker cannot
exist: the realm lease is an exclusive lock), so **every ledger consumer —
`wakeFuse.ts`, Spawnfile's reader (P3), Paideia's evidence reader (P4) — MUST
dedupe usage rows by `turn`** (`dedupeTurnUsageRows`). The turn record's rename
is its publish point: a directory-sync failure after it is reported, never
raised, so a published completed turn is never re-sealed as failed. The window not closed: a crash
before the record's rename seals the turn `failed` with `usage: null` on the
next boot. Once a completed record is sealed, nothing after it can re-seal the
turn as failed. v1 records still replay (upgraded with `usage: null`). Completed usage is the terminal `result.usage`;
a failed turn's partial usage is its per-request stream frames
(`../pi/grokStreamUsage.ts`) when output arrived, else the upstream usage the
proxy saw. Usage rows carry `turn` (the idempotency key readers dedupe on —
`wakeFuse.ts` does), `limit_reason` and `model`; per-request rows go to
`requests.jsonl` beside the registration's `usageLedgerPath` with proxy-measured
`started_at`/`ended_at`. A provider-reported model key must map to the declared
model (`grok-4.6-build` → `grok-4.6`), otherwise the turn fails as rejected and
is still metered. Control protocol v2 is refused-v1 on the wire because both
ends ship in this package.

A failed brokered turn also carries the worker's own last words. The launcher
gives the worker one pipe for stdout and stderr and publishes no output for a
failure, so a `worker_failed` turn used to reach the host as nothing but
`exit=1` — the reason the worker printed died with the container's tmpfs.
`DBL_MAX_DIAGNOSTIC` (512 bytes) is now the launcher's bounded tail of that
pipe, sent beside the fixed result frame in `diagnostic_length` and kept only
for a worker that exited on its own account: an output-limit tail would be the
very payload the bound refused, a cancelled turn has no reader left, and a
prelaunch failure ran nothing. `engineBrokerNativeClient.ts` redacts that tail
exactly as the CLI child path redacts a failed engine child
(`redactCredentialText` with the turn's own provider/MCP capabilities as exact
secrets, the same `CLI_ENGINE_MAX_DIAGNOSTIC_BYTES` bound) and flattens it to
one line as `diagnostic.reason`. It is an optional, control-character-free
member of the sealed terminal response's closed diagnostic — admitted by
`engineBrokerProtocol.ts` only for the statuses where a worker ran and spoke —
so it replays with the sealed record and reaches the operator through
`engineBrokerControlClient.ts`'s failure message. Nothing new is written to
disk: the reason travels inside the response the broker already seals.

Evaluator inference grants (`grokInferenceGrants.ts`) let Paideia judges and
the DSPy optimizer — uid 2000, the trusted evaluator side — spend the broker's
Grok credential without holding it. `request_inference_grant {model,
reasoningEffort, purpose: judge|optimizer}` is an additive control protocol v2
verb (`engineBrokerInferenceProtocol.ts`); only the organization uid reaches it,
because the native relay admits only that `SO_PEERCRED` uid on `control.sock`
(the TS backend sees only the relay). The answer is a token
(`inference_` + 32 random bytes), the proxy base URL, an expiry (TTL ten
minutes) and the manifest limits; `release_inference_grant` frees one of the
eight live-grant slots early. Grants are their own kind: their own map keyed by
a random grant id, never the turn capability or turn meter maps, and the proxy
routes a bearer by its prefix to exactly one of the two lookups. A grant has no
worker isolation guard but the same spend gate as a turn (one request in
flight, request ceiling, between-requests token ceiling, estimate on missing
usage), so one grant is one sequential lane — parallel judges each hold one.
`grokInferenceProxyRequest.ts` accepts exactly what Grok 1.0.34 sends for the
Paideia judge argv (live stub capture): `stream: true` with
`stream_options.include_usage`, the declared `model`/`reasoning_effort`, plain
`{role, content}` messages, optional `response_format` json_schema, and **no
`tools` or `tool_choice` member at all** — the CLI's per-call `session_title`
request carries both and is refused locally. Every settled request appends one
`kind: "inference"` row (`purpose`, `grant`, `request`, model, usage,
`usage_source`) to `service.json` v2's optional `inferenceLedgerPath`, which
may never be a subject ledger; readers dedupe on `(grant, request)`
(`dedupeInferenceUsageRows`), and `wakeFuse.ts` skips inference rows. Without
that path every grant request is refused `unavailable`. Grants share the
subject's credential authority, so a stale realm fails both (accepted shared
fate): the grant request is refused `auth_stale`, and a proxied grant request
that meets a stale realm gets HTTP 401 `{"error":"auth_stale"}`, which the CLI
surfaces immediately as `Internal error: "Unauthorized (401) from …:
auth_stale …"`. `grokInferenceClientConfig.ts` renders the evaluator's private
`GROK_HOME` `config.toml` (pinned per model/effort in the manifest): the grant
token through `env_key = "DAIMON_INFERENCE_GRANT"`, the worker's lean settings,
no MCP, and `max_retries = 0` — with the default, Grok retries a refused (503)
request with backoff past 45 s instead of failing in ~0.35 s. Its init frame
reports `apiKeySource: "user"`, `tools: []`, `mcp_servers: []`, and the CLI
must be run with `--model daimon-inference-grok`. The inference ledger
directory must be provisioned setgid to the organization group (e.g.
`2100:2000 2750`) for uid 2000 to read rows the broker creates `0640`.

`grokBrokerProjection.ts` is the public, I/O-free projection of one brokered
Grok agent's slot (`noopolis.daimon.grok-broker-projection.v1`): Daimon's own
deny collectors plus the caller's evaluator paths, profile/config/prompt
digests, pinned executable, model, limits and ledger. A Grok agent must declare
`model` and `reasoningEffort` for it; nothing is defaulted, and a supplied
profile digest that differs is refused. Paths are never resolved: Spawnfile
must supply canonical non-symlink paths (its fixed tmpfs and workspace roots)
and verify that during provisioning. The projection also carries the seccomp
profile digest and the `bubblewrap` sandbox runtime a receipt must match. `grokSlotPreflightReceipt.ts` is the
zod schema a root slot supervisor's receipt must satisfy
(`noopolis.daimon.grok-slot-preflight.v2`, fixtures under
`fixtures/grok-slot-preflight/`); `verifyGrokSlotPreflightReceipt` binds it to
the projection digest and requires a denied canary for exactly every deny path.
The projection digest does not change across recycles, so the receipt also
carries freshness: a supervisor-owned per-slot `generation` (strictly
increasing) and the caller's recycle `nonce` (32 random bytes, hex). The
verifier requires `{expectedNonce, minGeneration}` and refuses another nonce, a
lower generation, and any v1 receipt.

`grokBrokerWorkerConfig.ts` is the only source of worker `config.toml` bytes;
the manifest pins the sha256 of every model/effort combination and the broker
refuses a turn whose worker config does not hash to the declared one. Three
1.0.34 facts shape it, each verified against a loopback stub model:
`[auth_provider.*]` helpers never run for a custom model, so the turn's proxy
capability reaches the model through `env_key = "DAIMON_PROVIDER_CAPABILITY"`
set by the native launcher (as exposed as `DAIMON_MCP_CAPABILITY`); the
per-turn `session_title` request cannot be disabled by any key, so
`[models] session_summary` points it at a hidden model
(`GROK_SESSION_TITLE_SINK_MODEL_ID`) whose `base_url` is the broker's own
provider proxy and whose `api_key` is a placeholder too short to ever be a turn
capability — so the request does reach the proxy and is refused there, before
any capability lookup, isolation guard, credential read or upstream call, and
Grok falls back to the truncated prompt as the title. That refusal and a bare
unauthenticated `GET /` probe are the two requests a healthy turn always makes
and the proxy never forwards; neither prints a `refused:` line, because for as
long as they did, every healthy turn read as broken. Every *other* refused
request does name itself on the broker's stderr, and a fault that is not a
`GrokBrokerProxyRefusal` names its own class and message beside
`broker_unavailable` — `[grok-proxy] refused: broker_unavailable (TypeError:
…)` — because the bare word carries no diagnostic content and is answered 503,
which Grok blind-retries: one live turn emitted it fifteen times over five
minutes, spent $0, and died with no account of why. That cause is the error's
class and message only (never a body, bearer, capability, session id or
header), redacted through `redactCredentialText` with that request's own
capabilities as exact secrets and the `CLI_ENGINE_MAX_DIAGNOSTIC_BYTES` bound,
flattened to one line, exactly as the failed CLI child and the launcher's
worker diagnostic are. It is a log line only: the 503 is unchanged, because a
genuinely transient fault is still transient. The sink keeps its 503
shape because every live capture was taken with it: forcing 400 and 503 there
were both observed to end the turn `exit=0, result: success`, so a hard 4xx on
that request does *not* end Grok's session. And effort is only sent when the
model declares it, so the declared effort is
the model's single `reasoning_efforts` entry. HTTP MCP needs CA certificates in
the image even for a loopback `http://` URL ("Failed to build HTTP client").

`engineBrokerMcpFacade.ts` is the worker's only route to its per-wake MCP mount
and rebuilds every header from a closed allowlist in both directions, so the
worker's bearer never reaches the mount and no mount header reaches the worker
uninvited. That allowlist must include the Streamable HTTP transport's own
routing headers or the route does not exist: forwarding only
`content-type`/`accept` destroyed `Mcp-Session-Id`, so `initialize` returned 200
while every request after it — `notifications/initialized`, `tools/list`,
`tools/call` — came back HTTP 400 `Mcp-Session-Id header is required`, and the
model saw `search_tool` answer `{"results":[],"total_hidden_tools":0,"status":
"partial"}`. Client to mount: `content-type`, `accept`, `mcp-session-id`,
`mcp-protocol-version`, `last-event-id`. Mount to client: `content-type`,
`mcp-session-id`, `mcp-protocol-version`, plus the facade's own
`cache-control: no-store`. The session id is an opaque routing value and is
never logged or ledgered. The facade also carries the three methods the
transport uses — POST, the standalone `GET` SSE stream that is the only route a
server notification or progress frame can take, and the `DELETE` that ends a
session — and streams each body rather than buffering it, because a GET tunnel
stays open for the whole session. Never widen it into a transparent proxy: the
whole point of the boundary is that the allowlist is closed.

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

Deny-path placement (`grokWorkerDenyPlacement.ts`). Grok 1.0.34 materializes
every `deny` entry inside bubblewrap **as the worker uid**, bind-mounting
`$GROK_HOME/sandbox-blocked-{file,dir}` over the target, so an entry is
placeable only when every ancestor directory is searchable by that uid and the
target already exists and is not a symlink. One unplaceable entry makes Grok
refuse the *whole* profile (`bwrap: Can't create file at …: Permission
denied`), so every turn of that worker fails, not just that path. Matrix:
`.runtime/grok-deny-placement/EVIDENCE.md` in the ecosystem folder. The rule
therefore has two halves:
- shape, decidable without a filesystem and asserted by the renderer: canonical,
  and strictly below every base-profile grant (`GROK_WORKER_BASE_PROFILE_GRANTS`);
- placement, asserted by whoever provisions the paths — root provisioning and
  every slot recycle on the Spawnfile side, `prepareGrokWorkerAttestation`
  before every brokered turn, and `prepareAndVerifyGrokSandbox` on the direct
  path, which runs as the worker uid itself. The broker (uid 2100) cannot
  descend into a `2000:<worker> 0710` runtime home, so an `EACCES` below an
  ancestor the worker *can* search is left undecided there; root, which holds
  `CAP_DAC_READ_SEARCH`, decides every entry.

When a protected path is not placeable, the deny entry is **lifted** to the
nearest ancestor that is — never adding `o+x` to a private directory, because a
lift masks a superset and never widens the worker's reach. The durable
wake-acceptance store is exactly that case: it lives under the organization's
`state` directory, which the ownership guard secures `2000:2000 0700`, so the
mask goes on that directory (`acceptanceStoreDenyPath` in
`grokBrokerProjection.ts`, which refuses a mask that does not contain the
store).

Temp and spill isolation (`grokWorkerTmpAttestation.ts`, checked before every
turn; `GROK_ENGINE_BROKER.worker.home.{privateTmp,sharedTmp,spillDirectory}`).
Grok 1.0.34's strict profile grants shared `/tmp` and `/var/tmp` read-write
and refuses to start if either, or any path equal to or above a base grant, is
in `deny` (verified: `/tmp`, `/var/tmp`, `/run`, `/etc`, `sessions` all fail;
`/tmp/sub` works), so the profile cannot hide evaluator temp files. Instead:
- the launcher exports `TMPDIR=<worker home>/tmp` (strict adds TMPDIR to its
  read-write grants; Python, Node and `mktemp` use it); provision it
  `<worker>:<worker> 0700`. Every registered worker's private temp is attested
  before any turn, so one misprovisioned sibling refuses all turns;
- `/tmp` and `/var/tmp` must be `root:<non-worker group, e.g. org 2000> 1774`:
  Grok needs to open the directory, but without search or write a worker can
  only list names — `cat`/`read_file` get EACCES and it cannot create files.
  `1770`/`1771` make Grok refuse the profile; `1775`/`1777` leak. Any non-root
  process outside that group that needs temp space must get its own `TMPDIR`;
- the organization runtime home of a brokered Grok agent is `2000:<worker gid>
  0710` — traverse-only, so the worker can reach `tool-output/` and nothing
  else. `physicalReadiness.ts` accepts exactly that shape for a `grok` agent
  (owner the runtime user, mode `0710`, group a worker group that is not the
  runtime's own) and keeps the plain `0700` rule for every other engine; wider
  (`0711`, `0730`, `0750`, `0770`, any world bit, setgid) is refused, and so is
  a `0700` home for a Grok agent, because its worker could not read its own
  spills. Everything Daimon creates inside a runtime home is `0700`
  (`runtimeHomeLayout.ts`: telemetry, turn traces, world trajectories,
  `tool-state`, the engine XDG directories, `.tmp`), so a traversable home
  still exposes nothing but `tool-output/`. A deployment-provisioned memory
  home under that runtime home must stay `0700` for the same reason;
- spills (`toolResultSpill.ts`) are written `0640`; provision
  `<runtimeHome>/tool-output` as `2000:<worker gid> 2750` (setgid) under a
  runtime home the worker can traverse, so each spill carries that agent's
  worker group and no other worker can read it. The writer pins the directory
  (`O_DIRECTORY|O_NOFOLLOW`, dev/ino re-checked before publishing) and refuses
  one that is a symlink, not owned by the runtime, wider than `2750`, or
  group-open without setgid or in the runtime's own group; it cannot tell
  *which* worker gid belongs to the agent, so that mapping stays the
  deployment's. A spill is published by rename, replacing any existing entry
  (a planted symlink included) without following it.
- registered workspace and home paths must be canonical (no `.`, `..`, empty
  components or trailing slash) in both `service.json` and `registrations.bin`;
  the launcher refuses the slot otherwise.

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

Each Grok row also carries `tool_calls`: the tool-call NAMES that request's
response carried, read by the proxy from the body it already buffers for usage
(`parseGrokResponseToolNames` in `grokBrokerTurnMeter.ts`). Timings and tokens
alone cannot answer "did the model ever *try* to call `use_tool` or
`search_tool`", which is exactly the question two live turns left open. Names
only — never arguments, never message content, never a bearer; a `name` that is
not a plain short identifier is recorded as `<invalid>` rather than passed
through, and the list is bounded at `GROK_REQUEST_TOOL_CALLS_MAX` (16) entries
with a `<truncated>` last entry, so a pathological response cannot write an
unbounded row. Absence stays absence, as everywhere in these ledgers: a decoded
response that called nothing records `[]`, and a response that could not be
decoded records *no field at all*, because a fabricated empty list is
byte-identical to a measured one. On the stream row path the names are attached
only when the proxy's timings and the worker's stream requests are aligned
request-for-request, since an unaligned index would credit one request's attempt
to another. It is an additive field inside the unchanged
`noopolis.daimon.turn-requests.v1` row and deliberately not a version bump:
Spawnfile's reader pins `v` and ignores fields it does not know, and Paideia
only relocates this stream's path. The whole path is advisory — the parse is
wrapped, and nothing it does can refuse, delay, or fail a turn, or reach the
spend gate.

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
