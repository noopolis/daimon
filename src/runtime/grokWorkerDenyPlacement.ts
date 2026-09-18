import { lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Paths Grok 1.0.34's strict base profile grants read or read-write. A `deny`
 * entry that equals or contains one of them makes Grok refuse the profile
 * outright (verified for `/tmp`, `/var/tmp`, `/run`, `/etc`, `/var` and
 * `sessions`; `/tmp/sub` is accepted), so every entry must sit strictly below
 * each grant it touches.
 */
export const GROK_WORKER_BASE_PROFILE_GRANTS = Object.freeze([
  "/bin", "/dev", "/etc", "/lib", "/proc", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var", "/var/tmp"
] as const);

const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}/`);

export class GrokWorkerDenyPlacementError extends Error {
  constructor(readonly denyPath: string, readonly reason: string) {
    super(`Grok worker sandbox deny path ${JSON.stringify(denyPath)} is not placeable: ${reason}`);
    this.name = "GrokWorkerDenyPlacementError";
  }
}

/**
 * The shape half of the deny-placement policy: everything decidable without
 * touching a filesystem, so the profile renderer can refuse a bad entry before
 * its bytes are ever pinned or written.
 *
 * `renderGrokWorkerSandboxProfile` already refuses entries that are relative,
 * non-canonical, `/`, trailing-slashed, or carrying a character TOML or Grok
 * would reinterpret; this adds the base-profile grant rule.
 */
export function assertGrokWorkerDenyPathShape(denyPath: string): void {
  const grant = GROK_WORKER_BASE_PROFILE_GRANTS.find((candidate) => within(candidate, denyPath));
  if (grant !== undefined) {
    throw new GrokWorkerDenyPlacementError(denyPath, `it equals or contains the base profile grant ${grant}, which Grok refuses`);
  }
}

/** The subset of `lstat` the placement rules read; pure so every refusal is testable without root. */
export type GrokWorkerDenyPathEntry = Readonly<{
  uid: number;
  gid: number;
  mode: number;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}>;

/** One resolved path component: the entry, or the errno that stopped the walk. */
export type GrokWorkerDenyPathStep = Readonly<{ path: string; entry?: GrokWorkerDenyPathEntry; code?: string }>;

export type GrokWorkerDenyPathWorker = Readonly<{ uid: number; gid: number }>;

/**
 * POSIX search permission: owner bits win, then group, then other. The worker
 * runs with its supplementary groups cleared, so its primary gid is the only
 * group that can apply.
 */
export const grokWorkerCanSearch = (entry: GrokWorkerDenyPathEntry, worker: GrokWorkerDenyPathWorker): boolean =>
  entry.uid === worker.uid ? (entry.mode & 0o100) !== 0
    : entry.gid === worker.gid ? (entry.mode & 0o010) !== 0
      : (entry.mode & 0o001) !== 0;

/** The `/`-rooted ancestor chain of `denyPath`, deepest last, followed by the entry itself. */
export const grokWorkerDenyPathChain = (denyPath: string): readonly string[] => {
  const components = denyPath.split("/").slice(1);
  return ["/", ...components.map((_, index) => `/${components.slice(0, index + 1).join("/")}`)];
};

/**
 * The placement half of the policy, as a pure function of an already-walked
 * chain.
 *
 * Grok 1.0.34 materializes every `deny` entry inside bubblewrap **as the worker
 * uid**, by bind-mounting `$GROK_HOME/sandbox-blocked-{file,dir}` over the
 * target. So bwrap must be able to *resolve* the target as that uid: every
 * ancestor directory needs the search bit for it, and the target must already
 * exist — otherwise bwrap tries to create it and needs write on the parent,
 * which a private parent never grants. A single unplaceable entry makes Grok
 * refuse the whole profile, so every turn of that worker fails, not just that
 * path. Verified matrix: `.runtime/grok-deny-placement/EVIDENCE.md`.
 *
 * The walk may legitimately stop early: a caller that is neither root nor the
 * worker (the broker, uid 2100) cannot descend into a directory the worker's
 * own group opens to it alone — `<runtime home>/tool-state` under a
 * `2000:<worker> 0710` runtime home is exactly that. An `EACCES` below an
 * ancestor the *worker* can search is therefore "not decidable from here", not
 * a refusal; every decidable failure still refuses.
 */
export function assertGrokWorkerDenyPathPlacement(
  denyPath: string,
  steps: readonly GrokWorkerDenyPathStep[],
  worker: GrokWorkerDenyPathWorker
): void {
  assertGrokWorkerDenyPathShape(denyPath);
  const chain = grokWorkerDenyPathChain(denyPath);
  if (steps.length !== chain.length || steps.some((step, index) => step.path !== chain[index])) {
    throw new GrokWorkerDenyPlacementError(denyPath, "its resolved path chain does not match the entry");
  }
  for (const [index, step] of steps.entries()) {
    const ancestor = index < steps.length - 1;
    if (step.entry === undefined) {
      if (step.code === "ENOENT") throw new GrokWorkerDenyPlacementError(denyPath, `${step.path} does not exist; bubblewrap would have to create it as the worker uid`);
      if (step.code !== "EACCES") throw new GrokWorkerDenyPlacementError(denyPath, `${step.path} could not be read (${step.code ?? "unknown error"})`);
      // Undecidable from here, and only after every shallower ancestor passed.
      return;
    }
    if (step.entry.isSymbolicLink()) throw new GrokWorkerDenyPlacementError(denyPath, `${step.path} is a symlink; bubblewrap refuses to bind over one`);
    if (!ancestor) return;
    if (!step.entry.isDirectory()) throw new GrokWorkerDenyPlacementError(denyPath, `${step.path} is not a directory`);
    if (!grokWorkerCanSearch(step.entry, worker)) {
      throw new GrokWorkerDenyPlacementError(denyPath, `worker uid ${worker.uid} cannot search ${step.path} (${(step.entry.mode & 0o7777).toString(8)} ${step.entry.uid}:${step.entry.gid}); deny that directory itself instead`);
    }
  }
}

/** Walks one deny path on the real filesystem, recording what stopped it rather than throwing. */
export async function readGrokWorkerDenyPathChain(denyPath: string): Promise<readonly GrokWorkerDenyPathStep[]> {
  const steps: GrokWorkerDenyPathStep[] = [];
  for (const target of grokWorkerDenyPathChain(denyPath)) {
    try {
      steps.push({ path: target, entry: await lstat(target) });
    } catch (error) {
      steps.push({ path: target, code: (error as NodeJS.ErrnoException).code });
      break;
    }
  }
  const chain = grokWorkerDenyPathChain(denyPath);
  while (steps.length < chain.length) steps.push({ path: chain[steps.length]!, code: steps.at(-1)?.code ?? "EACCES" });
  return steps;
}

/**
 * Fails closed before a worker is ever launched with a profile Grok would
 * refuse. Callers with the widest view run it: root provisioning at container
 * start and on every slot recycle, and the direct (non-broker) path, which runs
 * as the worker uid itself.
 */
export async function assertGrokWorkerDenyPathsPlaceable(
  denyPaths: readonly string[],
  worker: GrokWorkerDenyPathWorker
): Promise<void> {
  for (const denyPath of denyPaths) {
    if (!path.posix.isAbsolute(denyPath)) throw new GrokWorkerDenyPlacementError(denyPath, "it is not an absolute path");
    assertGrokWorkerDenyPathPlacement(denyPath, await readGrokWorkerDenyPathChain(denyPath), worker);
  }
}
