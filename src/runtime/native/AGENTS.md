# Engine broker native boundary

This folder owns the Linux-only, root-owned process launcher used by the
engine broker. It authenticates the organization runtime with `SO_PEERCRED`,
selects an immutable root-owned registration by opaque slot, and drops a
provider worker to its registered identity. It never owns provider credentials.

The wire ABI is fixed-width and versioned. Caller-controlled executable paths,
arguments, environment, endpoints, identities, and filesystem paths are
forbidden. Prompt and scoped capability bytes cross as inherited sealed file
descriptors, not protocol strings. Workers must start in a private process
group with no-new-privileges, no capabilities, no core dump, and a parent-death
signal. Unsupported platforms fail closed.

The worker argv is one compiled constant: the lean Grok 1.0.34 flags, the
`DBL_GROK_SYSTEM_PROMPT` operating contract, the `--tools` allowlist and the
`--max-turns` backstop live in `engineBrokerLauncher.h`, mirrored byte-for-byte
by `src/contracts/grokWorkerContract.ts` and checked by `launcherArgv.test.ts`.
Model and reasoning effort are per-deployment and belong to the worker
`config.toml`, never to the argv.

The launcher sets exactly two turn-scoped capabilities in the worker
environment: `DAIMON_MCP_CAPABILITY` and `DAIMON_PROVIDER_CAPABILITY` (Grok
1.0.34 ignores `[auth_provider.*]` helpers for custom models, so the worker
config reads the proxy capability through `env_key`). `--auth-provider` mode
remains for callers of the older contract.

It also exports `TMPDIR=<registered home>/tmp`, the worker's private temp
directory, derived only from the root-owned registration.

Received descriptors carry `MSG_CMSG_CLOEXEC` and can already occupy fds 3-5,
so `launch()` lifts prompt, capability, output, executable and status fds above
16 before `dup2`-ing them into place; a `dup2` onto itself keeps close-on-exec
and the prompt used to vanish at exec. `fixtureWorker.c` reads
`/proc/self/fd/3` so the integration suite fails if that regresses.

The executable is re-hashed on every spawn (~58 ms for the 136 MB Grok binary).
Holding one verified descriptor and `execveat`-ing it would not make a replaced
binary unrunnable: Grok 1.0.34 re-executes itself inside bubblewrap by path
(`/usr/local/bin/grok`), so the image path's root ownership, not the launcher
descriptor, is what protects the sandboxed process.
