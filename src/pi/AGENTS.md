# Pi runtime implementation

This directory owns the Pi harness and native CLI adaptation. Keep public
runtime contracts independent of Pi types. Files stay below 400 lines and
tests live beside their implementations.

Codex permission rendering must preserve the effective path permissions while
removing redundant nested denies that cannot be mounted by its Linux sandbox.
An intervening readable path or workspace root makes a deeper deny necessary.
Verify changes with generated production arguments and real local sandbox
commands; a model call is neither required nor permitted for this check.

The per-wake MCP mount is torn down on the wake's own completion path, so that
teardown must be bounded. `Server.close()` waits for every open connection, and
a connection the MCP transport has no record of — a socket opened before
`initialize`, or an idle keep-alive socket a client's pool still holds, which is
what relaying a turn through the broker MCP facade leaves behind — is not the
transport's to end. Close the transport first, then end the remaining
connections; never wait for the client to release them. A finished turn that
parks here publishes nothing and dies to an outer deadline, which loses exactly
the terminal evidence the turn existed to produce.
