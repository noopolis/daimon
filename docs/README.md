# Daimon Docs

Daimon is the per-agent runtime harness for Noopolis. Each harness runs
one prepared agent; the optional runtime host routes wakes to several harnesses
with separate agent homes and queues.

Current docs:

- [runtime.md](runtime.md) - runtime config, control endpoints, schedules, durable wake
  acceptance, and attention.
- [engines.md](engines.md) - Pi harnessing, CLI engine boundaries, auth storage, and live
  checks.
- [memory.md](memory.md) - how Daimon adapts Mneme without owning memory semantics.
- [observability.md](observability.md) - causal events, raw training capture, and redacted world
  trajectories.

Historical plans and audits were moved to the [archive](../archive/).
They are preserved for context, but the files above and the source contracts are
the current guide.

Source map:

- [`src/core/`](../src/core/) - runtime-neutral harness contracts.
- [`src/pi/`](../src/pi/) - Pi adapter, prompts, world tools, memory tools, wake handling,
  and engine-session adapters.
- [`src/runtime/`](../src/runtime/) - organization-runtime config, HTTP control process, durable
  wake acceptance, schedules, attention, production tool mounting, and engine
  readiness.
- [`src/contracts/`](../src/contracts/) - data-only JSON Schema and contract constants.
- [`src/observability/`](../src/observability/) - causal event helpers and org observation.
- [`src/mcp/`](../src/mcp/) - tool server used by production MCP mounts.

Public package entrypoints:

- `@noopolis/daimon`
- `@noopolis/daimon/pi`
- `@noopolis/daimon/runtime`
- `@noopolis/daimon/observability`
