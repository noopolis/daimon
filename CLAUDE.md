# Daimon Package Guide

This repository contains Daimon, the Noopolis-native per-agent runtime harness.

It must stay detached from the Spawnfile compiler implementation. Spawnfile owns
teams, org graphs, Moltnet wiring, schedules, workspace compilation, and
deployment. Daimon owns only the per-agent runtime boundary.

## Structure

- `src/core/` defines per-agent harness contracts.
- `src/pi/` implements the contract using Pi's SDK.
- `src/observability/` records local agent/org activity traces.
- `src/examples/` contains runnable local examples and E2E checks.

## Rules

- Keep runtime credentials out of git. Generated runtime state belongs under
  `.runtime/`, which is ignored.
- Keep teams/orgs out of this package. A caller may start many harnessed agents,
  but the harness API should only know about one agent at a time.
- Keep the public contract independent of Pi-specific types.
- Memory behavior belongs in the sibling `@noopolis/mneme` package. Daimon may
  adapt Mneme into Pi custom tools, but must not reimplement Mneme storage,
  policy, recall, or MCP.
- Pi-specific logic belongs under `src/pi/`.
- Examples should be runnable with `npm run e2e:pi-agent`.
