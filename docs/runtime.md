# Runtime

[Documentation index](README.md)

Daimon's organization runtime hosts isolated agents from one strict config. It
does not know team structure, org graphs, Moltnet room policy, deployment, or
Spawnfile compilation.

Use the package subpath:

```ts
import {
  createOrganizationRuntimeHost,
  parseOrganizationRuntimeConfig
} from "@noopolis/daimon/runtime";
```

The CLI entrypoint is:

```bash
daimon-runtime run --config /runtime/daimon-runtime.json
```

The config parser accepts `noopolis.daimon.organization-runtime.v1` and `v2`.
Both require a host and one to 32 agents. Each agent has:

- `id`, `name`, and `instructions`.
- absolute `workspacePath` and `runtimeHomePath`.
- `engine.kind` of `codex`, `grok`, or `agy`.
- optional `mcp`, `moltnet`, `memory`, and `attention`.
- for v2 only, one `schedule`.

Configuration must not contain credentials, arbitrary environment maps, command
arrays for engines, process handles, roles, teams, or parent/member links. The
parser normalizes paths and rejects overlapping workspace/runtime-home roots.
Before starting agents, the host verifies caller-created directories are real,
current-user-owned, and not unsafe through symlinks or writable permissions.

The control token is named by `host.controlTokenEnv`; only the variable name is
stored in config. HTTP requests use `Authorization: Bearer <token>`.

Runtime endpoints:

- `GET /healthz` is unauthenticated process health.
- `POST /v1/wake` runs one synchronous wake for non-attention agents.
- `GET /v1/health` returns host and agent health.
- `GET /v1/activity` returns bounded activity.

Set `DAIMON_RUNTIME_ACCEPTANCE_STORE` to enable the durable v2 control plane:

- `POST /v2/wakes` fsyncs an accepted wake before execution.
- `GET /v2/wake-receipts/<acceptance_id>` returns redacted lifecycle status.
- `GET /v2/activity` includes durable receipts and active executions.
- `GET /v2/availability` reports running, pending, deferred, and budget state.

Equal delivery retries return the original acceptance. A changed payload for the
same delivery id is rejected. Accepted delivery is durable at-least-once turn
delivery; destinations that require exactly-once effects must deduplicate their
own external side effects.

Attention is opt-in per agent:

```json
{
  "attention": {
    "maxBatchMessages": 8,
    "maxBatchBytes": 12000,
    "maxExecutions": 30,
    "maxTokens": 3000000
  }
}
```

Attention agents require the durable v2 route. They receive `daimon_inbox` and
`daimon_inbox_disposition`; reading does not complete a message, and unmarked
or deferred deliveries stay pending.

Version 2 schedules are normalized on the agent:

- `{ "kind": "disabled" }`
- `{ "kind": "every", "interval_ms": 60000, "prompt": "..." }`
- `{ "kind": "cron", "cron": "0 9 * * 1", "timezone": "Europe/Berlin", "prompt": "..." }`

Optional `jitter_seconds` is bounded to one hour. Schedules are runtime-native
delivery sources; they do not give Daimon org-graph authority.

`reconcileOfflineWakeTransition` is a library operation for deployment-admin
recovery of a blocked durable store. It is not an HTTP endpoint or normal host
action.
