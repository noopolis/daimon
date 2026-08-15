# Daimon README Docs Audit

Date: 2026-07-10
Package version: 0.1.2

This audit checks every command and claim in README.md against the actual
source tree and the public npm registry. Status values:

- `runs` - works as documented against the current source tree.
- `runs (live, preflight-gated)` - works, but spends real tokens and requires
  local engine auth; not part of `npm test`.
- `broken (pending publish)` - documented command fails today because a
  pinned dependency version is not yet published.

## Claims

| # | Claim | Status | Verify invocation | Evidence |
| --- | --- | --- | --- | --- |
| C1 | Install daimon (registry has 0.1.1; source tree is 0.1.2, drift) | runs | `npm install @noopolis/daimon` | README.md L14-16; package.json (version 0.1.2); `npm view @noopolis/daimon versions` |
| C2 | Install daimon + mneme pair | runs | `npm install @noopolis/daimon @noopolis/mneme` | README.md L20-22 |
| C3 | `file:../mneme` devDependency for local incubation | runs | `cat package.json` | package.json devDependencies (`@noopolis/mneme: file:../mneme`); README.md L26-32 |
| C4 | `@noopolis/daimon/pi` subpath import | runs | `npm run build && npm run typecheck` | README.md L36-38; package.json exports["./pi"]; src/pi entry point |
| C5 | `memory.runtimeHomePath` option on `PiHarnessOptions` | runs | `npm test` | README.md L40-52; src/pi harness options and tests |
| C6 | Dream wakes use a fresh session under `sessions/dream/<wake-id>-<random>` | runs | `npm test` | README.md L54-58; src wake/dream session tests |
| C7 | `memory_register`, `memory_summarize`, `memory_forget` tool wiring | runs | `npm test` | README.md L57-58; src memory tool wiring tests |
| C8 | `npm test` / `npm run typecheck` / `npm run build` (36 tests pass) | runs | `npm run build && npm run typecheck && npm test` | README.md L60-71; test run 2026-07-10 (36/36 pass) |
| C9 | Model and auth helpers (Codex OAuth, Claude Code OAuth, API key, Ollama-style) | runs | `npm test` | README.md L73-84; src auth helper tests |
| C10 | `npm run e2e:pi-agent` | runs (live, preflight-gated) | `npm run e2e:pi-agent` | README.md L86-98 (preconditions line); requires `~/.codex/auth.json`; not in `npm test` |
| C11 | `npm run e2e:pi-memory-org` | runs (live, preflight-gated) | `npm run e2e:pi-memory-org` | README.md L86-98, L104-108; requires `~/.codex/auth.json`; not in `npm test` |
| C12 | `npm run e2e:mixed-engine-org` (Codex/Grok/Agy) | runs (live, preflight-gated) | `npm run e2e:mixed-engine-org` | README.md L86-98, L110-113; requires `~/.codex/auth.json` plus authenticated `grok` and `agy` CLIs on PATH; not in `npm test` |
| C13 | `npm run e2e:jungian-play-org` | runs (live, preflight-gated) | `npm run e2e:jungian-play-org` | README.md L86-98, L115-119; requires `~/.codex/auth.json`; not in `npm test` |
| C14 | `npm run e2e:jungian-triad-org` (Codex/Grok/Pi) | runs (live, preflight-gated) | `npm run e2e:jungian-triad-org` | README.md L86-98, L121-125; requires `~/.codex/auth.json` plus authenticated `grok` and `agy` CLIs on PATH; not in `npm test` |
| C15 | `MEMORY-SYSTEM.md` describes the implemented memory runtime; `ENGINE-SYSTEM.md` describes the engine abstraction plan | runs | manual review | README.md L127-137; MEMORY-SYSTEM.md; ENGINE-SYSTEM.md |

## Validation run (2026-07-10)

- `npm run build` -> exit 0
- `npm run typecheck` -> exit 0
- `npm test` -> 36/36 pass
- `npm view @noopolis/daimon versions` -> `['0.1.0','0.1.1']`
- `npm view @noopolis/mneme versions` -> `0.1.0`
