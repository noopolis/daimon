import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

type ChildState = { closed: boolean; close: Promise<void>; pgid?: number };

const childStates = new WeakMap<ChildProcess, ChildState>();
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class CliProcessCleanupError extends Error {
  public constructor(operation: string, cause?: unknown) {
    super(`CLI process cleanup failed while ${operation}`, { cause });
    this.name = "CliProcessCleanupError";
  }
}

export const trackCliChild = (child: ChildProcess): ChildProcess => {
  if (childStates.has(child)) return child;
  let resolveClose!: () => void;
  // Keep the process group id at spawn time. `child.pid` is no longer a useful
  // source of truth after the leader exits while one of its descendants lives.
  const state: ChildState = {
    closed: false,
    close: new Promise((resolve) => { resolveClose = resolve; }),
    ...(process.platform === "win32" || child.pid === undefined ? {} : { pgid: child.pid })
  };
  child.once("close", () => { state.closed = true; resolveClose(); });
  childStates.set(child, state);
  return child;
};

const groupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new CliProcessCleanupError(`inspecting process group ${pgid}`, error);
  }
};

type LinuxProcessState = Readonly<{ group: number; state: string }>;

const parseLinuxProcessState = (stat: string): LinuxProcessState | undefined => {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const group = Number(fields[2]);
  return fields.length >= 3 && Number.isInteger(group) ? { state: fields[0]!, group } : undefined;
};

/**
 * What a `/proc` snapshot says about a process group.
 *
 * `"settled"` covers BOTH "every member is an exited zombie" and "the group has
 * no members at all". Those are the same fact — nothing in the group can still
 * execute — but they used to be reported differently: an empty scan returned
 * `undefined`, which the caller read as "not settled", so a group that had
 * finished disappearing was declared unfinished and cleanup threw.
 *
 * That is reachable whenever the last member exits between `groupExists` (which
 * sees it, zombies included) and this scan. It only bites on Linux, because the
 * `/proc` path does not run anywhere else — and containers are Linux, so it is
 * the platform that actually matters.
 *
 * `"unknown"` is reserved for a genuine read failure, where refusing to call the
 * group settled is the safe answer.
 */
type LinuxGroupScan = "live" | "settled" | "unknown";

const linuxGroupScan = async (pgid: number, procRoot = "/proc"): Promise<LinuxGroupScan> => {
  let entries: string[];
  try { entries = await readdir(procRoot); } catch { return "unknown"; }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const processState = parseLinuxProcessState(await readFile(`${procRoot}/${entry}/stat`, "utf8"));
      if (processState?.group !== pgid) continue;
      if (processState.state !== "Z" && processState.state !== "X") return "live";
    } catch (error) {
      // ENOENT is the process exiting mid-scan, which is exactly what settling
      // looks like; anything else means the snapshot cannot be trusted.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    }
  }
  return "settled";
};

const groupSettled = async (pgid: number): Promise<boolean> => {
  if (!groupExists(pgid)) return true;
  if (process.platform !== "linux") return false;
  return await linuxGroupScan(pgid) === "settled";
};

const signalGroup = (pgid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new CliProcessCleanupError(`signaling process group ${pgid}`, error);
  }
};

const waitForGroupSettled = async (pgid: number, milliseconds: number): Promise<boolean> => {
  const deadline = Date.now() + milliseconds;
  while (true) {
    try {
      if (await groupSettled(pgid)) return true;
    } catch (error) {
      // EPERM is not evidence that a group is settled. Keep waiting for
      // ESRCH or, on Linux, a /proc snapshot containing only exited zombies.
      if (!isPermissionError(error) || Date.now() >= deadline) throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
};

const isPermissionError = (error: unknown): boolean =>
  error instanceof CliProcessCleanupError
  && (error.cause as NodeJS.ErrnoException | undefined)?.code === "EPERM";

export const terminateChild = async (child: ChildProcess): Promise<void> => {
  trackCliChild(child);
  const state = childStates.get(child)!;
  const pgid = state.pgid;
  if (pgid !== undefined && !await groupSettled(pgid)) {
    if (signalGroup(pgid, "SIGTERM") && !await waitForGroupSettled(pgid, 1_000)) {
      signalGroup(pgid, "SIGKILL");
      if (!await waitForGroupSettled(pgid, 1_000)) {
        throw new CliProcessCleanupError(`waiting for process group ${pgid} to exit`);
      }
    }
  } else if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  // A `close` event proves that Node released its pipes. ESRCH, or a Linux
  // process-group snapshot containing only exited zombies, proves that no
  // detached descendant can still execute. Both are required for success.
  if (!state.closed) await state.close;
  if (pgid !== undefined && !await groupSettled(pgid)) {
    throw new CliProcessCleanupError(`waiting for process group ${pgid} to exit`);
  }
};
