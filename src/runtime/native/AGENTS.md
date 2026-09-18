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

**The worker's end of that pipe is a blocking pipe.** `O_NONBLOCK` is a
property of the open file description, not of a descriptor, so creating the
merged stdout/stderr pipe with `pipe2(..., O_NONBLOCK)` handed non-blocking
writes to the worker along with `pipes[1]`: Grok 1.0.34 makes the first EAGAIN
from a headless stdout write fatal (`stdout write failed: Resource temporarily
unavailable (os error 11)`) and exits 1 before it issues a single model
request, so the turn burns a wake and buys nothing. It stayed invisible until
the MCP tools became reachable and the init frame that enumerates them grew to
roughly 9.5 KB — past a pipe buffer, which is not always the 64 KiB default
(8 KiB inside the Docker Desktop VM this suite runs in). So the pipe is created
`O_CLOEXEC` only and `O_NONBLOCK` is set afterwards on `pipes[0]` alone, the
read end this process polls; that one is load bearing, because the post-exit
drain loop has no `poll` and would otherwise park on a write end some surviving
grandchild still holds.

A blocking child cannot wedge the launcher. `serve()` runs in its own forked
handler per connection, so one worker's backpressure never reaches another
turn; `supervise` drains the pipe on every pass of a 250 ms `poll`, and both
bounds act on a child that is asleep in `write()`: crossing `DBL_MAX_OUTPUT`
stops reading (`p[1].events = 0`) and `kill(-pid, SIGKILL)`s the worker's whole
process group in the same iteration, and a client disconnect does the same —
neither is refusable by a process sleeping on a pipe. `worker_spill_case` is
the cover: the fixture shrinks its own stdout pipe to the kernel minimum,
reports the capacity it actually got, and writes four times that in one
`write`, so it straddles the buffer on any host without assuming 64 KiB while
staying under `DBL_MAX_OUTPUT`.

**Crossing `DBL_MAX_OUTPUT` is a reported status, not a lost turn.** This is
worth stating because it has been guessed at twice: a trip sets
`output_limited`, stops reading, `SIGKILL`s the worker's process group, reaps
it, and then — `disconnected` is still 0, so the branch at the end of
`supervise` runs — writes the complete 128-byte result frame with
`DBL_STATUS_OUTPUT_FAILED`, `DBL_STAGE_OUTPUT`, `DBL_FAILURE_OUTPUT_LIMIT` and
`output_length = 0`. `closed_result` admits exactly that shape, the client
relays it, and `decodeNativeBrokerResult` raises a named
`NativeBrokerTurnFailure`. So a trip costs the turn its *text* and nothing
else: the broker still seals the turn and still meters the spend the proxy
measured. A lost terminal frame, an unnamed transport failure or an unmetered
turn therefore cannot be explained by this bound, and the only branch that
sends nothing at all is a client that already disconnected.

The bound is the whole turn's stdout, not one frame. A live single-tool-call
brokered turn already emitted 26,486 bytes, 23,320 of them one tool-result
frame (`.runtime/grok-p1b/worker-a2-output.jsonl`), against a `--max-turns` of
48 and a 16 KiB tool-result spill bound, so 64 KiB is reachable by an ordinary
working turn rather than only by a runaway one.

The result frame's last word is `diagnostic_length`, not padding: on
`DBL_STATUS_WORKER_FAILED` the supervisor keeps the last `DBL_MAX_DIAGNOSTIC`
bytes of the worker's merged stdout/stderr and sends them after the fixed
frame, while `output_length` stays 0 as before. Every other failure sends none,
and `closed_result` refuses a frame that mixes the two. The bytes are the
worker's own, so the broker redacts them before they cross any boundary.

**The window keeps both ends.** A worker that dies early prints its error
first and then echoes its own input, so a pure tail kept the echo: the one live
capture this had ever produced was 512 bytes of the agent's own prompt read
back, with the error already off the front and erased here. `diagnostic_window`
keeps the first `DBL_MAX_DIAGNOSTIC / 2`, then `DBL_DIAGNOSTIC_ELISION` naming
the bytes dropped, then the last `DBL_MAX_DIAGNOSTIC / 2`, all inside the same
bound — the marker is sized against `used`, the largest count it can carry, so
the budget holds for every input, and a `snprintf` that will not fit falls back
to the tail. Output that already fits is left in place, byte-identical, with no
marker. The marker text is byte-identical to the TypeScript window's
(`boundedDiagnosticWindow`), so one grep finds an elision on either side of the
boundary.

That elision is a *cut*, and a cut can split a turn capability in half, leaving
a fragment exact redaction can never match. The answer used where Daimon owns
both ends — retain one whole secret more than is reported — cannot work here,
because what this window keeps is exactly what it sends: a margin reserved here
would be sent too. So the fragment is scrubbed where the capabilities are
known, in `engineBrokerNativeClient.ts` (`scrubCutFragments`), on both sides of
every marker and at the window's outer ends.

Changing any of the six pinned launcher sources means rebuilding: `node
--import tsx src/runtime/native/build.ts`, then re-pin
`artifacts.sourceSha256`/`x64Sha256`/`arm64Sha256` in the contract manifest and
re-emit it. `artifactsManifest.test.ts` fails by design until that is done. The
adversarial suite is `docker build -f Dockerfile.integration -t <tag> .` in this
folder and `docker run --rm --privileged <tag>`; `worker_flood_case` is the
head-and-tail cover and fails first if the window regresses to a tail.
