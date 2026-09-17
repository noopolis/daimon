/**
 * Mode for every directory Daimon creates inside an agent's runtime home.
 *
 * A brokered Grok agent's runtime home is `0710`
 * (`GROK_ENGINE_BROKER.worker.home.organizationRuntimeHome`) so its sandboxed
 * worker can traverse into the setgid `tool-output/` spill directory. Traverse
 * is all it may have: anything Daimon creates in that home — telemetry traces
 * (prompts, replies, world trajectories), tool state, receipts, the engine's
 * XDG directories and the private `.tmp` — stays `0700`, so a default
 * `mkdir` (0755 under the usual umask) never turns a traversable home into a
 * readable one.
 */
export const RUNTIME_HOME_SUBDIRECTORY_MODE = 0o700;
