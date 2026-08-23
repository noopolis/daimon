# Daimon organization-runtime contract

This folder owns the versioned, organization-neutral contract and host for
isolated Daimon agents. It is not a compiler, organization graph, scheduler,
Moltnet adapter, or deployment surface.

Keep config parsing pure and strict. The config must never contain credentials,
commands, argument arrays, arbitrary environment maps, process handles, or
caller-selected implementation hooks. The host may route only explicit
agent-id wakes and lifecycle operations; it cannot select, generate, or
coordinate wakes.

Every source file stays below 400 lines. Keep tests beside the contract they
cover.

`agySubscriptionRealm.ts` owns the one host-level private D-Bus/Secret Service
realm, durable keyring lease, bounded unlock stdin, and cleanup.
`agySubscriptionBootstrap.ts` owns only the interactive first-enrollment AGY
child; normal engine dispatch remains in `engineDispatcher.ts`.
