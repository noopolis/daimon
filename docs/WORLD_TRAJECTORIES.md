# World trajectories

Two deliberately separate capture surfaces exist:

- `daimon.pi.raw_training_capture.v1` is an explicit opt-in private training
  artifact. Completeness, not redaction, is its contract.
- `daimon.world_trajectory.v1` is a minimized redacted trajectory for portable
  evaluation and public world-outcome joins.

## Private raw training capture

Raw capture must be enabled explicitly with a bounded turn-retention policy.
When disabled, Daimon does not create its directory. When enabled, every turn
is stored under `private-training/pi/raw/turns/` with `0700` directories and
`0600` files; it is outside ordinary telemetry and is never exported by
default.

The capture reuses Pi rather than building a parallel cognition recorder:

- `pi-session.jsonl` is copied byte-for-byte from Pi's native
  `SessionManager`.
- The exact effective provider request is captured at Pi AI's `onPayload`
  seam, after any earlier payload transform. This includes the complete
  system/developer/character context represented by the provider, messages,
  tool schemas, and request/sampling fields.
- Native Pi events retain model output, tool calls/results, exposed reasoning,
  streaming events, and timings without field selection or redaction.
- The effective model configuration and provider response metadata accompany
  the exchange.

This material may include prompts, private memory, credentials embedded by an
upstream payload transform, reasoning, and other sensitive content. That is
intentional for the private teacher dataset. The option is fail-closed: a
configured turn fails if its persisted Pi session cannot be copied. Each turn
is written to a private staging directory and renamed into view only after all
four files and permissions are complete; a failed publication is not retried
against the same immutable turn path. Retention deletes the oldest per-turn
capture after the configured maximum.

Stable run/tick/wake identifiers are recorded only as join metadata.
Authoritative post-action physics outcomes remain Simfile-owned and are joined
separately; the raw artifact never becomes simulation authority.

## Redacted world trajectory

For portable use, Daimon derives a separate export from the same
`tool_execution_start` and `tool_execution_end` events:

| Retained | Excluded |
| --- | --- |
| Model/provider/thinking identity | Raw prompt and instructions |
| Prompt and instruction SHA-256 | Hidden reasoning / chain of thought |
| Redacted world tool arguments/results | Decision tokens and credentials |
| Tool sequence and call latency | Mneme/private memory |
| Chosen action and world receipt join fields | Host paths and private diagnostics |
| Terminal turn status | Other agents' unavailable state |

The authenticated world binding is added by Daimon because Pi does not own
world authority. A delivery-backed wake may arrive with a private decision
envelope; an organization-owned manual or scheduled wake begins without one
and uses `world_claim` to bind authority privately before any other world
tool. The export records the safe run/tick/wake join, but never the opaque
decision token.

Pi also cannot observe later mechanical effects that happen after an action
receipt. Simfile may join public contact, kick, goal, score, or next-state
facts through the exported receipt identifiers. Until that join exists,
`outcome.status` is `pending_world_join`; Daimon does not invent a reward.
