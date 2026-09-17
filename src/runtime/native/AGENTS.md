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

The result frame's last word is `diagnostic_length`, not padding: on
`DBL_STATUS_WORKER_FAILED` the supervisor keeps the last `DBL_MAX_DIAGNOSTIC`
bytes of the worker's merged stdout/stderr and sends them after the fixed
frame, while `output_length` stays 0 as before. Every other failure sends none,
and `closed_result` refuses a frame that mixes the two. The bytes are the
worker's own, so the broker redacts them before they cross any boundary.

**Known gap: that window is the wrong end.** A worker that dies early prints
its error first and then echoes its own input, so a pure tail keeps the echo:
the one live capture this has ever produced was 512 bytes of the agent's own
prompt read back, with the error already off the front and erased here. The
broker side now keeps both ends of whatever it is handed
(`boundedDiagnosticWindow` in `../../pi/cliChildOutput.ts`, the same
head-plus-marker-plus-tail shape as an oversized tool result), but it cannot
recover a head this supervisor never sent. The fix belongs in
`engineBrokerLauncherServer.inc`, where the full `used` bytes are still in
hand at the point of the `memmove`: keep the first `DBL_MAX_DIAGNOSTIC / 2`
bytes, then a marker naming the elided count, then the last
`DBL_MAX_DIAGNOSTIC / 2`. It is a source change to a *pinned* artifact, so it
lands only together with `node --import tsx src/runtime/native/build.ts` and a
re-pin of `artifacts.sourceSha256`/`x64Sha256`/`arm64Sha256`;
`artifactsManifest.test.ts` fails by design until the binaries are rebuilt.
