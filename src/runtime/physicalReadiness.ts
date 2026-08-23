import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

type Identity = Readonly<{ dev: number; ino: number; uid: number; mode: number }>;
type Directory = { readonly configured: string; readonly real: string; readonly fd: Awaited<ReturnType<typeof open>>; readonly identity: Identity; closed: boolean };

/**
 * Holds identities for caller-created roots. Daimon neither creates nor rolls
 * back these directories: the deployer owns their lifecycle and contents.
 */
export type OrganizationRuntimePathAuthority = Readonly<{
  forAgent(agent: OrganizationRuntimeAgentConfig): Readonly<{
    workspacePath: string;
    runtimeHomePath: string;
    verify(): Promise<void>;
  }>;
  close(): Promise<void>;
}>;

export async function prepareOrganizationRuntimePaths(
  agents: readonly OrganizationRuntimeAgentConfig[]
): Promise<OrganizationRuntimePathAuthority> {
  const workspaces = new Map<string, Directory>();
  const homes = new Map<string, Directory>();
  try {
    for (const agent of agents) {
      workspaces.set(agent.id, await verifyDirectory(agent.workspacePath, "workspacePath", "safe"));
      homes.set(agent.id, await verifyDirectory(agent.runtimeHomePath, "runtimeHomePath", "private"));
    }
    const roots = [...workspaces.values(), ...homes.values()];
    for (let left = 0; left < roots.length; left += 1) for (let right = left + 1; right < roots.length; right += 1) {
      const first = roots[left]!;
      const second = roots[right]!;
      if (sameIdentity(first.identity, second.identity) || overlaps(first.real, second.real)) {
        throw new Error(`physical runtime paths overlap: ${first.configured} and ${second.configured}`);
      }
    }
  } catch (error) {
    const closeError = await closeAll([...workspaces.values(), ...homes.values()]);
    if (closeError !== undefined) throw new AggregateError([error, closeError], "runtime path validation cleanup failed");
    throw error;
  }
  let closed = false;
  const verify = async (agent: OrganizationRuntimeAgentConfig): Promise<void> => {
    if (closed) throw new Error("runtime path authority is closed");
    const workspace = workspaces.get(agent.id);
    const home = homes.get(agent.id);
    if (workspace === undefined || home === undefined) throw new Error(`no runtime path authority for ${agent.id}`);
    await Promise.all([
      verifyIdentity(workspace, "workspacePath", "safe"),
      verifyIdentity(home, "runtimeHomePath", "private")
    ]);
  };
  return {
    forAgent(agent) {
      const workspace = workspaces.get(agent.id);
      const home = homes.get(agent.id);
      if (workspace === undefined || home === undefined) throw new Error(`no runtime path authority for ${agent.id}`);
      return { workspacePath: workspace.real, runtimeHomePath: home.real, verify: () => verify(agent) };
    },
    async close() {
      if (closed) return;
      const failure = await closeAll([...workspaces.values(), ...homes.values()]);
      if (failure !== undefined) throw failure;
      closed = true;
    }
  };
}

async function verifyDirectory(configured: string, label: string, mode: "safe" | "private"): Promise<Directory> {
  await assertNoSymlinkComponents(configured);
  const before = await lstat(configured);
  assertDirectory(before, label, mode);
  const fd = await open(configured, constants.O_RDONLY | directoryFlag() | noFollow());
  try {
    const opened = await fd.stat();
    const real = await realpath(configured);
    const after = await lstat(configured);
    if (!sameIdentity(identity(before), identity(opened)) || !sameIdentity(identity(before), identity(after))) {
      throw new Error(`${label} changed during validation`);
    }
    return { configured, real, fd, identity: identity(before), closed: false };
  } catch (error) {
    await fd.close().catch(() => undefined);
    throw error;
  }
}

async function verifyIdentity(directory: Directory, label: string, mode: "safe" | "private"): Promise<void> {
  if (directory.closed) throw new Error(`${label} authority is closed`);
  await assertNoSymlinkComponents(directory.configured);
  const entry = await lstat(directory.configured);
  const opened = await directory.fd.stat();
  if (!sameIdentity(identity(entry), directory.identity) || !sameIdentity(identity(opened), directory.identity)) {
    throw new Error(`${label} changed after readiness validation`);
  }
  assertDirectory(entry, label, mode);
  if (await realpath(directory.configured) !== directory.real) throw new Error(`${label} changed after readiness validation`);
}

async function assertNoSymlinkComponents(target: string): Promise<void> {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of path.relative(parsed.root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    // macOS exposes /var as a system compatibility symlink to /private/var.
    // It is an OS-root alias, not a caller-controlled component.
    if ((await lstat(current)).isSymbolicLink() && current !== "/var") throw new Error(`path contains symlink: ${current}`);
  }
}

function assertDirectory(entry: Stats, label: string, mode: "safe" | "private"): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be an existing real directory`);
  if (entry.uid !== process.getuid?.()) throw new Error(`${label} must be owned by the runtime user`);
  const permissions = entry.mode & 0o777;
  if (mode === "private" && permissions !== 0o700) throw new Error(`${label} must have mode 0700`);
  if (mode === "safe" && (permissions & 0o022) !== 0) throw new Error(`${label} must not grant group or other write access`);
}

function identity(entry: Stats): Identity { return { dev: entry.dev, ino: entry.ino, uid: entry.uid, mode: entry.mode & 0o7777 }; }
function sameIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode; }
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`); }
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }
function directoryFlag(): number { return (constants as typeof constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0; }
async function closeAll(directories: readonly Directory[]): Promise<AggregateError | undefined> {
  const results = await Promise.allSettled(directories.filter((directory) => !directory.closed).map(async (directory) => {
    await directory.fd.close();
    directory.closed = true;
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  return failures.length === 0 ? undefined : new AggregateError(failures, "runtime path authority cleanup failed");
}
