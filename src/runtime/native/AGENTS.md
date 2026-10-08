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

**A supervised turn now has a ceiling, because it used to have none.**
`supervise` waited for the worker to exit or the client to disappear, and if
neither happened it waited for ever. A handler was found alive after 25 hours
with its worker still running — 87,000 seconds of CPU, two thirds of it in the
kernel — long after the broker had closed the turn and its client was gone. A
turn that hangs and a turn that fails are not the same thing to the caller: the
second is reported, sealed and retried, the first is silent and costs whatever
was waiting on it. `DBL_MAX_TURN_SECONDS` (4200: the control protocol's
3,600,000 ms maximum plus ten minutes) is measured on `CLOCK_MONOTONIC`, and
crossing it kills the worker's process group and publishes the ordinary
`DBL_STATUS_WORKER_FAILED`/`DBL_FAILURE_WAIT` frame. No new wire status: an
unresponsive turn IS a failed wait. `term_signal` is set to SIGKILL on a turn
this loop ended itself, which is what distinguishes a ceiling or spin trip from
a `waitpid` that failed. An unreadable clock means no ceiling rather than a
false one — refusing to bound a turn is recoverable, cutting a working one short
is not.

**What burned the core: a pipe at EOF is readable for ever and yields nothing.**
A worker can outlive its own stdout. Once every write end is closed, `poll`
reports the read end ready immediately and `read` returns 0 — and the loop only
consumed POLLIN and only acted on a positive read, so it consumed nothing and
polled again, for ever. Two corrections: `read` returning 0 removes the
descriptor from the poll set, and so does POLLHUP/POLLERR/POLLNVAL on it.
**Clearing `events` is not enough and never was** — POLLHUP, POLLERR and
POLLNVAL are reported whatever `events` asks for, so only `fd = -1` stops them
waking `poll`. The output bound used to clear `events` and carried exactly the
same latent spin; it now removes the descriptor too. POLLNVAL on the client
socket is also a disconnect now, which it was not.

**And a spin detector behind both, for the fd condition nobody has thought of.**
A healthy pass blocks on the 250 ms timeout, so a healthy loop cannot run
`DBL_MAX_IDLE_PASSES` consecutive passes that change nothing, while a spin gets
there in under a second. Crossing it ends the turn the same way the ceiling
does. It exists because the 25-hour handler was an *unexplained* spin: the
specific cause is fixed above, and this is what makes the next one cost a turn
instead of a core.

`worker_eof_spin_case` and `worker_ceiling_case` are the cover, and they assert
on the only observable that separates a fixed launcher from a wedged one while
the worker is still alive — the handler's CPU, read from `/proc`, because the
protocol says nothing at all during a spin. Reverting the descriptor removal and
the guard reproduces production exactly and the case reports it:
`handler 46 burned 201 ticks in 2s while its worker sat at EOF` — a full core.
The suite compiles the launcher with `-DDBL_MAX_TURN_SECONDS=8` because it
cannot wait 4200 seconds to prove a bound; drop that `-D` and the ceiling case
fails on its socket deadline instead of passing on a timeout.

**A handler leaked whenever its broker died, and the client is what kept it.**
The handler ends a turn when its client disconnects, and the broker always
kills its `--client` when a turn ends — while the broker is alive. A broker that
dies cannot: the client is spawned detached into its own session, so it lived
on, blocked reading its result and holding the handler's socket open, and the
handler kept supervising a turn nobody would ever read. With Grok's habit of
closing its stdout and staying alive, that was the production leak exactly:
`orphaned_client_case` built against the pre-ceiling launcher reports
`handler 23 outlived its dead broker's turn, burning 199 ticks in 2s` — a full
core, for ever, under a parent that is the root broker. The ceiling and the EOF
fix above stopped the spin but not the leak: the handler then waited, idle, for
up to `DBL_MAX_TURN_SECONDS` (seventy minutes) past its turn. `client_mode` now
sets `PR_SET_PDEATHSIG, SIGKILL`, so the client dies with its broker, the
socket closes, and the handler kills the worker and exits at once. The parent
is compared before and after the `prctl`, not tested against 1, because a
broker can legitimately be pid 1 in its container and one that died before the
`prctl` landed has already reparented the client. A death signal cannot cover
a death that already happened, so the broker also names itself in
`DAIMON_BROKER_PID` (`engineBrokerNativeClient.ts`) and the client refuses when
that pid is not its parent — a client whose broker died before it ran never
connects. `orphaned_client_case` stands in for a crashed broker and requires the
handler gone within six seconds of the turn being fed, inside the integration
build's 8-second ceiling, so the ceiling cannot be what passes it; removing the
`prctl` turns it red. `preorphaned_client_case` lets the broker die before its
client runs; ignoring the named pid turns it red.

**`DBL_LISTEN_BACKLOG` is 128 and was 16.** Concurrency is structurally bounded
well below either — the dispatcher runs at most one execution per agent, so
twelve agents is a ceiling of twelve — and a measured 19,110-sample census of a
live deployment never saw more than 9 workers at once. So this never caused
anything, and it is corrected as a latent defect, not an explanation: at 16 the
headroom over a twelve-agent org was one agent, and past the queue a client's
connect fails silently, which is the worst shape this boundary has.

**The worker's process group is not a container, and the identity is.** The
launcher owns the whole lifecycle of what it starts, and it used to end a turn
with `kill(-pid, SIGKILL)` alone. A process group is not a container in
principle: one `setsid()` leaves a group and a session, and a double fork leaves
no ancestry to walk, so a group-scoped kill is not a lifecycle guarantee.
**Correction to what this file used to claim:** real Grok 1.0.34 does NOT leave
the group — its bubblewrap re-exec IS the process the launcher forked, pgid ==
pid, with the sandboxed CLI in the same group, measured on the live deployment.
The identity reap below is sound and it is shipped, but it is defence in depth
against a future engine that detaches, not the fix for the 25-hour wedge. That
was the spin above. In production two `grok` workers outlived their
turns by 48 minutes that way, alive under live `bwrap` parents, and the
organization's pre-run gate counted them as work in flight and refused to run.
It is not a bubblewrap quirk to special-case, either: one `setsid()` leaves a
process group and a session, and a double fork leaves no ancestry to walk.

So `supervise` also calls `reap_worker_identity(uid)`, which SIGKILLs every
process owned by the registration's worker uid and then proves the identity
owns nothing. That works because the uid cannot be left: `valid_registration`
admits only a dedicated worker identity (>= 2200, one per agent, `nologin`),
nothing else in the deployment runs as it, and the organization runtime holds
one execution claim per agent — **one identity carries at most one turn at a
time, and the reap depends on that.** It runs on every closing path (completed,
worker failure, output limit, cancellation, failed wait) and before the result
frame is written, so the broker has not yet been told the turn is over and
cannot have started this agent's next one.

Zombies count as unsettled on purpose: a killed-but-unreaped `[bwrap]
<defunct>` is still a `bwrap` to anything matching on process names, which is
the symptom this exists to end. The connection handler is therefore a
`PR_SET_CHILD_SUBREAPER`, so orphans reparent to it and the reap's `waitpid`
drain collects them instead of leaving them to pid 1. The five-second bound is
not a deadline a turn can trip — SIGKILL is not refusable and this settles in
milliseconds — it only stops a process wedged in uninterruptible I/O from
parking the turn's answer forever.

`worker_escape_complete_case`, `worker_escape_failure_case` and
`worker_escape_cancel_case` are the cover, and the cancel case is the deadline
path: a brokered turn past its token, request or wall-clock limit is cancelled
by killing the launcher's client, which arrives here as the client disconnect.
The fixture reproduces the escape rather than bubblewrap — `setsid()` and then
a second fork, so the survivor shares neither group, session nor ancestry with
the turn — and each case proves the escapee existed before asserting the
identity is empty. Removing the reap turns all three red and nothing else in
the suite notices. **Do not trust the assertion that was here before:** the
only cleanup check the suite had ran `pgrep -u 2200 fixture-worker` against a
fixture installed as `grok`, so it matched nothing on any build and passed
whether or not the turn leaked.

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

**Both readers of that buffer trip the same bound**, through
`output_limit_crossed`. The poll loop always did; the post-exit drain did not,
so a worker that exited with more than `DBL_MAX_OUTPUT` still in the pipe left
`used` at the buffer's last byte with `output_limited` clear, and the turn was
published `DBL_STATUS_OK` with `output_length = DBL_MAX_OUTPUT + 1` — which
`closed_result` refuses, so the client replaced it with a fabricated
`prelaunch_failed`/`protocol` frame carrying no pid and no start ticks. That
frame says the worker never ran, about a turn that ran and whose work may have
succeeded, which is the one class of lie this boundary must never tell.
The window is real but narrow: `poll` is level-triggered, so the loop sees any
buffered byte, and the drain can only inherit data written in the gap between
`poll()` returning and `waitpid()` reaping. It is therefore **not
reproducible on demand in this suite** — the fix is by construction, and the
adversarial cases that do cross the bound (`output_boundary_case`,
`worker_flood_case`, `worker_spill_case`) only prove it did not regress. Do not
add a test that claims to cover it by feeding the bound through the poll loop:
that routes around the defect.

The bound is the whole turn's stdout, not one frame, and it is now 256 KiB.
**This supersedes the "known limit, deliberately not raised yet" this file
carried while the pipe's blocking mode was the variable under test.** The
measurement that decided it: a live brokered turn emitted 26,482 bytes for
four tool calls, 23,320 of them one tool-result frame carrying all four
(`.runtime/grok-p1b/worker-a2-output.jsonl`); JSON framing and escaping
inflated those payloads by 1.007x, so a turn's stdout is close to the sum of
its tool results. The nine-tool-call turn this was raised for is about 210 KB
of the same shape, against a 64 KiB bound — so 64 KiB was reachable by an
ordinary working turn, and crossing it costs that turn its whole text. The new
number is not headroom-by-guess: it is the control protocol's own `text` bound
(`engineBrokerProtocol.ts`, 262144), the next boundary this output has to
cross, so a larger launcher bound would only move the refusal one layer up.
`worker_turn_case` writes exactly that measured shape — a 9,728-byte init
frame and nine 23,320-byte frames, 219,608 bytes — and asserts it is published
whole; restoring 65536 turns it red.

**A bound that hangs would be worse than no bound, and this one does not.**
The hypothesis that a worker parks forever in `write()` once the bound is
crossed — plausible after the pipe became blocking, because a write that
cannot complete now blocks instead of erroring — was tested, not reasoned
about, and it is false. `worker_stream_case` writes eight times the bound in
frame-sized writes and then sleeps far longer than this suite, so it is asleep
inside `write()` with its pipe full when the trip fires and nothing but the
launcher can end it; the launcher answers `output_limit` with `term_signal`
SIGKILL in seconds. Its socket carries a 30-second deadline so a park fails
red instead of parking the runner. Deleting the `output_limited` half of
`if (disconnected || output_limited) kill(-pid, SIGKILL)` is the mutation that
proves it: the case then times out on that deadline, and
`output_boundary_case` does not notice, because its worker has already exited
by the time the trip fires. That is the boundary the two cases straddle —
a worker gone at the trip against a worker alive and blocked at it.

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
