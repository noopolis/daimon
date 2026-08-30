# Data-only contract guide

`src/contracts` owns runtime-neutral constants, schemas, manifest data, and
pure canonicalization used by runtime code and emitted artifacts.

Keep this folder deterministic and free of I/O, environment access, secrets,
process control, runtime orchestration, and Pi-specific types. Contract objects
must remain immutable literal data suitable for canonical JSON emission.
Runtime behavior belongs in `src/runtime/`; Pi integration belongs in `src/pi/`.
