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

## Branches and pull requests

**Never commit to `main`.** Every change lands through a pull request, without
exception — including one-line fixes, CI configuration, documentation, and
version bumps. Work on a branch, push it, open the PR, and let CI run.

Direct commits to `main` bypass the checks that catch what local runs do not.
A zero-byte receipt store, a package that ships without its native binary, and
a two-week-red pipeline all reached `main` in this ecosystem while every local
gate was green — CI found them the first time it ran over the code.

- Branch names describe the change: `feat/…`, `fix/…`, `ci/…`, `docs/…`.
- Commit messages are conventional and single-line (`feat:`, `fix:`, `docs:`,
  `ci:`, `chore:`, `refactor:`, `test:`).
- Never add co-author lines, sign-offs, or AI attributions.
- Commit as you go rather than in one batch at the end, so history shows how
  the work progressed.
- Merge with a merge commit rather than a squash when the individual commits
  carry meaning; squashing collapses that history irreversibly.
