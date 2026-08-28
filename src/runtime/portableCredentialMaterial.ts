import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { ENGINE_CREDENTIAL_MATERIAL } from "./contractManifest.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const MAX_CREDENTIAL_BYTES = 64 * 1024;
type PortableAgent = OrganizationRuntimeAgentConfig & { engine: { kind: "codex" } };
type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
  uid: number;
}>;

/**
 * Seeds a runtime-writable CLI credential from Daimon's read-only ingress.
 * A newer runtime copy wins so a CLI refresh survives process/container
 * restarts; a later operator refresh of the ingress is imported on restart.
 */
export async function materializePortableCredential(
  configuredAgent: OrganizationRuntimeAgentConfig,
  runtimeHomePath: string
): Promise<"created" | "preserved" | "refreshed"> {
  if (configuredAgent.engine.kind !== "codex") {
    throw new Error(`agent ${configuredAgent.id} ${configuredAgent.engine.kind} has no portable credential material`);
  }
  const agent = configuredAgent as PortableAgent;
  const rule = ENGINE_CREDENTIAL_MATERIAL[agent.engine.kind];
  const sourcePath = contained(runtimeHomePath, rule.sourceRelativePath);
  const destinationPath = contained(runtimeHomePath, rule.destinationRelativePath);
  const destinationDirectory = path.dirname(destinationPath);
  await assertPrivateDirectory(path.dirname(sourcePath), rule.directoryMode, agent, false);
  const source = await readCredential(sourcePath, rule.fileMode, agent);
  await prepareDestinationDirectory(destinationDirectory, rule.directoryMode, agent);

  const existing = await existingCredential(destinationPath, rule.fileMode, agent);
  if (existing !== undefined && existing.mtimeMs >= source.identity.mtimeMs) return "preserved";

  const temporaryPath = path.join(destinationDirectory, `.${path.basename(destinationPath)}.${randomUUID()}.tmp`);
  let temporary: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(),
      rule.fileMode
    );
    await temporary.writeFile(source.bytes);
    await temporary.chmod(rule.fileMode);
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, destinationPath);
    await assertCredential(destinationPath, rule.fileMode, agent);
    return existing === undefined ? "created" : "refreshed";
  } catch (error) {
    throw unavailable(agent, error);
  } finally {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readCredential(
  filePath: string,
  mode: number,
  agent: PortableAgent
): Promise<{ bytes: Buffer; identity: FileIdentity }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await assertCredential(filePath, mode, agent);
    handle = await open(filePath, constants.O_RDONLY | noFollow());
    const opened = identity(await handle.stat());
    if (!sameIdentity(before, opened)) throw new Error("credential changed during import");
    const bytes = await handle.readFile();
    const after = identity(await handle.stat());
    if (!sameIdentity(before, after) || bytes.length !== before.size) {
      throw new Error("credential changed during import");
    }
    return { bytes, identity: before };
  } catch (error) {
    throw unavailable(agent, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function prepareDestinationDirectory(
  directoryPath: string,
  mode: number,
  agent: PortableAgent
): Promise<void> {
  try {
    await mkdir(directoryPath, { mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(agent, error);
  }
  await assertPrivateDirectory(directoryPath, mode, agent, true);
}

async function assertPrivateDirectory(
  directoryPath: string,
  mode: number,
  agent: PortableAgent,
  repairMode: boolean
): Promise<void> {
  try {
    const entry = await lstat(directoryPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()) {
      throw new Error("unsafe credential directory");
    }
    if (repairMode && (entry.mode & 0o777) !== mode) await chmod(directoryPath, mode);
    const secured = await lstat(directoryPath);
    if (!secured.isDirectory() || secured.isSymbolicLink() || secured.uid !== process.getuid?.()
      || (secured.mode & 0o777) !== mode) throw new Error("unsafe credential directory");
  } catch (error) {
    throw unavailable(agent, error);
  }
}

async function existingCredential(
  filePath: string,
  mode: number,
  agent: PortableAgent
): Promise<FileIdentity | undefined> {
  try {
    return await assertCredential(filePath, mode, agent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertCredential(
  filePath: string,
  mode: number,
  agent: PortableAgent
): Promise<FileIdentity> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw unavailable(agent, error);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || entry.nlink !== 1 || (entry.mode & 0o777) !== mode
    || entry.size === 0 || entry.size > MAX_CREDENTIAL_BYTES) {
    throw unavailable(agent, new Error("unsafe credential artifact"));
  }
  return identity(entry);
}

function contained(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  const relation = path.relative(path.resolve(root), candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("Daimon credential contract escapes the runtime home");
  }
  return candidate;
}

function identity(value: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  const numeric = value as typeof value & {
    dev: number;
    ino: number;
    mode: number;
    mtimeMs: number;
    size: number;
    uid: number;
  };
  return {
    dev: numeric.dev,
    ino: numeric.ino,
    mode: numeric.mode & 0o7777,
    mtimeMs: numeric.mtimeMs,
    size: numeric.size,
    uid: numeric.uid
  };
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs && left.size === right.size && left.uid === right.uid;
}
function noFollow(): number {
  return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}
function unavailable(agent: PortableAgent, _cause: unknown): Error {
  return new Error(`agent ${agent.id} ${agent.engine.kind} credential materialization failed`);
}
