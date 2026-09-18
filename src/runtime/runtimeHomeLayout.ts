import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

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

/**
 * The home itself, created if it is absent and otherwise left exactly as it is.
 *
 * Create-only is the whole contract here. A brokered Grok agent's home is
 * deliberately `0710` and an organization's may be `0700`; which of the two is
 * correct is `physicalReadiness.ts`'s judgement, made against the agent's
 * declared engine, and a layout helper that "corrected" a traversable home to
 * `0700` would break the worker's only route to its own spills.
 */
export const ensureRuntimeHome = async (runtimeHomePath: string): Promise<string> => {
  await mkdir(runtimeHomePath, { recursive: true, mode: RUNTIME_HOME_SUBDIRECTORY_MODE });
  return runtimeHomePath;
};

/**
 * One directory Daimon owns *below* a runtime home, private on every install.
 *
 * `mkdir(..., { mode })` decides nothing for a directory that already exists,
 * and that is the common case rather than the exotic one: a `telemetry/` left
 * at `0755` by a pre-branch Daimon, or pre-created by a deployment, stayed
 * `0755` forever. Under a Grok agent's traversable `0710` home that is the
 * worker reading its own agent's prompts, replies and causal history — the
 * home is traverse-only precisely so that nothing but `tool-output/` is
 * readable. `assertRuntimeDirectory` checks the home, and nothing checked what
 * Daimon created inside it.
 *
 * So every level below the home is asserted and corrected on the way down,
 * through a handle rather than a path: `O_DIRECTORY|O_NOFOLLOW` refuses a
 * symlink planted where a directory belongs, and the `fchmod` that follows
 * lands on the directory that was stat'd. A directory owned by anyone but the
 * runtime user is **refused**, never widened and never silently accepted — the
 * runtime cannot make someone else's directory private, and proceeding would
 * write an agent's telemetry into it anyway.
 *
 * `owner` is a seam so both refusals are testable unprivileged, exactly as
 * `physicalReadiness.ts`'s `RuntimeIdentity` is.
 */
export async function ensureRuntimeHomeDirectory(runtimeHomePath: string, relative: string, owner: number = process.getuid?.() ?? -1): Promise<string> {
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`runtime home subdirectory must name a path below the home: ${relative}`);
  }
  let current = await ensureRuntimeHome(runtimeHomePath);
  for (const segment of segments) {
    current = path.join(current, segment);
    await mkdir(current, { mode: RUNTIME_HOME_SUBDIRECTORY_MODE }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await assertPrivateDirectory(current, owner);
  }
  return current;
}

const flag = (name: "O_DIRECTORY" | "O_NOFOLLOW"): number => (constants as typeof constants & Partial<Record<typeof name, number>>)[name] ?? 0;

async function assertPrivateDirectory(directory: string, owner: number): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | flag("O_DIRECTORY") | flag("O_NOFOLLOW"));
  try {
    const entry = await handle.stat();
    if (!entry.isDirectory()) throw new Error(`runtime home path is not a directory: ${directory}`);
    if (entry.uid !== owner) throw new Error(`runtime home subdirectory must be owned by the runtime user: ${directory}`);
    if ((entry.mode & 0o7777) !== RUNTIME_HOME_SUBDIRECTORY_MODE) await handle.chmod(RUNTIME_HOME_SUBDIRECTORY_MODE);
  } finally {
    await handle.close();
  }
}
