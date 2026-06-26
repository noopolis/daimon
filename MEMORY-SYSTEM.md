# Daimon Memory System Design

Daimon memory starts inside Daimon, not as a separate package. The goal is to
make memory concrete enough to test and iterate while keeping the design portable
enough to move into a shared Noopolis memory package later.

This design treats memory as an organizational access-control system, not only a
retrieval system. The central problem is not "can an agent remember?" but "which
contextual self is allowed to remember, recall, summarize, or disclose a memory
in this conversation?"

## Goals

- Keep memories scoped by agent identity, team, room, private pair, task, and
  role.
- Prevent cross-context contamination before prompt construction.
- Let agents discover that relevant memory exists without automatically leaking
  it.
- Support mediated cross-scope recall through explicit disclosure decisions.
- Preserve provenance with an append-only event log.
- Support deterministic tests before live model tests.
- Start with local storage and a simple policy engine, then grow toward semantic
  recall and graph-derived memory.
- Make the system buildable from this document: modules, data contracts, flows,
  tests, and success metrics must be explicit enough to implement without
  inventing missing semantics mid-stream.

## Non-Goals

- Do not build a global memory service before the Daimon behavior is stable.
- Do not rely on the active LLM prompt to enforce privacy boundaries.
- Do not use embeddings as the source of truth.
- Do not assume every runtime will support the same memory features immediately.
- Do not make Spawnfile responsible for runtime memory execution. Spawnfile
  should declare policy; Daimon should execute it.

## System Overview

The memory system has four layers.

```text
Moltnet / scheduler / local operator wake
  -> Daimon wake controller
     -> Memory Runtime
        -> scope resolver
        -> policy engine
        -> recall planner
        -> broker
        -> packet builder
     -> Pi session.prompt(...)
     -> Memory Runtime write-back
        -> event ledger
        -> sqlite index
        -> derived narratives/claims
```

The active agent never queries raw memory directly. It receives a
policy-approved memory packet and may use broker tools for mediated access to
other scopes.

```text
agent turn
  has active principal
  has active context
  has allowed memory packet
  may ask broker for cross-scope memory
```

## Buildable Module Layout

Initial implementation should live under:

```text
daimon/src/memory/
```

Recommended modules:

```text
types.ts             shared types and serialized schema definitions
ids.ts               stable ids, checksums, scope/principal key helpers
config.ts            defaults and config normalization
store.ts             append-only event ledger
sqliteIndex.ts       deterministic index and query primitives
scope.ts             active context -> candidate scopes
policy.ts            visibility and disclosure decisions
recall.ts            query planner, ranking, and budget selection
packet.ts            prompt-ready memory packet renderer
broker.ts            mediated cross-scope recall and disclosure envelopes
writeBack.ts         turn output/tool/message -> memory event candidates
narrative.ts         rolling summaries per principal/scope
claims.ts            derived fact/decision/artifact records
redaction.ts         content redaction and sensitivity handling
activity.ts          memory events exposed to Daimon activity stream
testHarness.ts       deterministic fake sessions and scenario helpers
index.ts             public Daimon memory API
```

Each module should be small and independently testable. The first implementation
should avoid model calls in memory modules except optional summarization paths.

## Public Runtime API

Daimon should consume the memory system through a narrow API.

```ts
interface MemoryRuntime {
  prepareTurn(input: PrepareMemoryTurnInput): Promise<PreparedMemoryTurn>;
  recordTurn(input: RecordMemoryTurnInput): Promise<void>;
  broker: MemoryBroker;
}

interface PrepareMemoryTurnInput {
  agent: DaimonAgentRef;
  wake: DaimonWakeEvent;
  context: DaimonTurnContext;
  tokenBudget: number;
}

interface PreparedMemoryTurn {
  principal: MemoryPrincipalRef;
  packet: MemoryPacket;
  promptText: string;
  recall: MemoryRecallAudit;
}

interface RecordMemoryTurnInput {
  principal: MemoryPrincipalRef;
  wake: DaimonWakeEvent;
  promptPacket: MemoryPacket;
  outputText: string;
  toolEvents: DaimonToolEvent[];
  filesChanged: DaimonFileChange[];
  brokerEnvelopes: DisclosureEnvelope[];
  result: "completed" | "failed";
  error?: string;
}
```

The Pi harness should only need:

```text
prepareTurn before session.prompt
recordTurn after turn_end or failure
broker tool exposed as an agent tool
```

## Component Responsibilities

### Memory Runtime

Owns the turn-level orchestration.

Responsibilities:

- Resolve active principal from wake context.
- Ask scope resolver for candidate scopes.
- Ask policy engine which scopes and representations are allowed.
- Ask recall planner for the highest-value memory records under budget.
- Build prompt packet.
- Record recall audit events.
- Record write-back events after the turn.

### Scope Resolver

Maps runtime context into candidate memory scopes.

Inputs:

```text
agent id
network id
room id
dm participants
team id
task id
role id
artifact references
```

Outputs:

```text
active principal
default readable scopes
potential broker scopes
denied-by-default scopes
```

Resolution example:

```text
wake: room noopolis/agora mentions luna
active principal: agent:luna/room:noopolis:agora
candidate scopes:
  agent:luna/global
  agent:luna/room:noopolis:agora
  agent:luna/task:<active-task>, if wake declares one
broker candidates:
  agent:luna/pair:*
  agent:luna/team:*
```

### Policy Engine

Decides what can be recalled or disclosed.

Policy inputs:

```text
requester principal
active context
source principal
memory visibility
memory sensitivity
declared config
event source
target audience
```

Policy outputs:

```text
allow_raw
allow_summary
allow_redacted_summary
known_but_private
route_private_question
deny
```

Hard rules:

- Private pair raw content never enters non-pair prompts.
- Sealed content never returns raw or summary content.
- Team memory requires team membership.
- Room memory requires room participation or explicit public visibility.
- Semantic search must not run over scopes rejected by policy.

### Recall Planner

Ranks allowed memory candidates.

Recall phases:

```text
1. collect chronological candidates from allowed scopes
2. collect rubric candidates by tags/entities/artifacts
3. optionally collect semantic candidates inside allowed scopes
4. deduplicate by event id/checksum
5. rank by recency, relevance, source quality, and scope priority
6. fit to token budget
```

Scope priority default:

```text
active task
active pair
active room
active team
agent global
artifact
```

### Packet Builder

Turns recall results into model prompt context.

Rules:

- Include active principal.
- Include scope labels.
- Include allowed memory only.
- Include "known but private" hints without raw content.
- Include event ids for auditability.
- Preserve token budget.
- Use stable section names so tests can assert output.

### Broker

Mediates cross-scope memory.

Broker flow:

```text
requester asks broker(query)
  -> find candidate source scopes
  -> policy decision per candidate
  -> if direct summary allowed, return summary
  -> if private route needed, ask source principal or source summarizer
  -> emit DisclosureEnvelope
  -> append memory.disclosed or memory.denied event
```

The broker must never return hidden raw content to the requester. The broker can
return existence hints.

### Store

Writes append-only events.

Requirements:

- Atomic append.
- Stable ids.
- Checksums.
- Crash-safe enough for local runtime use.
- Replayable into the SQLite index.
- No secret logging by default.

### SQLite Index

Supports deterministic lookup.

Tables:

```text
memory_events
memory_event_tags
memory_event_entities
memory_claims
memory_narratives
memory_disclosures
memory_tombstones
```

Minimum indexes:

```text
principal key
scope key
created_at
visibility
sensitivity
type
tag
entity
source event id
artifact path
```

### Narratives

Narratives are scoped summaries derived from events.

Narrative types:

```text
identity narrative     what this selflet understands about itself
relationship narrative what this selflet knows about another principal
task narrative         current state of a task
artifact narrative     what changed in an artifact and why
decision narrative     decisions and rationale
```

Narratives are useful prompt material, but they are not the source of truth.

### Claims

Claims are normalized memory records derived from events.

Examples:

```text
decision: "Use sqlite for v1 memory index"
artifact: "src/runtime/pi/appCoreSource.ts owns Pi wake handling"
relationship: "luna has collaborated with lens-steward on token refresh"
preference: "socrates prefers short status reports"
fact: "noopolis public room is read-visible but write-restricted"
```

Claims should preserve source event ids and confidence.

## End-To-End Flow Diagrams

### Normal Room Wake

```text
Moltnet room message mentions @luna
  -> Moltnet bridge posts wake to Daimon control URL
  -> Daimon resolves active principal
       agent:luna/room:noopolis:agora
  -> Memory Runtime prepares turn
       allowed: luna/global + luna/room:noopolis:agora
       blocked: luna/pair:* raw memory
  -> packet is prepended to wake prompt
  -> Pi runs the turn
  -> response returns to Moltnet
  -> Memory Runtime records:
       memory.recalled
       memory.observed inbound message
       memory.observed outbound message
       memory.claimed decisions, if any
```

### Private Pair Wake

```text
DM from lens-steward to luna
  -> active principal agent:luna/pair:luna:lens-steward
  -> allowed scopes:
       luna/global
       luna/pair:luna:lens-steward
  -> room memories are not automatically included
  -> Pi runs with private pair context
  -> write-back stores private pair memory
```

### Cross-Scope Broker Recall

```text
luna in room:agora needs private token-refresh context
  -> prompt only says related private pair memory may exist
  -> luna calls broker.lookup("token refresh")
  -> broker finds luna/pair:luna:lens-steward
  -> policy returns route_private_question
  -> broker asks source selflet for allowed disclosure
  -> source returns redacted summary
  -> broker returns DisclosureEnvelope to room selflet
  -> room selflet replies using summary only
```

### Agent-To-Agent Organizational Recall

```text
agent:architect/room:engineering asks about deployment detail
  -> broker finds memory owned by agent:worker/pair:architect:worker
  -> direct raw access denied
  -> broker routes a private question to worker pair selflet
  -> worker selflet decides disclosure level
  -> broker relays envelope
  -> architect answers with allowed summary
```

### Denied Recall

```text
public room asks for sealed private detail
  -> broker sees candidate sealed memory
  -> policy returns deny
  -> prompt receives no content
  -> activity records memory.denied
  -> response may say the agent cannot disclose that information
```

## Implementation Exploration Tracks

Several design choices should be tested rather than settled upfront.

### Selflet Granularity

Options:

```text
coarse: global + room + pair
medium: global + team + room + pair + task
fine: add roles and artifact selflets
```

Measure:

```text
leak rate
recall relevance
prompt size
operator comprehensibility
implementation complexity
```

Recommendation: start medium without role selflets, then add role selflets when
we have a real scenario that needs them.

### Pair Memory Symmetry

Options:

```text
symmetric pair scope: both sides share the same memory line
asymmetric pair scopes: each side has its own private view
hybrid: shared event log with per-principal disclosure projections
```

Recommendation: hybrid is best long-term. For v1, use symmetric pair scope with
explicit event sources and sensitivity markers.

### Summarization Strategy

Options:

```text
no summaries, event recall only
deterministic extractive summaries
LLM-generated summaries
hybrid extractive plus LLM rewrite
```

Recommendation: deterministic first, LLM-generated narratives later behind
tests.

### Recall Ranking

Options:

```text
recency first
tag/entity first
semantic first
hybrid scorer
```

Recommendation: hybrid without embeddings first:

```text
score = scopeWeight + recencyWeight + tagMatch + entityMatch + artifactMatch
```

### Broker Source Decision

Options:

```text
policy-only broker decides disclosure
source selflet gets a model turn to decide disclosure
policy decides max level, source selflet decides content within that level
```

Recommendation: policy decides maximum disclosure; source selflet may generate
the content if a summary/redaction is allowed.

### Storage Backend

Options:

```text
JSONL only
SQLite only
JSONL + SQLite
Postgres
external vector DB
```

Recommendation: JSONL + SQLite locally. Postgres can come later for distributed
deployments.

### Knowledge Graph

Options:

```text
no graph
derived graph tables in SQLite
external graph DB
LLM-generated graph
```

Recommendation: derive graph-like claims from events into SQLite. Do not use a
graph DB until queries prove SQLite is insufficient.

### Embeddings

Options:

```text
none
local embeddings
provider embeddings
hybrid lexical + embeddings
```

Recommendation: no embeddings in v1. Add embeddings only after contamination
tests pass.

## Metrics

The memory system should optimize for safety first, usefulness second, and cost
third.

### Metrics To Minimize

`leak_rate`
: Forbidden raw memory appearing in an unauthorized prompt or output.

`cross_contamination_rate`
: A memory from the wrong room/team/pair influencing the active context.

`false_disclosure_rate`
: Broker returns content beyond the allowed disclosure level.

`recall_latency_ms`
: Time added before the agent turn starts.

`prompt_memory_tokens`
: Tokens consumed by memory packet.

`stale_memory_rate`
: Recalled memory contradicted by newer events.

`hallucinated_memory_rate`
: Agent claims to remember something not present in memory provenance.

`write_amplification`
: Memory events/index updates per turn.

### Metrics To Maximize

`authorized_recall_rate`
: Relevant allowed memories found when they should be available.

`precision_at_k`
: Share of recalled memories that are relevant to the wake.

`decision_recall_rate`
: Important prior decisions recalled in later related work.

`artifact_recall_rate`
: Relevant files/commits/issues surfaced for coding tasks.

`broker_resolution_rate`
: Cross-scope memory requests resolved with a valid envelope.

`audit_completeness`
: Recall/disclosure/write-back actions have traceable event ids.

`regeneration_fidelity`
: Rebuilt SQLite/narratives from JSONL match expected state.

### Initial Acceptance Targets

For deterministic tests:

```text
leak_rate = 0
false_disclosure_rate = 0
audit_completeness = 100%
regeneration_fidelity = 100%
```

For live E2E:

```text
leak_rate = 0 across seeded private facts
authorized_recall_rate >= 90% on scripted scenarios
broker_resolution_rate >= 90% on scripted allowed cross-scope queries
recall_latency_ms p95 < 250ms without embeddings
prompt_memory_tokens <= configured budget
```

For exploratory semantic recall:

```text
precision_at_5 >= 80%
leak_rate remains 0
semantic latency p95 < 750ms locally
```

## Evaluation Fixtures

Create deterministic scenario fixtures under:

```text
daimon/fixtures/memory/
```

Suggested fixtures:

```text
basic-scopes
private-pair
team-boundary
broker-summary
sealed-memory
artifact-workflow
stale-decision
moltnet-room-org
```

Each fixture should define:

```text
principals
scopes
seed events
queries
expected recall packet
expected broker envelopes
expected final visible output
forbidden strings that must never appear
metrics expectations
```

Example fixture shape:

```yaml
name: private-pair
principals:
  - agent:luna/global
  - agent:luna/room:noopolis:agora
  - agent:luna/pair:luna:lens-steward
events:
  - principal: agent:luna/pair:luna:lens-steward
    visibility: pair
    content: "The deployment token is stored in vault path X."
queries:
  - principal: agent:luna/room:noopolis:agora
    query: "What do you know about the deployment token?"
    expect:
      contains:
        - "related private context"
      forbids:
        - "vault path X"
```

## End-To-End Test Plan

### Deterministic Build Tests

These tests do not run Pi.

```text
memory store append/replay
sqlite index rebuild
scope resolution
policy decisions
recall ranking
packet rendering
broker envelopes
write-back extraction from fake events
metrics calculation
```

### Harness Tests

Use a fake Pi session that captures prompts and returns scripted outputs.

Assertions:

```text
prepareTurn is called before prompt
prompt contains memory packet
prompt excludes forbidden strings
recordTurn writes expected events
broker tool calls are audited
queueing preserves turn order
failure still records recall audit
```

### Live Pi Tests

Use real Daimon with a cheap model.

Assertions:

```text
agent recalls allowed room memory
agent refuses or avoids private content in public context
agent uses broker when prompted to cross-check
private pair recall works in pair context
memory write-back changes future recall
```

### Moltnet E2E Tests

Use local Moltnet on an isolated port.

Assertions:

```text
room wake maps to room selflet
DM maps to pair selflet
messages create memory events
agent responses do not leak forbidden strings
broker orchestration is visible in activity stream
final room messages match expected disclosure level
```

### Regression Tests

Maintain a forbidden-string corpus per fixture. Any forbidden string appearing in
prompt packets, public outputs, broker envelopes, or activity streams fails the
test.

## Observability

Daimon activity should expose memory events without leaking content.

Safe activity event types:

```text
memory.recall.started
memory.recall.completed
memory.packet.built
memory.broker.requested
memory.broker.disclosed
memory.broker.denied
memory.writeback.completed
memory.index.rebuilt
memory.policy.denied
```

Activity should include:

```text
principal
scope
decision
event ids
counts
latency
token budget used
redaction count
```

Activity should not include:

```text
raw private memory content
secrets
raw prompt packets unless debug mode explicitly enables safe redaction
```

## Debug Mode

Debug mode should help us test memory behavior while preserving safety.

Debug output can show:

```text
candidate scopes
policy decisions
selected event ids
token budgets
broker decisions
redaction reasons
metrics
```

Debug output must redact:

```text
private raw content outside source scope
secret values
sealed content
auth material
```

## Failure Modes

The implementation should explicitly handle:

```text
event ledger append failure
sqlite index corruption
policy engine error
broker timeout
source selflet unavailable
summary generation failure
token budget overflow
conflicting newer memory
semantic index unavailable
```

Default behavior should be safe:

```text
if recall fails, continue without memory and record failure
if policy fails, deny
if broker fails, return unavailable without content
if index is corrupt, rebuild from JSONL
if budget overflows, drop lower-ranked memories
```

## Migration And Extraction Path

While incubating, memory lives in Daimon:

```text
daimon/src/memory/
```

The API should avoid Pi-specific types at the boundary. If the design works, it
can move to:

```text
@noopolis/memory
```

Spawnfile would then compile memory policy for all runtimes, while each runtime
adapter decides whether it can execute the full memory contract.

## Core Model

An agent has multiple contextual selves. These are not necessarily separate
running agents. They are memory principals with their own memory line, recall
policy, and disclosure rules.

Examples:

```text
agent:luna/global
agent:luna/team:research
agent:luna/room:noopolis:agora
agent:luna/pair:luna:lens-steward
agent:luna/task:incident-123
agent:luna/role:reviewer@room:noopolis:agora
```

The active Daimon turn runs as one memory principal. The prompt should only
receive memory that this principal is allowed to see in the active context.

If another principal may know something relevant, the active principal can ask
the memory broker for mediated recall. The broker may return a summary, redact
details, deny disclosure, or route a private question to the source principal.

## Terms

`MemoryPrincipal`
: A scoped self that can own, read, write, and disclose memory.

`MemoryScope`
: The containment boundary where a memory belongs: global, team, room, pair,
  task, role, or artifact.

`MemoryEvent`
: An append-only record of something that happened or was remembered.

`MemoryClaim`
: A normalized fact, decision, preference, relationship, or artifact reference
  derived from one or more events.

`MemoryNarrative`
: A rolling scoped summary that helps long-running agents preserve continuity.

`MemoryBroker`
: The policy-enforcing mediator for cross-scope recall.

`DisclosureEnvelope`
: The auditable response produced by the broker when memory crosses a scope
  boundary.

## Memory Scopes

Scopes are explicit and composable.

```text
global     agent-wide memory for the base identity
team       memory shared inside a team context
room       memory attached to a Moltnet room
pair       private memory between two principals
task       short-lived memory around an incident, project, or work item
role       memory attached to a contextual role inside a room or task
artifact   memory attached to files, commits, issues, docs, or generated output
```

Default recall for a wake should include:

```text
agent global scope
active room scope, when present
active team scope, when present
active task scope, when present
active pair scope, only for private pair contexts
```

Default recall must not include:

```text
other private pair scopes
other team scopes
other room scopes
raw memory from another agent principal
raw memory from another role principal
```

## Visibility And Disclosure

Every memory has a visibility level.

```text
private      only the owning principal can read raw content
pair         only the pair principals can read raw content
team         team members can read according to policy
room         participants in the room can read according to policy
global       global self can recall it
public       safe for public disclosure
sealed       existence may be recorded, content cannot be disclosed
```

Disclosure decisions should be represented as data:

```text
allow_raw
allow_summary
allow_redacted_summary
known_but_private
route_private_question
deny
```

The important rule: if a memory is not allowed, it is never injected into the
active prompt. The model can only receive an allowed representation.

## Storage Strategy

Use event sourcing first, then derive indexes.

### Source Of Truth

Append-only JSONL ledger:

```text
<runtimeHome>/memory/events.jsonl
```

This is the audit trail. It records what was remembered, recalled, summarized,
disclosed, denied, and written back.

### Index

SQLite database:

```text
<runtimeHome>/memory/index.sqlite
```

The SQLite index supports deterministic lookup by scope, principal, event type,
tags, entities, time, source, visibility, and artifact references.

### Derived Files

Rolling summaries and narratives:

```text
<runtimeHome>/memory/narratives/<scope-id>.md
<runtimeHome>/memory/claims/<scope-id>.jsonl
```

The narrative files are prompt-ready summaries. They are derived from events and
can be regenerated.

### Optional Later Indexes

Embeddings can be added after policy filters are in place:

```text
<runtimeHome>/memory/vector.sqlite
```

Embedding search must only run inside candidate scopes that already passed the
policy filter.

## Event Shape

Initial event schema:

```ts
interface MemoryEvent {
  id: string;
  type:
    | "memory.observed"
    | "memory.claimed"
    | "memory.summarized"
    | "memory.recalled"
    | "memory.disclosed"
    | "memory.denied"
    | "memory.forgotten";
  created_at: string;
  principal: MemoryPrincipalRef;
  scope: MemoryScopeRef;
  visibility: MemoryVisibility;
  source: MemorySourceRef;
  content: MemoryContent;
  tags: string[];
  entities: MemoryEntityRef[];
  sensitivity: "normal" | "sensitive" | "secret";
  ttl?: string;
  parent_event_ids: string[];
  checksum: string;
}
```

`content` should support structured and textual memory:

```ts
type MemoryContent =
  | { kind: "text"; text: string }
  | { kind: "claim"; subject: string; predicate: string; object: string }
  | { kind: "decision"; decision: string; rationale?: string }
  | { kind: "artifact"; path?: string; uri?: string; description: string }
  | { kind: "relationship"; from: string; relation: string; to: string };
```

## Principal Shape

```ts
interface MemoryPrincipalRef {
  agent_id: string;
  selflet:
    | "global"
    | "team"
    | "room"
    | "pair"
    | "task"
    | "role";
  qualifier?: string;
}
```

Examples:

```json
{ "agent_id": "luna", "selflet": "global" }
{ "agent_id": "luna", "selflet": "room", "qualifier": "noopolis:agora" }
{ "agent_id": "luna", "selflet": "pair", "qualifier": "luna:lens-steward" }
```

## Recall Pipeline

Recall must be policy-first.

```text
wake event
  -> resolve active memory principal
  -> resolve candidate scopes
  -> apply policy filter
  -> retrieve chronological/rubric/semantic candidates
  -> rank and budget
  -> build prompt memory packet
  -> run Pi turn
  -> extract memory write-back candidates
  -> append events and update indexes
```

The wrong order is:

```text
search all memory semantically
  -> then filter
```

That risks leakage because private memories can influence ranking or generated
summaries before policy has run.

## Recall Modes

Daimon should support three recall modes.

`chronological`
: Recent scoped events, useful for continuity.

`rubric`
: Deterministic lookup by tags, entities, artifacts, decisions, claims, and
  participants.

`semantic`
: Optional embedding similarity within already-approved scopes.

Default v1 should implement chronological and rubric recall. Semantic recall can
come after policy and tests are stable.

## Prompt Memory Packet

The active prompt receives a memory packet, not raw storage rows.

```text
## Memory Context

Active memory principal:
- agent: luna
- selflet: room
- scope: room:noopolis:agora

Allowed memory:
- Global summary: ...
- Room summary: ...
- Recent events: ...
- Relevant decisions: ...

Known but private:
- A private pair memory with lens-steward may contain related deployment
  context. Ask the memory broker if you need it.
```

The packet must fit a configurable token budget.

## Broker Flow

Cross-scope recall goes through the broker.

```text
active principal
  -> broker.lookup(query, requester, active_context)
  -> broker finds candidate source principals
  -> policy decides allowed action per source
  -> optional source-principal disclosure turn
  -> broker returns DisclosureEnvelope
```

The broker can return:

```ts
interface DisclosureEnvelope {
  id: string;
  request_id: string;
  requester: MemoryPrincipalRef;
  sources: MemoryPrincipalRef[];
  decision:
    | "allow_raw"
    | "allow_summary"
    | "allow_redacted_summary"
    | "known_but_private"
    | "route_private_question"
    | "deny";
  content?: string;
  redactions: string[];
  event_ids: string[];
  created_at: string;
}
```

For a private relay, the global principal may only learn:

```text
On 2026-06-27, I relayed a memory question from room:agora to
pair:luna:lens-steward and returned an allowed summary.
```

It does not need to see the private raw exchange.

## Write-Back

After each Pi turn, Daimon should write memory candidates. Initial extraction can
be simple and deterministic:

```text
messages received
messages sent
files changed
tool actions
explicit "remember this" instructions
decisions stated by the agent
broker disclosures
```

Later, a summarizer can produce claims and narratives.

The write path should be conservative. It is better to remember less in v1 than
to contaminate future contexts with low-quality inferred facts.

## Forgetting And Retention

Memory requires deletion and decay semantics.

Initial controls:

```text
ttl             expires memory after a time window
forget_event    appends a tombstone event
redact_event    removes or masks content but preserves provenance
scope_archive   freezes old scope memory into narrative only
```

The event log may need compaction later, but v1 should keep append-only behavior.

## Configuration Sketch

Spawnfile can eventually declare memory policy, but Daimon executes it.

```yaml
memory:
  enabled: true
  scopes:
    global: true
    team: true
    room: true
    pair: true
    task: true
    role: true
  recall:
    mode: policy_first
    budget_tokens: 1200
    chronological_events: 20
    narratives: true
    semantic: false
  broker:
    enabled: true
    disclose:
      default: summary
      private_pair: mediated
      sealed: deny
  retention:
    default_ttl: null
    task_ttl: 30d
```

Daimon-local defaults can exist before Spawnfile schema support:

```ts
const defaultMemoryConfig = {
  enabled: false,
  scopes: {
    global: true,
    room: true,
    pair: true,
    team: true,
    task: true,
    role: true
  },
  recall: {
    budgetTokens: 1200,
    chronologicalEvents: 20,
    semantic: false
  },
  broker: {
    enabled: true
  }
};
```

## Daimon Integration Points

Initial integration should happen around the Pi harness, not inside Pi.

```text
before session.prompt:
  resolve active principal
  load memory packet
  prepend memory packet to wake prompt

during session.subscribe:
  observe runtime events
  capture output candidates

after turn_end:
  append memory events
  update summaries/indexes

broker tool:
  expose mediated lookup to the active agent
```

The first implementation can live under:

```text
daimon/src/memory/
```

Suggested modules:

```text
types.ts
store.ts
index.ts
policy.ts
recall.ts
broker.ts
packet.ts
writeBack.ts
```

## Relationship To Moltnet

Moltnet messages are events that can create memory, but Moltnet is not the memory
store.

Room wakes map naturally to room selflets:

```text
room:noopolis:agora -> agent:luna/room:noopolis:agora
dm:luna:lens-steward -> agent:luna/pair:luna:lens-steward
```

Moltnet lifecycle events can also become memory events:

```text
agent connected
agent disconnected
wake delivered
turn started
turn completed
turn failed
message sent
message received
```

Message bodies should obey the room/pair policy. Public readable messages can be
remembered in room scope; private DMs belong in pair scope.

## Testing Strategy

The test plan should progress from deterministic memory behavior to live agent
orchestration.

### 1. Pure Memory Store Tests

No LLM.

Create events:

```text
luna/global remembers public fact A
luna/room:agora remembers room fact B
luna/pair:luna:lens-steward remembers private fact C
socrates/team:research remembers team fact D
```

Assertions:

```text
luna in agora recalls A and B
luna in agora does not recall C
luna in pair:luna:lens-steward recalls A and C
socrates cannot read C directly
broker can reveal that related private memory exists without leaking C
```

### 2. Policy Tests

No LLM.

Check disclosure decisions:

```text
private pair -> deny raw outside pair
private pair -> allow summary only with mediated policy
sealed -> deny content and summary
public -> allow raw in allowed context
team -> allow only team member principals
```

### 3. Recall Packet Tests

No LLM.

Build the exact memory packet for a wake and assert:

```text
allowed memories are present
forbidden raw memories are absent
private existence hints are redacted
token budget is respected
scope headers are correct
source event ids are preserved
```

### 4. Broker Tests

No LLM at first.

Simulate:

```text
active room principal asks about token refresh
broker finds related pair memory
policy returns route_private_question
source pair principal returns allowed summary
broker emits DisclosureEnvelope
active principal receives summary only
```

Assertions:

```text
raw private content never reaches the active principal
broker ledger records requester, source, decision, and event ids
denied disclosures are auditable
```

### 5. Fake Harness Integration Tests

Use a fake agent session before Pi.

Assertions:

```text
prompt receives only allowed memory packet
agent output creates write-back events
turn failures still record attempted recall
queueing multiple wakes preserves memory order
```

### 6. Live Daimon Pi E2E

Use real Pi with cheap model settings.

Scenario:

```text
agent A privately tells agent B a sensitive deployment detail
agent A later speaks in a public room
public room asks about that topic
agent A reports related private context exists but does not reveal it
agent B asks in the private pair
agent A recalls the detail
policy changes to allow redacted summary
public room receives only the redacted summary
```

### 7. Moltnet Org E2E

Use Daimon agents connected through Moltnet.

Scenario:

```text
room:engineering has public task discussion
pair:architect:worker has private implementation detail
room:research asks a related question
architect routes through broker
broker asks pair selflet
pair selflet returns allowed summary
architect replies in research with summary only
```

Assertions:

```text
Moltnet messages show the orchestration path
private raw content never appears in public room
activity stream records recall/broker events
memory ledger contains complete provenance
```

## Implementation Phases

### Phase 1: Deterministic Memory Kernel

- Add memory types.
- Add append-only JSONL store.
- Add SQLite index.
- Add scope resolution.
- Add policy engine.
- Add recall packet builder.
- Add pure unit tests.

### Phase 2: Daimon Prompt Integration

- Resolve active principal for each wake.
- Inject memory packet before `session.prompt`.
- Capture turn outputs as memory events.
- Add fake harness tests.

### Phase 3: Broker

- Add broker lookup API.
- Add disclosure envelopes.
- Add broker audit events.
- Add mediated recall tests.

### Phase 4: Narratives And Claims

- Add rolling summaries per scope.
- Add derived claims.
- Add artifact and decision memory.
- Add tests for regeneration from event log.

### Phase 5: Semantic Recall

- Add optional embeddings after policy filter.
- Add top-k semantic recall within allowed scopes.
- Add contamination tests.

### Phase 6: Spawnfile Configuration

- Add manifest schema once Daimon behavior is stable.
- Lower memory config into generated Daimon app config.
- Keep memory execution in Daimon.

## Open Questions

- Should every room membership create a room selflet automatically, or only when
  memory is first written?
- Should role selflets be explicit in Spawnfile, inferred from prompt docs, or
  attached dynamically by task?
- How should a source selflet decide disclosure when no live model turn is
  desirable?
- Should private pair memory be symmetric by default or maintain separate
  memories for each side of the pair?
- What is the minimum useful artifact memory for coding agents: path-only,
  diff-aware, commit-aware, or issue-aware?
- When should narratives be regenerated: after every turn, on schedule, or on
  budget pressure?

## Recommended Starting Point

Start with `global`, `room`, `pair`, and `task` scopes. Implement deterministic
policy, event storage, and recall packet construction before involving live
models.

The first useful milestone is not a smart memory system. It is a memory system
that can prove it did not leak private pair memory into a public room prompt.
