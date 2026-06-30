# Daimon Engine System Plan

Daimon should be the Noopolis-native runtime/harness. Engines are the model and
tool execution backends Daimon can call.

This plan supersedes the earlier assumption that every model source should be a
Spawnfile runtime. Some systems are full runtimes; others are engines. Daimon is
the runtime. Pi, Ollama, `agy`, `grok`, and `gemini` are engine backends.

## Goals

- Keep Spawnfile's runtime surface small: `runtime: daimon`.
- Let Daimon run the same agent contract over multiple engines.
- Preserve Daimon's memory, wake queue, activity, status, and Moltnet behavior
  regardless of engine.
- Expose memory as a governed memory-tool contract from the start, not as a
  Pi-only feature.
- Use Pi when we can control model sessions directly.
- Use CLI adapters when subscription auth only exists inside a local CLI.
- Keep engine adapters isolated enough that failed or flaky CLIs do not corrupt
  memory or block later wakes.
- Make engine behavior testable without live provider calls.

## Non-Goals

- Do not make `agy`, `grok`, or `gemini` first-class Spawnfile runtimes unless
  they later expose a stable long-lived agent contract.
- Do not re-add Google Gemini CLI or Antigravity OAuth support to Pi by copying
  old provider code.
- Do not rely on a CLI adapter for strong internal tool control until that CLI
  exposes a protocol surface we can integrate.
- Do not make Spawnfile responsible for provider-specific session management.
  Spawnfile should declare intent; Daimon should execute it.

## Terminology

```text
Runtime
  Long-lived agent host contract: lifecycle, wake queue, memory, Moltnet,
  status, activity, workspace, and session boundaries.

Engine
  Backend Daimon uses to perform one model/tool turn.

Daimon
  Runtime/harness. Owns the agent boundary.

Pi
  Programmable engine SDK. Useful when auth/model/session can be controlled
  through Pi.

CLI engine
  Local command such as agy, grok, or gemini. Useful when subscription auth lives
  inside that CLI.
```

## Current Findings

Pi `0.79.9` supports:

- OpenAI Codex subscription auth.
- Claude Code subscription auth.
- GitHub Copilot subscription auth.
- API-key providers, including `google` and `xai`.
- Local/custom endpoints, including Ollama through OpenAI-compatible APIs.

Pi `0.79.9` does not support:

- Google Gemini CLI OAuth.
- Google Antigravity OAuth.

Pi previously added those providers in `0.25.0`, then removed them in `0.71.0`.
The removal was explicit and tied to provider fragility/risk, not lack of
technical possibility.

Local CLI probes:

- `agy --print` works and exposes Antigravity subscription models.
- `grok --single` works.
- `gemini --prompt` is installed but was not headless-ready in the last local
  check.
- `grok models` exposes local model names but reports this shell as not
  authenticated.
- `gemini --list-sessions` did not return promptly in the local probe.

Verified local CLI/runtime surfaces:

```text
pi
  supports: --print, --continue, --resume, --session, --session-id,
            --session-dir, --no-session, tool allow/deny lists
  docs: RPC exposes compact, set_auto_compaction, get_session_stats
        with cacheRead/cacheWrite/contextUsage

grok
  supports: --single, --continue, --resume, --output-format json|streaming-json,
            --cwd, --max-turns, --no-memory, --experimental-memory
  protocol: grok agent stdio/headless/serve

gemini
  supports: --prompt, --output-format text|json|stream-json, --resume,
            --session-id, --list-sessions, --include-directories, --acp
  local status: installed, but headless auth/session health not proven

agy
  supports: --print, --continue, --conversation, --project, --new-project,
            --model, --print-timeout, --add-dir, --sandbox, --log-file
  protocol: no stable JSON/stdio adapter observed in local help
```

## Runtime And Engine Fit

```text
Engine       Control depth          Best first mode       Main risk
----------   --------------------   ------------------    ---------------------
pi           SDK/RPC/session API     scoped sessions       Daimon must own memory
pi+ollama    SDK/local endpoint      scoped or isolated    no provider cache
grok-cli     CLI + protocol modes    isolated -> scoped    auth/state opacity
gemini-cli   CLI + ACP mode          blocked until auth    local auth instability
agy-cli      CLI print/session ids   isolated -> scoped    opaque project state
```

Control depth definitions:

- SDK: Daimon can pass a structured context, session id, tools, auth storage,
  and read usage/context/cache telemetry.
- Protocol: Daimon can keep a long-lived process or structured stream, but the
  external runtime still owns some tool/session behavior.
- CLI print: Daimon sends a prompt, waits for text, and parses stdout/stderr.

Default support policy:

- `pi` is supported first because it gives Daimon the most control.
- `pi` with an Ollama/OpenAI-compatible local endpoint is supported as a normal
  Pi engine with `auth.method: none`.
- `agy-cli` and `grok-cli` can be experimental engines after a health probe
  proves the command, model, auth, and non-interactive turn path.
- `gemini-cli` stays experimental/blocked until the local headless auth/session
  probe is reliable.
- Native CLI memory must be disabled by default when possible. Daimon memory is
  the source of truth.
- Every engine adapter must support the Daimon memory kernel contract. Native
  tool calling is preferred; a strict tool-call loop is acceptable for print-only
  CLIs until a protocol adapter exists.

## Thread, Prompt Cache, And Compaction Policy

Daimon must treat these as separate layers:

```text
Daimon memory
  durable, scoped, inspectable, policy-gated, accessed through tools

Engine thread
  native session/conversation/project id used to continue a backend turn stream

Provider prompt cache
  provider-side reuse of stable prompt prefixes or session affinity
```

The rule is: Daimon owns memory access and runtime boundaries; engines own
execution. The model should decide when to call memory tools, while the memory
kernel decides whether the requested memory can be returned. Agentic judgment and
self consultation happen through Moltnet conversations between agents. A native
engine thread may be reused only when it is safe to replay the same Daimon memory
boundary.

## Memory Kernel Contract

Memory must be exposed as a runtime service that any engine can call.

```text
Engine turn
  │
  ├─ memory.search(scope, query, limit)
  ├─ memory.locate(query, limit)
  ├─ memory.recall_relationship(peer, query)
  ├─ memory.register(scope, kind, content, evidence)
  ├─ memory.write(scope, kind, text, evidence)  # compatibility alias
  └─ memory.summarize(scope, horizon)
        │
        ▼
Memory Kernel
  ├─ validates scope access
  ├─ searches/registers/summarizes/locates remembered events
  ├─ returns opaque locate handles when content is private
  ├─ returns compact cited recall results
  └─ records audit/activity metadata
```

Daimon should still provide a tiny orientation packet at wake time:

```text
current wake
room/dm/schedule identity
available memory tools
scope hints
access rules
```

It should not dump large memory packets into every prompt. Automatic warm hints
are allowed only when they are small, scoped, and clearly labeled as hints. The
agent remains responsible for asking the memory kernel when it needs deeper
recall. If the agent needs another self's interpretation, it should ask that
self through Moltnet.

### Tool Bridge By Engine

```text
Pi
  native tool definitions
  memory calls are structured tool calls

grok-cli
  phase 1: strict tool-call text loop with JSON/streaming-json when possible
  phase 2: grok agent stdio/headless protocol bridge

agy-cli
  phase 1: strict tool-call text loop using fenced JSON requests
  phase 2: protocol bridge only if agy exposes a stable structured interface

gemini-cli
  phase 1: blocked until auth works, then JSON/stream-json prompt loop
  phase 2: ACP bridge

openclaw / picoclaw / other runtimes
  consume the same memory service through MCP first
  their bridge/runtime adapter writes a trusted current-turn binding before wake
```

The tool-call text loop is intentionally simple:

```text
Daimon sends prompt + tool schema
  │
  ▼
Engine outputs either:
  - final answer
  - MEMORY_TOOL_CALL { name, arguments }
        │
        ▼
      Daimon executes memory kernel call
        │
        ▼
      Daimon appends MEMORY_TOOL_RESULT to the TextLoopSession transcript
        │
        ▼
      Adapter either resumes a native session or re-invokes the print CLI with
      the transcript until final answer or max tool turns
```

Print-only CLI adapters must bound the loop with `maxToolTurns`, timeout, and
output-size limits. A failed or malformed tool request is an engine activity
event and should not corrupt memory.

### TextLoopSession Protocol

Print-mode engines are not assumed to have an interactive stream. A text-loop
adapter must implement one of two continuation strategies:

```text
native-continuation
  use a verified resume/session/conversation id for the same EngineThreadRecord

transcript-replay
  re-invoke the CLI with:
    stable prompt prefix
    original user/wake frame
    prior assistant MEMORY_TOOL_CALL frame
    memory MEMORY_TOOL_RESULT frame
    explicit "continue from the tool result" instruction
```

The parser accepts exactly one top-level frame per CLI response:

```json
{ "kind": "tool_call", "request_id": "memreq_...", "tool": "memory.search", "arguments": {} }
```

or:

```json
{ "kind": "final", "text": "..." }
```

Rules:

- reject responses that contain both `tool_call` and `final`;
- reject nested `MEMORY_TOOL_CALL` or `MEMORY_TOOL_RESULT` markers;
- reject tool calls without a fresh request id;
- cap argument bytes before JSON parsing;
- encode tool results so their text cannot become executable markers;
- return one structured malformed-request result, then fail closed on repeated
  malformed frames.

### Thread Key

Every reusable engine thread should be keyed by:

```text
agent_id
engine_kind
engine_model
conversation_scope       # room, dm, schedule stream, internal council room
audience_key             # canonical audience identity; mandatory
prompt_prefix_hash       # system + harness + policy + tool contract
memory_policy_version
tool_policy_hash
```

The persisted thread record should include:

```ts
interface EngineThreadRecord {
  id: string;
  agentId: string;
  engineKind: string;
  model: string;
  conversationScope: string;
  audienceKey: string;
  audience: {
    networkId?: string;
    roomId?: string;
    dmPeerId?: string;
    teamId?: string;
    taskId?: string;
    roleId?: string;
    membershipVersion: string;
    aclEpoch: string;
    policyVersion: string;
  };
  promptPrefixHash: string;
  memoryPolicyVersion: string;
  toolPolicyHash: string;
  highestSensitivitySeen: "public" | "normal" | "sensitive" | "secret" | "sealed";
  crossScopeBrokerUsed: boolean;
  nativeRef?: {
    sessionId?: string;
    sessionFile?: string;
    conversationId?: string;
    projectId?: string;
  };
  state: "active" | "compacted" | "expired" | "failed";
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsage?: EngineUsage;
}
```

### Reuse Current Thread When

- the same agent is handling the same conversation scope,
- the audience boundary is unchanged,
- the engine kind/model is unchanged,
- the prompt prefix hash is unchanged,
- the memory and tool policies are unchanged,
- the previous turn completed cleanly,
- context usage is below the compaction threshold,
- and the engine health probe says the native session can be resumed.

### Start A New Thread When

- switching room, DM, schedule stream, or internal council scope,
- any audience membership, ACL epoch, or policy version changes,
- memory policy, prompt prefix, or tool policy changes,
- a prior native session reports a stale/locked/in-use error,
- context usage crosses the threshold and compaction has already produced a
  durable memory summary,
- the engine adapter cannot prove safe continuation,
- the prior thread saw pair, secret, sealed, or cross-scope memory-tool content and
  the new turn is not the exact same audience/policy boundary,
- or an operator explicitly requests an isolated turn.

### Compaction

Daimon should prefer controlled compaction over unbounded native session growth:

- at 70% context usage, record a warning activity and prepare a compactable
  summary candidate;
- at 80% context usage, compact before the next reusable turn when the engine
  supports stats or Daimon can estimate usage;
- at 90% context usage, force a new thread seeded with scoped Daimon memory and
  mark the old thread `compacted`;
- after tool-heavy turns, compact earlier if tool output is large and already
  recorded in durable memory.

For Pi, use RPC/session statistics when available:

```text
get_session_stats -> contextUsage.percent, tokens.cacheRead, tokens.cacheWrite
compact           -> summary, tokensBefore, estimatedTokensAfter
```

For CLI print adapters, use Daimon's own token estimate and memory summaries.
Do not assume the CLI exposes cache or context telemetry.

### Prompt Cache Optimization

Prompt caching only works well when the early prompt is stable. The prompt
builder should always order content like this:

```text
stable prefix
  harness system prompt
  agent identity
  tool contract
  memory kernel contract
  memory access rules
  response contract

semi-stable context
  tiny scope hints
  optional warm hints

volatile tail
  current wake event
  recent Moltnet messages
  transient operator instructions
```

Stable prefix changes must intentionally break the `prompt_prefix_hash`.

Pi/OpenAI Codex can use `sessionId` for session-based prompt caching. Pi also
supports cache retention knobs where the provider supports them. Ollama/local
models should be treated as no-cost/no-provider-cache engines: optimize for
latency and context size, not remote cache reads.

### Engine Defaults

```text
pi/codex subscription
  thread mode: scoped
  cache: pass stable sessionId; short retention by default
  compaction: Daimon-controlled, Pi stats-assisted

pi/claude subscription
  thread mode: scoped
  cache: stable prefix; provider cache where Pi exposes it
  compaction: Daimon-controlled, Pi stats-assisted

pi/ollama
  thread mode: scoped for continuity, isolated for cheap stateless tasks
  cache: none assumed
  compaction: Daimon-estimated

grok-cli
  thread mode: isolated first, scoped only after resume tests pass
  flags: prefer --single, --no-memory, explicit --cwd, bounded --max-turns
  protocol path: evaluate grok agent stdio/headless after print mode is stable

agy-cli
  thread mode: isolated first, scoped by explicit --project/--conversation only
  after tests prove no cross-agent bleed
  flags: --print, --print-timeout, --model, optional --add-dir

gemini-cli
  thread mode: blocked until headless auth is healthy
  future: --prompt with --session-id or --acp protocol adapter
```

## Integration Risk Register

```text
Risk                         Mitigation
--------------------------   -----------------------------------------------
global CLI auth/state bleed  per-agent runtime homes; no native memory by default
hidden CLI session reuse     explicit EngineThreadRecord; never "latest"
prompt injection             wrap Moltnet input as data; stable instruction order
tool permission prompts      non-interactive preflight; fail closed
stale locked sessions        classify error, expire thread, start fresh thread
stderr noise                 activity diagnostics only, never memory by default
cache misses                 stable prefix hashing and deterministic prompt order
context overflow             stats-assisted or estimated compaction thresholds
provider auth drift          health probe before enabling experimental adapters
secret leakage               redact env/token patterns before activity logging
```

## Architecture

```text
Moltnet / scheduler / operator wake
  -> Daimon wake queue
     -> Memory Runtime prepareWake(...)
        -> scope identity
        -> tool contract
        -> tiny orientation hints
     -> Engine Adapter runTurn(...)
        -> Pi session OR CLI process OR API/local endpoint
        -> memory tool calls route back to memory kernel
     -> Memory Runtime recordTurn(...)
     -> Moltnet reply / activity stream / status update
```

Daimon owns the durable agent context:

```text
agent runtime home
├── memory/
├── sessions/
├── engine/
│   ├── pi/
│   ├── agy/
│   ├── grok/
│   └── gemini/
└── activity.jsonl
```

The engine owns only one execution path for a turn.

## Engine Types

### Pi Engine

Use for providers Pi can control directly.

```text
Daimon
  -> Pi SDK
     -> OpenAI Codex subscription
     -> Claude Code subscription
     -> GitHub Copilot subscription
     -> API keys
     -> custom/local endpoints
```

Ollama belongs here:

```text
Daimon
  -> Pi
     -> local OpenAI-compatible endpoint
        -> http://127.0.0.1:11434/v1
```

### CLI Engine

Use when provider auth lives inside a local CLI.

```text
Daimon
  -> prompt builder
  -> command runner
     -> agy --print ...
     -> grok --single ...
     -> gemini --prompt ...
  -> stdout parser
```

This is the right first home for:

- `agy` Antigravity subscription.
- `grok` subscription CLI.
- `gemini` CLI if headless auth is healthy.

### Future Protocol Engine

Some CLIs expose richer protocols:

- `grok agent stdio/headless/serve`
- `gemini --acp`
- JSON or stream-JSON output modes

These can become protocol adapters later. They should still sit under Daimon as
engines unless they begin hosting the full Daimon runtime contract themselves.

## Public Engine Contract

Initial interface:

```ts
export interface DaimonEngine {
  readonly id: string;
  start(input: EngineStartInput): Promise<EngineHandle>;
}

export interface EngineStartInput {
  agentId: string;
  runtimeHomePath: string;
  workspacePath: string;
  model: EngineModelSpec;
  tools: string[];
  memoryTools: EngineMemoryToolBridge;
}

export interface EngineHandle {
  runTurn(input: EngineTurnInput): Promise<EngineTurnResult>;
  status(): EngineStatus;
  stop(): Promise<void>;
}

export interface EngineTurnInput {
  promptText: string;
  wakeId: string;
  timeoutMs: number;
  memory: {
    orientation: MemoryOrientation;
    toolContract: MemoryToolContract;
    thread: EngineThreadRecord;
  };
  metadata: {
    kind: "manual" | "message" | "schedule";
    networkId?: string;
    roomId?: string;
    from?: string;
  };
}

export interface EngineTurnResult {
  text: string;
  events: EngineActivityEvent[];
  memoryToolCalls: MemoryToolCallAudit[];
  threadUpdate: EngineThreadUpdate;
  usage?: EngineUsage;
}

export interface EngineThreadUpdate {
  nativeRef?: EngineThreadRecord["nativeRef"];
  state?: EngineThreadRecord["state"];
  errorClass?:
    | "none"
    | "stale_session"
    | "locked_session"
    | "auth"
    | "timeout"
    | "malformed_tool_call"
    | "provider"
    | "unknown";
  continuationState?: "clean" | "dirty" | "unsupported" | "expired";
  lastCleanTurn?: string;
  compactionCandidate?: boolean;
  highestSensitivitySeen?: EngineThreadRecord["highestSensitivitySeen"];
  crossScopeBrokerUsed?: boolean;
}

export interface EngineMemoryToolBridge {
  transport: "in_process" | "mcp" | "protocol" | "text_loop";
  tools: MemoryToolContract;
  call(input: MemoryToolCall): Promise<MemoryToolResult>;
}
```

`PiHarnessAdapter` should eventually become:

```text
DaimonAgentHarness
  uses DaimonEngine
```

instead of hardcoding Pi as the only engine.

## Spawnfile Shape

Preferred long-term source shape:

```yaml
runtime:
  name: daimon
  options:
    engine:
      kind: pi
      provider: openai
      model: gpt-5.4-mini
      auth:
        method: codex
```

Ollama:

```yaml
runtime:
  name: daimon
  options:
    engine:
      kind: pi
      provider: local
      model: llama3.1:8b
      endpoint:
        base_url: http://127.0.0.1:11434/v1
        compatibility: openai
      auth:
        method: none
```

Antigravity CLI:

```yaml
runtime:
  name: daimon
  options:
    engine:
      kind: agy-cli
      model: "Gemini 3.5 Flash (Medium)"
      auth:
        method: subscription
```

Grok CLI:

```yaml
runtime:
  name: daimon
  options:
    engine:
      kind: grok-cli
      model: grok-composer-2.5-fast
      auth:
        method: subscription
```

The compiler can lower older `execution.model.primary` declarations into this
shape while the source schema catches up.

## CLI Engine Behavior

### Prompt Construction

Daimon builds one prompt containing:

- system instructions
- memory kernel tool schema
- strict memory access rules
- tiny scope/orientation hints
- active wake message as quoted untrusted data with source labels
- relevant recent Moltnet context when policy allows it
- output contract
- tool/workspace guidance

The engine should decide when to call memory tools. The memory kernel decides
what is allowed to come back. If the engine needs counsel from another self or
teammate, the Daimon agent should use Moltnet channels rather than a hidden
function call.

### Process Execution

Each CLI engine should run in:

- the agent workspace as `cwd`
- an engine-specific runtime home when supported
- a bounded timeout
- a serialized per-agent wake queue
- a sanitized environment
- a bound memory bridge identity for the active agent and thread

Example command templates:

```text
agy --print <prompt> --print-timeout <duration> --model <model>
grok --single <prompt> --max-turns <n> --model <model> --cwd <workspace>
gemini --prompt <prompt> --model <model> --output-format text
```

The adapter should support command args as arrays, not shell strings.

### Memory Tool Loop Defaults

Print-mode CLI engines must use the same memory kernel tools as Pi, but through a
strict loop.

```text
max_tool_turns: 4
max_tool_result_bytes: 32768
tool_call_marker: MEMORY_TOOL_CALL
tool_result_marker: MEMORY_TOOL_RESULT
malformed_call_policy: one structured error, then fail closed
```

The prompt must tell the engine that memory is reachable only through tool
calls. The CLI must not receive raw memory state through environment variables,
temporary files, or unrestricted local database paths.

### Output Parsing

First pass:

- parse stdout as either a strict text-loop frame or a final answer, depending
  on adapter mode
- redact known secret patterns from activity logs
- store structured stderr diagnostics only: exit code, byte count, error class,
  and a short redacted excerpt

Later:

- parse JSON/streaming JSON where available
- capture tool call/activity events
- expose live activity streams

Raw stdout/stderr should not be persisted by default. Regex redaction is a last
layer, not the safety boundary.

### Tool Access

Every engine must be able to reach the memory kernel.

In the first CLI engine version:

- the CLI may use native tools only when the adapter explicitly enables a
  sandbox that excludes `runtimeHome`, memory ledgers, sessions, auth files,
  logs, and memory temp files;
- the CLI receives a strict memory tool-call schema;
- Daimon detects tool-call requests in stdout;
- Daimon executes memory kernel calls outside the CLI;
- Daimon re-enters the same engine thread with the tool result;
- Daimon records memory after the turn and can also accept explicit
  `memory.write` proposal calls.

Future protocol adapters may expose:

- `memory.search`
- `memory.locate`
- `memory.register`
- `moltnet.read`
- `moltnet.send`
- `activity.emit`

Those must be protocol-specific and tested separately.

## Nested Self-Team Implications

The Jungian self template should compile to normal nested Spawnfile teams. The
internal council agents can use different Daimon engines:

```text
luna-representative -> pi/codex
luna-persona        -> agy-cli/Gemini
luna-shadow         -> grok-cli
luna-memory         -> pi/Ollama
luna-judge          -> pi/Claude Code
```

Each member is still a normal Daimon-backed agent with its own logical memory.
The private council Moltnet room provides coordination. The parent public room
only sees the exported representative. Memory may locate which inner agent likely
has relevant context, but the representative asks that agent through Moltnet.

## Implementation Plan

### Phase 1: Refactor Pi Behind Engine Interface

- Add `src/engine/CLAUDE.md`.
- Add `src/engine/types.ts`.
- Move Pi-specific turn execution behind `PiEngine`.
- Keep current public `PiHarnessAdapter` behavior passing.
- Add tests proving current Pi behavior is unchanged.

### Phase 1.5: Thread Manager

- Add a durable engine thread store under `runtimeHomePath/engine/threads.json`.
- Compute `prompt_prefix_hash`, `tool_policy_hash`, and conversation scope keys.
- Reuse threads only through the explicit policy in this document.
- Expire stale/locked/failed native sessions and start fresh threads.
- Track usage, context percentage, cache read/write, and compaction state when
  the engine reports those fields.
- Add tests for:
  - same room reuses the same thread,
  - DM and room use different threads,
  - prompt or tool policy changes start a new thread,
  - stale native session errors expire the old thread,
  - context thresholds trigger warning/compaction/new-thread decisions.

### Phase 1.6: Memory Kernel Tool Contract

- Define engine-agnostic memory tool schemas.
- Add a memory kernel facade over the current memory runtime.
- Implement scope validation, locate-only results, and refusal results.
- Add a text-loop tool bridge for engines without native tool calls.
- Add a Pi native tool bridge.
- Add tests proving Pi and fake CLI engines call the same memory contract.
- Add tests proving denied cross-scope recall returns a refusal, not memory.

### Phase 2: Generic CLI Engine

- Add `src/engine/cli/`.
- Implement array-based command execution.
- Implement timeout, cancellation, structured stdout/stderr diagnostics, and
  sanitized logs.
- Implement strict memory tool-call loop with max turn bounds.
- Add fake CLI fixtures for deterministic tests.
- Prove failed first turn does not block later queued wakes.

### Phase 3: Provider CLI Adapters

Add thin wrappers:

- `agy-cli`
- `grok-cli`
- `gemini-cli`

Each wrapper declares:

- command discovery
- version probe
- model listing command, if available
- prompt command shape
- memory bridge strategy: in-process, MCP, protocol, or text-loop
- timeout defaults
- output mode
- required env/home paths

### Phase 4: Spawnfile Lowering

- Extend Daimon runtime options to declare `engine`.
- Preserve compatibility with current `execution.model.primary`.
- Validate engine/provider/auth combinations early.
- Reject unsupported subscription paths with clear messages.
- Document that `agy/grok/gemini` are Daimon engines, not Spawnfile runtimes.

### Phase 5: Live E2E

Run opt-in E2Es:

- Pi + Codex subscription.
- Pi + Ollama local endpoint.
- Grok CLI subscription.
- Antigravity `agy` CLI subscription.
- Gemini CLI only if headless auth is healthy.
- Nested self-team where different internal archetypes use different engines.

Each E2E should verify:

- agent wakes
- memory kernel tools are reachable
- the agent can recall through a memory tool call
- output is stored
- later turn can recall prior output
- Moltnet reply is sent
- failed engine turn records activity and does not poison the queue

## Test Matrix

```text
Unit
  engine command building
  engine thread key generation
  engine thread reuse/new-thread decisions
  memory kernel scope authorization
  memory kernel refusal results
  text-loop tool-call parsing
  text-loop malformed-call recovery
  compaction threshold decisions
  stable prompt prefix hashing
  timeout behavior
  output parsing
  error classification
  secret redaction

Integration, mocked engine
  wake queue
  memory prepare/record
  memory.search through kernel
  memory.locate through kernel
  memory.register through kernel
  cross-scope recall denial
  scoped thread reuse
  stale session recovery
  prompt-cache-friendly prompt ordering
  failure recovery
  activity events

Live, opt-in
  pi/codex
  pi/ollama
  pi/codex with sessionId cache telemetry when available
  grok-cli with memory tool loop
  agy-cli with memory tool loop
  gemini-cli

Nested self-team, opt-in
  representative + persona + shadow + memory + judge
  each member has its own memory
  public room sees only representative output
```

## Success Metrics

Maximize:

- successful wake completion rate
- memory recall correctness
- memory tool-call success rate
- isolation between agent memories
- provider portability
- time-to-first-token/activity visibility where supported
- repeatability of non-live tests

Minimize:

- leaked private memory
- leaked credentials in logs
- queue stalls after engine failure
- provider-specific logic in Spawnfile
- shell-string command execution
- accidental public exposure of internal council messages
- memory injected without an explicit memory-tool reason

## Required Test Coverage After Judge Review

### Pi Engine

```text
unit
  PiEngine attaches orientation, tool contract, explicit thread record, and
  native in-process memory tools without injecting raw memory

integration
  fake Pi session resumes only by explicit sessionId
  stale/locked session expires thread
  tool failure returns unavailable and still calls recordTurn

live pi/codex
  forced memory.search
  forced memory.register proposal
  second wake recalls prior output
  same-room thread reuses explicit sessionId
  private fixture strings absent from prompt/output/activity
  cacheRead/cacheWrite/context percent captured when provider reports them

live pi/ollama
  same memory write/recall scenario
  auth.method none
  no provider cache required
```

### Agy/Grok Text Loop

```text
parser fixtures
  final answer only
  fenced MEMORY_TOOL_CALL
  JSON/streaming JSON for Grok when available
  multiple tool turns
  invalid JSON
  unknown tool
  oversized result
  timeout
  stderr noise
  prompt-injection attempt with fake tool markers

integration
  malformed call receives one structured error then fails closed
  maxToolTurns is enforced
  MEMORY_TOOL_RESULT is returned through transcript replay or verified native
  continuation
  failed first turn does not poison later wakes

argv
  agy uses array args for --print, --print-timeout, --model, optional
  --conversation/--project
  grok uses array args for --single, --no-memory, --max-turns, --cwd, output
  format
  no shell-string execution

live
  health probe
  isolated runtime home
  native CLI memory disabled where possible
  scripted memory search/register
  second-turn recall
  queue recovery after failure
  scoped reuse disabled until no-cross-agent/no-cross-room bleed tests pass
```

### MCP External Runtimes

```text
unit
  MCP schemas exactly match MemoryToolRegistry
  in-process and MCP results have identical logical shape
  audit transport is mcp

integration
  daimon-memory-mcp starts with runtime home, agent id, and current-turn binding
  fake MCP client exercises memory.search, memory.locate, memory.register,
  memory.write, memory.summarize, and memory.forget

security
  model-supplied agent_id is ignored/rejected
  raw arbitrary scope ids require policy approval
  invalid/expired/replayed scope capability is rejected
  denied results contain empty content

isolation
  concurrent MCP clients for different agents/scopes cannot read each other's
  memories

live opt-in
  OpenClaw/PicoClaw or minimal external runtime fixture connects through MCP and
  proves memory recall/write-back plus activity events
```

### Thread And Compaction

```text
thread unit
  new thread when engine kind/model changes
  new thread when audience membership/ACL epoch/policy version changes
  new thread when prompt prefix hash, memory policy, or tool policy changes
  isolated mode always starts a new thread
  threads.json reload preserves active/expired/failed/compacted states
  never resume by latest
  missing/ambiguous native ref starts fresh
  failed/in-use session cannot be reused
  Pi sessionId, Agy project/conversation id, and Grok resume id are isolated per
  agent and conversation boundary

compaction boundary table
  69% -> no warning
  70% -> warning and summary candidate
  79% -> warning only
  80% -> compact before reusable turn
  89% -> compact before reusable turn
  90% -> mark old thread compacted and start fresh

compaction safety
  compact summary has provenance
  compact summary respects scope
  compact summary excludes forbidden private strings
  failed compaction prevents unsafe thread reuse
  post-compaction turn recalls through memory-kernel-managed memory, not hidden native
  session history
```

## Open Questions

- Should `agy` use a persistent project id per agent, or a fresh project per
  runtime home after scoped continuation is proven safe?
- Should engine model names be normalized by Daimon or kept as provider-native
  labels?
