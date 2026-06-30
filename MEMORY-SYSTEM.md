# Daimon Memory System Design

Mneme is the standalone memory package used by Daimon. Daimon owns harnessing,
engine sessions, wake queues, and activity; Mneme owns memory storage, recall,
policy, tool contracts, and MCP.

The memory system is the boring substrate: it stores, indexes, searches,
summarizes, cites, redacts, and forgets remembered events. It is not the council,
not the judge, and not the speaker.

Deliberation stays agentic. If a representative needs to ask persona, shadow,
judge, a teammate, or another self, it should do that through Moltnet rooms,
DMs, or temporary query rooms. Memory can locate likely source principals, but
interpretation and judgment happen in conversations between agents.

## Core Split

```text
Moltnet
  rooms, DMs, events, wakes, public/private coordination

Daimon
  runtime, wake queue, engine sessions, activity, in-process Mneme access

@noopolis/mneme
  store, index, search, register, summarize, locate, redact, forget

Agents
  remember through tools, deliberate through Moltnet, judge through roles
```

Memory access policy and output judgment are different:

```text
memory access policy
  Can this principal retrieve or register this memory?

agentic judgment
  Should this self say, do, reveal, avoid, or ask something?
```

The memory package may enforce hard mechanical rules, such as "sealed memory
never returns content" or "private pair raw content never enters a public room
tool result." It should not decide the meaning of a situation or choose the
external reply.

## Goals

- Keep memories scoped by principal, team, room, pair, task, role, and artifact.
- Prevent cross-context contamination before prompt construction.
- Preserve provenance with an append-only event log.
- Let agents discover that relevant memory may exist without leaking it.
- Treat lexical, vector, graph, and narrative indexes as rebuildable
  projections, not as the source of truth.
- Provide a small portable tool contract across Daimon, MCP, protocol, and
  strict text-loop transports.
- Support deterministic tests before live model tests.
- Keep memory execution out of Spawnfile. Spawnfile declares intent; Daimon and
  the memory kernel execute it.

## Non-Goals

- Do not make Moltnet the memory store.
- Do not make memory responsible for council routing or self consultation.
- Do not make memory responsible for broad "can I say this?" judgment.
- Do not rely on embeddings as the source of truth.
- Do not rely on the active LLM prompt to enforce privacy boundaries.
- Do not require one physical database per agent by default.

## Research Checkpoint

The public SOTA pattern is a write-manage-read loop, not "chat history plus a
vector database."

```text
write
  observe raw events
  decide whether to register durable memory
  attach source, time, principal, scope, confidence, and evidence

manage
  deduplicate
  supersede stale claims
  consolidate episodes into narratives
  extract durable facts and relationships
  apply retention, redaction, and tombstones

read
  resolve allowed scopes first
  retrieve through lexical/vector/graph/temporal paths
  rerank and cite
  return the least revealing allowed result
```

The systems worth learning from converge on the same pieces:

- MemGPT/Letta: hierarchical context and agent-managed memory tools.
- Generative Agents: event stream, recency/relevance/importance, reflection.
- Reflexion/ExpeL/Voyager: memories as lessons, critiques, and reusable skills.
- Mem0/LangMem: scoped memory APIs and self-editing memory management.
- Zep/Graphiti and GraphRAG/HippoRAG/LightRAG: temporal and graph retrieval for
  multi-hop, relational, and "what was true when" questions.
- LOCOMO, LongMemEval, BEAM/DMR, and EvoMemBench: memory must be evaluated on
  long-range recall, temporal updates, abstention, leakage, and cost.

The implication for Daimon is clear: start with a deterministic event ledger and
lexical index, but design the records and query pipeline so embeddings, graph
edges, consolidation jobs, and rerankers can be added without changing the access
model or the public tool contract.

## External Backend Compatibility

Spawnfile should keep one portable memory contract and allow external backends
behind it. Local research clones live under:

```text
runtimes/mem0
runtimes/graphiti
runtimes/langmem
```

Compatibility notes are tracked in `specs/research/MEMORY-BACKENDS.md`.

The direction is:

```text
Spawnfile memory bank
  -> principal/scope policy
  -> portable tool contract
  -> native or external backend adapter

native backend
  -> SQLite/FTS/event ledger

Mem0 backend
  -> add/search/history/delete with Spawnfile metadata and policy wrapper

Graphiti backend
  -> episodes, temporal facts, graph search, provenance via backend adapter

LangMem backend
  -> tool/background manager primitives over a trusted namespace mapping
```

Guardrails:

- External backends do not define Spawnfile authorization. They store, index, and
  retrieve under a Spawnfile policy wrapper.
- Agents should receive Spawnfile memory tools, not raw Mem0/Graphiti/LangMem
  tools by default. Raw backend tools are operator/debug surfaces unless an
  adapter proves they preserve Spawnfile policy.
- Backend namespace, user, agent, group, graph, or thread ids must be derived
  from trusted runtime context.
- Native SQLite/FTS remains the baseline so memory works locally without cloud
  services, vector databases, or graph infrastructure.
- Vector and graph systems are projections or external backends, not the source
  of truth unless a future backend explicitly provides equivalent append-only
  provenance and tombstone semantics.

## Memory Types

The kernel stores events and derived records with explicit types. Type is not
just metadata; it controls write validation, consolidation, retrieval, and
auditing.

```text
raw_event
  wake, message, tool result, file observation, lifecycle event

episodic
  specific remembered event with time, actors, context, and outcome

semantic
  durable fact, preference, claim, relation, profile note, or temporal fact

procedural
  reusable process, lesson, skill, checklist, prompt fragment, or tool pattern

relationship
  model of a recurring peer, room, team, or collaboration pattern

artifact
  remembered file, commit, issue, document, generated output, or code decision

narrative
  derived scoped summary over time; never the source of truth

tombstone
  redaction, forgetting, expiry, sealing, or supersession event
```

Every derived record must cite source event ids. If a semantic fact or narrative
cannot point back to evidence, it is not accepted as durable memory.

## Physical Store And Logical Principals

Use one physical memory bank per trust boundary, with logical isolation inside
it. A Jungian self organization should usually have one bank, not one database
per archetype.

```text
memory bank: luna-self
┌────────────────────────────────────────────────────────────┐
│ physical store: runtimeHome/memory                         │
│                                                            │
│ principals                                                 │
│ ├─ luna-representative                                     │
│ ├─ luna-persona                                            │
│ ├─ luna-shadow                                             │
│ ├─ luna-judge                                              │
│ └─ luna-memory                                             │
│                                                            │
│ scopes                                                     │
│ ├─ global:luna                                             │
│ ├─ room:luna_self:council                                  │
│ ├─ room:public_net:agora                                   │
│ ├─ pair:luna-representative:luna-shadow                    │
│ ├─ task:deployment-incident                                │
│ └─ artifact:repo/src/file.ts                               │
└────────────────────────────────────────────────────────────┘
```

Each inner agent has its own logical memory line. The memory kernel enforces access by
principal and scope, even when the data is physically co-located.

Separate physical banks are useful when the trust boundary is actually separate:

```text
luna-self memory bank
sol-self memory bank
shared-project memory bank
operator-audit memory bank
```

## Relationship To Moltnet

Moltnet messages are events that can create memory. Moltnet is not memory.

```text
room:noopolis:agora -> memory scope room:noopolis:agora
dm:luna:lens-steward -> memory scope pair:luna:lens-steward
internal council room -> memory scope room:luna_self:council
temporary query room -> memory scope task:memory-query-<id>
```

For self organizations, consultation is just conversation:

```text
public room asks @luna a question
  -> luna-representative wakes
  -> representative posts the event to luna-feed or luna-council
  -> persona/shadow/judge may search their own memories
  -> persona/shadow/judge reply in the internal Moltnet room
  -> representative synthesizes one external reply
```

For "who remembers this?", use `memory.locate` plus a Moltnet query room:

```text
luna-representative calls memory.locate("blue deployment incident")
  -> memory returns opaque candidates:
       luna-shadow current_room confidence 0.74
       luna-memory artifact confidence 0.69
  -> representative opens room luna-query-20260629-abc123
  -> representative asks @luna-shadow @luna-memory for interpretation
  -> those agents search their own allowed memory and answer as agents
  -> representative closes or archives the query room
```

The memory system does not call those agents as functions.

## Runtime Integration

```text
Moltnet / scheduler / operator wake
  -> Daimon wake queue
     -> memory.prepareWake(...)
        -> active principal
        -> scope aliases
        -> tiny orientation
        -> memory tool contract
     -> engine turn
        -> model may call memory tools
     -> memory.recordTurn(...)
        -> observed messages
        -> explicit register calls
        -> output/action summaries
        -> audit/activity events
```

Daimon-native engines use in-process tools. External runtimes use MCP first.
Print-only engines use a strict text-loop fallback.

```text
Daimon/Pi engine
  -> in-process memory kernel

OpenClaw/PicoClaw/external runtime
  -> daimon-memory-mcp
  -> memory kernel

grok/agy/gemini print loop
  -> MEMORY_TOOL_CALL frame
  -> memory kernel
  -> MEMORY_TOOL_RESULT frame
```

## Public Memory API

The portable memory surface should stay small.

```text
memory.search(scope, query, limit)
memory.locate(query, limit)
memory.register(scope, kind, content, evidence)
memory.summarize(scope, horizon)
memory.forget(scope, event_ids, reason)
```

`memory.write` may remain as a compatibility alias while incubating, but the
preferred name is `memory.register`.

Tool names stay small, but their arguments need enough structure for serious
retrieval. Optional filters are part of the contract rather than an ad hoc later
extension.

```ts
interface MemorySearchArgs {
  scope: string;
  query: string;
  limit?: number;
  types?: Array<
    "raw_event" | "episodic" | "semantic" | "procedural" |
    "relationship" | "artifact" | "narrative"
  >;
  entities?: string[];
  tags?: string[];
  artifact_paths?: string[];
  observed_after?: string;
  observed_before?: string;
  valid_at?: string;
  include_superseded?: boolean;
  include_tombstoned?: false;
}

interface MemoryLocateArgs {
  query: string;
  limit?: number;
  active_scope?: string;
  types?: MemorySearchArgs["types"];
  entities?: string[];
  observed_after?: string;
  observed_before?: string;
}
```

Defaults:

- Superseded records are excluded unless `include_superseded` is true.
- Tombstoned/redacted records are never returned as raw content.
- Temporal queries prefer `valid_at` when present, otherwise ranking uses
  observed time, recency, salience, and relevance.
- If no `types` filter is supplied, search spans all allowed record types.

### memory.search

Returns allowed memories, claims, narratives, or artifact references for the
active principal. Results must include provenance.

Common search patterns:

```text
current room continuity
  scope: current_room
  query: "what happened before this message?"

private pair recall
  scope: current_pair
  query: "token refresh"

relationship recall
  scope: current
  query: "what do I know about @lens-steward?"

decision recall
  scope: current_task
  query: "why did we choose sqlite?"

artifact recall
  scope: current
  query: "src/runtime/pi/appCoreSource.ts"
```

### memory.locate

Finds likely source principals/scopes for a topic without returning private
content unless access policy allows it.

This supports agentic consultation:

```text
memory.locate("deployment token incident")
  -> candidate: luna-shadow/current_room, confidence 0.74, content: none
  -> candidate: luna-memory/artifact, confidence 0.69, content: none
```

The caller can then ask the candidates through Moltnet.

### memory.register

Registers explicit memory. It must always carry evidence and provenance.

Register patterns:

```text
observation
  A message, wake, tool result, lifecycle event, or file change happened.

claim
  The agent asserts a fact, preference, interpretation, or belief.

reaction
  A selflet records how an event landed emotionally or strategically.

decision
  The agent or group chose an option and recorded rationale.

relationship
  The agent learned something about a peer or recurring interaction.

artifact
  A file, commit, issue, document, or generated output changed.

narrative
  A derived summary of a scope over time.

tombstone/redaction
  A memory was forgotten, expired, redacted, or sealed.
```

`memory.register` should reject low-provenance writes by default. Required
fields:

```text
kind
scope alias or explicit approved scope
visibility
sensitivity
confidence
evidence event ids or wake id
source type
content
```

User-provided instruction-like text is quarantined and never written directly to
global/public memory without a derived claim step.

### memory.summarize

Returns or refreshes a scoped narrative summary. Summaries are derived artifacts,
not the source of truth.

### memory.forget

Appends tombstone/redaction events. It should not silently delete provenance.

Forget semantics:

- `forget` appends a tombstone/redaction event to the ledger.
- SQLite/lexical indexes must stop returning the forgotten content.
- Vector indexes must delete or mask the corresponding embedding ids.
- Graph indexes must remove or mark invalid the corresponding derived edges.
- Narratives and summaries that cite forgotten events must be regenerated or
  marked stale before being returned.
- Hard delete is an operator maintenance operation, not the default tool path.

## Access Policy

Access policy gates memory operations. It is not the council and not the judge.

Inputs:

```text
requester principal
active context
candidate source principal
scope
visibility
sensitivity
audience key
declared memory config
```

Outputs:

```text
allow_raw
allow_summary
allow_redacted_summary
known_but_private
locate_only
deny
unavailable
```

Default operation matrix:

| Operation | Raw private pair | Same team room | Public room | Sealed |
|-----------|------------------|----------------|-------------|--------|
| search | only in active pair | raw or summary by sensitivity | raw public, summary room | deny |
| locate | locate_only outside pair | locate or summary | locate public handles | deny existence |
| register | active principal only | active principal only | active principal only | operator/system only |
| summarize | pair summary only in pair | team/room summary | public summary | deny |
| forget | owner/operator only | owner/operator only | owner/operator only | operator/system only |

Promotion between scopes must be explicit. A private pair memory does not become
team, room, global, or public memory because an agent mentioned it in a search
query. A representative that wants to use private memory in public must consult
through agent behavior and produce a new public-safe statement with separate
evidence and sensitivity.

Hard rules:

- Private pair raw content never enters non-pair prompts or tool results.
- Sealed content reveals neither content nor existence.
- Team memory requires team membership.
- Room memory requires room participation or public visibility.
- Semantic search must only run inside scopes already approved by policy.
- Locate handles are disclosures and require policy approval.

## Storage Strategy

Start with event sourcing.

```text
<runtimeHome>/memory/events.jsonl       source of truth
<runtimeHome>/memory/index.sqlite       deterministic index
<runtimeHome>/memory/narratives/        derived summaries
<runtimeHome>/memory/claims/            derived facts/decisions
```

Requirements:

- Append-only JSONL ledger.
- Stable ids and checksums.
- Replayable index rebuild.
- Owner-only permissions.
- Memory files outside model-visible workspaces.
- Scope ids in filenames should be HMAC-obfuscated.
- CLI/native tools must not be allowed to read raw memory files, auth files,
  session files, memory temp files, or raw logs.

Embeddings can be added later, but only after access filtering:

```text
resolve allowed scopes
  -> lexical/rubric candidates
  -> optional embeddings inside allowed scopes only
```

### Index And Retrieval Architecture

Indexes are projections over the append-only event log. They may be deleted and
rebuilt without losing memory.

```text
events.jsonl
  ├─ sqlite tables
  │   ├─ events
  │   ├─ claims
  │   ├─ relationships
  │   ├─ artifacts
  │   └─ audit
  │
  ├─ lexical index
  │   └─ SQLite FTS/BM25 over allowed text fields
  │
  ├─ optional vector index
  │   └─ embeddings for non-sealed, access-filterable snippets
  │
  ├─ optional temporal graph
  │   └─ entities, relations, valid_from, valid_to, observed_at
  │
  └─ derived narratives
      └─ scoped summaries with source event ids
```

The read path must always filter before ranking:

```text
request
  -> authenticate tool envelope
  -> resolve principal and active scope aliases
  -> compute allowed scope set
  -> lexical candidates
  -> optional vector candidates inside allowed set
  -> optional graph/temporal expansion inside allowed set
  -> merge, deduplicate, and rerank
  -> apply least-revealing access decision
  -> return cited results and audit event
```

Default implementation:

- Lexical FTS/BM25 is enabled.
- Vector retrieval is disabled until an embedding model is explicitly configured.
- Graph retrieval is disabled until an entity/relation extractor is configured.
- Reranking may begin as deterministic scoring before any LLM reranker exists.

### Consolidation And Conflict Handling

The kernel needs a management path separate from live recall. Consolidation may
be scheduled, threshold-triggered, or operator-triggered.

```text
consolidation job
  -> scan recent raw events and explicit registers
  -> cluster by scope, entity, artifact, and relationship
  -> produce candidate episodic/semantic/procedural/relationship records
  -> link all source events
  -> mark superseded claims instead of overwriting them
  -> refresh scoped narratives
  -> emit audit records and metrics
```

Rules:

- Contradictions are represented as competing claims until a later event
  supersedes one with evidence.
- Updates append `supersedes` links; they do not mutate old events in place.
- Summaries are disposable and must be regenerable from the ledger.
- Forgetting appends tombstones/redactions, then indexes filter or rebuild.
- Retention can decay or expire memories, but sealed/deleted content must fail
  closed even if an old index exists.

## Event Shape

```ts
interface MemoryEvent {
  id: string;
  type:
    | "memory.observed"
    | "memory.registered"
    | "memory.claimed"
    | "memory.reacted"
    | "memory.decided"
    | "memory.summarized"
    | "memory.located"
    | "memory.recalled"
    | "memory.forgotten"
    | "memory.denied";
  record_type:
    | "raw_event"
    | "episodic"
    | "semantic"
    | "procedural"
    | "relationship"
    | "artifact"
    | "narrative"
    | "tombstone";
  created_at: string;
  observed_at?: string;
  principal: MemoryPrincipalRef;
  scope: MemoryScopeRef;
  visibility: "private" | "pair" | "team" | "room" | "global" | "public" | "sealed";
  sensitivity: "normal" | "sensitive" | "secret" | "sealed";
  source: MemorySourceRef;
  content: MemoryContent;
  tags: string[];
  entities: MemoryEntityRef[];
  confidence?: number;
  salience?: number;
  access_count?: number;
  last_accessed_at?: string;
  evidence_event_ids: string[];
  parent_event_ids: string[];
  supersedes_event_ids?: string[];
  valid_from?: string;
  valid_to?: string;
  retention_policy?: string;
  acl_policy?: string;
  ttl?: string;
  checksum: string;
}
```

The current Mneme TypeScript implementation uses camelCase field names and a
smaller content union while the design is incubating. MCP exposes the same
transport schema; in-process TypeScript may map to idiomatic local names.

## Tool Envelope

Every transport normalizes to one schema.

```ts
interface MemoryToolCallEnvelope {
  version: "mneme.memory.tool.v1";
  wake_id: string;
  thread_id: string;
  principal: MemoryPrincipalRef;
  conversation_scope: string;
  audience_key: string;
  policy_version: string;
  allowed_scope_aliases: Array<
    "current" | "global" | "public_profile" | "public_facts" |
    "current_room" | "current_pair" | "current_task"
  >;
  transport: "in_process" | "mcp" | "protocol" | "text_loop";
  nonce: string;
  expires_at: string;
  capability: string;
}
```

Tool capabilities are minted by the runtime, not by the model. The envelope is
mandatory for MCP, protocol, and text-loop transports; in-process calls may carry
the same data as an object rather than serialized JSON. Runtime adapters must
bind nonce, expiry, principal, wake id, and allowed scope aliases before the
engine sees the tool.

```ts
interface MemoryToolCall {
  request_id: string;
  tool:
    | "memory.search"
    | "memory.locate"
    | "memory.register"
    | "memory.write"
    | "memory.summarize"
    | "memory.forget";
  arguments: Record<string, unknown>;
  envelope: MemoryToolCallEnvelope;
}

interface MemoryToolResult {
  request_id: string;
  tool: string;
  decision:
    | "allow_raw"
    | "allow_summary"
    | "allow_redacted_summary"
    | "known_but_private"
    | "locate_only"
    | "deny"
    | "unavailable"
    | "malformed_request";
  content: Array<{
    kind: "memory" | "claim" | "narrative" | "relationship" | "artifact" | "locate";
    text?: string;
    event_ids: string[];
    scope?: MemoryScopeRef;
    principal?: MemoryPrincipalRef;
    confidence?: number;
    redactions: string[];
  }>;
  audit: {
    request_id: string;
    requester: MemoryPrincipalRef;
    sources: MemoryPrincipalRef[];
    transport: "in_process" | "mcp" | "protocol" | "text_loop";
    latency_ms: number;
    argument_hash?: string;
  };
  error?: string;
}
```

Denied, unavailable, and malformed results must have empty `content`.

## Principal And Scope Model

```ts
interface MemoryPrincipalRef {
  agent_id: string;
  selflet:
    | "global"
    | "team"
    | "room"
    | "pair"
    | "task"
    | "role"
    | "artifact";
  qualifier?: string;
}
```

Examples:

```json
{ "agent_id": "luna-representative", "selflet": "room", "qualifier": "public_net:agora" }
{ "agent_id": "luna-shadow", "selflet": "room", "qualifier": "luna_self:council" }
{ "agent_id": "luna-persona", "selflet": "pair", "qualifier": "luna-persona:luna-representative" }
```

Default recall for a wake should include:

```text
public profile/facts
active room
active team
active task
active pair only for private pair contexts
global_private only when access policy allows it
```

Default recall must not include:

```text
other private pair scopes
other team scopes
other room scopes
raw memory from another agent principal
sealed memory existence
```

## Spawnfile Configuration Direction

This is not current schema. It is the direction once Daimon behavior is stable.

```yaml
memory:
  - id: luna-self
    store:
      kind: sqlite
      path: /var/lib/spawnfile/memory/luna-self.sqlite
    index:
      lexical:
        enabled: true
        engine: sqlite_fts
      vector:
        enabled: false
      graph:
        enabled: false
    write:
      mode: tool
    consolidation:
      mode: on_threshold
      summarize_after_events: 100
    retention:
      forgetting: manual
    access:
      members: [representative, persona, shadow, judge]
```

Agent-side attachment could become:

```yaml
memory:
  - id: private
    store:
      kind: sqlite
    index:
      lexical:
        enabled: true
```

Until this exists in Spawnfile, Daimon-local defaults own the memory config.

The top-level bank is not tied to Daimon. Daimon may use it through in-process
tools, while OpenClaw and PicoClaw should receive a compiler-generated private
MCP server for the same bank. The store is a capability of the compiled
organization, not a Moltnet network and not a runtime-specific workspace file.

## Agentic Self Organization Flow

```text
public room: agora
  @luna what should we do?
        │
        ▼
luna-representative wakes
        │
        ├─ memory.search(current_room, "recent context")
        ├─ memory.locate("does any inner self remember a related concern?")
        │
        ├─ posts to internal room luna-council:
        │    @luna-persona @luna-shadow @luna-judge
        │    External message arrived. How does this land?
        │
        ├─ inner agents reply through Moltnet
        │    persona searches persona memory
        │    shadow searches shadow memory
        │    judge recalls rules and advises
        │
        └─ representative synthesizes public reply
```

The self organization is a normal nested Spawnfile team. No `composite` schema is
required.

## Testing Strategy

### Pure Memory Tests

No model calls.

```text
append/replay JSONL
index rebuild
lexical retrieval
optional vector retrieval behind an explicit fixture
optional graph traversal behind an explicit fixture
hybrid merge/rerank determinism
scope resolution
access decisions
memory.search
memory.locate
memory.register
memory.summarize
memory.forget
supersede/conflict handling
retention and tombstone filtering
redaction/tombstone behavior
forbidden strings absent from denied/located results
```

### Harness Tests

Use fake engine sessions.

```text
prepareWake creates correct principal and scope aliases
prompt receives orientation and tool contract only
fake engine calls memory.search and gets allowed result
fake engine calls memory.locate and gets opaque candidate handles
fake engine calls memory.register and writes event with evidence
forbidden private content is absent from prompts, tool results, and activity
turn failures still record attempted memory operations
queueing preserves memory order
```

### Transport Tests

```text
in-process, MCP, protocol, and text-loop normalize to same MemoryToolCall
MCP schema exactly matches tool registry
fake MCP client exercises search/locate/register/summarize/forget
model-supplied agent_id is ignored or rejected
expired/replayed capabilities fail closed
concurrent MCP clients cannot read each other's memories
text-loop parser rejects marker injection and mixed final/tool frames
```

### Moltnet Org E2E

Use local Moltnet on an isolated port.

```text
two nested self organizations join public room by representative only
public question wakes representative
representative posts to internal council room
inner agents use their own memory tools
representative replies publicly
private seeded detail never appears in public room
temporary query room can locate and ask relevant inner agents
activity stream shows memory.search, memory.locate, memory.register events
```

### Long-Horizon Memory E2E

Use deterministic scripted histories plus opt-in live model runs.

```text
seed 1000+ events across rooms, pairs, artifacts, and time windows
ask single-hop recall questions
ask multi-hop relationship questions
ask temporal questions where the answer changed over time
ask abstention questions where no allowed evidence exists
ask private-leak questions from a public context
run consolidation and verify narratives cite source event ids
forget/redact an event and verify all indexes stop returning it
restart runtime and rebuild index from the append-only ledger
```

### Live Behavioral E2E

Run at least two self organizations that share a public room but have different
private memories.

```text
org A receives private fact from org B in a pair context
org A later receives a related public-room question
org A can locate that a private memory exists
org A asks its internal agents through Moltnet for interpretation
org A answers publicly without leaking the private fact
org B can recall the shared pair fact when asked in the pair context
an unrelated third org cannot locate or infer the private fact
```

### Live Daimon Pi E2E

Use cheap model settings.

```text
agent registers memory in one turn
second turn recalls it through memory.search
locate returns candidate handle for inner self
inner self responds through Moltnet, not function call
representative synthesizes response
forbidden strings remain absent from public output
```

## Metrics

Minimize:

```text
leak_rate
cross_contamination_rate
false_locate_rate
wrong_abstention_rate
recall_latency_ms
prompt_memory_tokens
stale_memory_rate
hallucinated_memory_rate
write_amplification
index_rebuild_time_ms
consolidation_drift_rate
```

Maximize:

```text
authorized_recall_rate
precision_at_k
recall_at_k
mean_reciprocal_rank
temporal_recall_accuracy
multi_hop_recall_accuracy
decision_recall_rate
artifact_recall_rate
locate_success_rate
write_precision
audit_completeness
regeneration_fidelity
```

Initial acceptance:

```text
leak_rate = 0
audit_completeness = 100%
regeneration_fidelity = 100%
forbidden private strings absent from public prompts/results/activity
authorized_recall_rate >= 90% on scripted deterministic scenarios
private leak and sealed-existence tests pass on every transport
index rebuild produces byte-stable query results for deterministic fixtures
```

## Observability

Safe memory activity events:

```text
memory.orientation.built
memory.search.started
memory.search.completed
memory.locate.started
memory.locate.completed
memory.register.completed
memory.summarize.completed
memory.forget.completed
memory.denied
memory.index.rebuilt
```

Activity may include:

```text
principal
scope class
decision
event id hashes
counts
latency
token budget used
transport
tool name
```

Activity must not include:

```text
raw private memory
secrets
raw orientations/tool results unless debug mode explicitly enables safe redaction
raw stdout/stderr
sealed memory existence
```

## Implementation Phases

### Phase 1: Deterministic Kernel

- Types, ids, checksums.
- JSONL event store.
- SQLite index.
- Scope resolver.
- Access policy.
- Search/locate/register/summarize/forget tools.
- Pure unit tests.

### Phase 2: Daimon Integration

- Prepare wake orientation.
- In-process memory tools.
- Record turn observations and register calls.
- Fake harness tests.

### Phase 3: Portable Transports

- MCP server.
- Text-loop bridge.
- Protocol bridge shape.
- Transport parity tests.

### Phase 4: Narratives And Claims

- Derived claims.
- Scoped narratives.
- Regeneration tests.

### Phase 5: Agentic Moltnet E2E

- Self organization template.
- Internal council room.
- Temporary query room.
- Two self orgs in public room.
- Live/opt-in model tests.

### Phase 6: Spawnfile Schema

- Add memory bank declarations after Daimon behavior is stable.
- Lower memory config into generated Daimon app config.
- Lower memory config into generated app config and Mneme MCP config.

## Extraction Path

`@noopolis/mneme` contains:

```text
types and schemas
event store
indexing
scope/principal model
access policy
search/locate/register/summarize/forget tools
transport adapters
test fixtures
metrics helpers
```

It should not contain:

```text
Moltnet room orchestration
Jungian council behavior
representative synthesis
persona/shadow/judge prompting
runtime engine session management
provider auth
Spawnfile compilation
```

That boundary keeps memory reusable by Daimon, OpenClaw, PicoClaw, and future
runtimes without turning it into a hidden agentic organization.
