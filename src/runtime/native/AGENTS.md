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
