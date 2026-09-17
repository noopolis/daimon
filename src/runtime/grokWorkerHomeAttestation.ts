import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";

type Entry = Pick<Stats, "uid" | "mode" | "nlink"> & Readonly<{ isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
const HOME = GROK_ENGINE_BROKER.worker.home;

/**
 * The worker must not be able to change what Grok reads before its next turn.
 *
 * Grok writes its own state (sessions, hooks, locks, docs) into `$GROK_HOME`,
 * so the directory is worker-group writable — but root-owned and sticky, so a
 * worker can neither rename nor unlink a root-owned file in it. Every file
 * that decides a turn's behaviour is root-owned with no write bit: `config.toml`
 * (model, effort, MCP, skills), `sandbox.toml`, `trusted_folders.toml` (trust
 * would re-enable cwd `AGENTS.md` and project skills), and the managed and
 * requirements layers that can override user config. A missing file fails
 * too: the worker could create it.
 *
 * Pure so every refusal is testable without root.
 */
export function assertGrokWorkerHomeEntries(entries: Readonly<Record<string, Entry | undefined>>): void {
  const directory = (entry: Entry | undefined): boolean =>
    entry !== undefined && entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === HOME.directory.uid
    && (Number(entry.mode) & 0o002) === 0 && ((Number(entry.mode) & 0o020) === 0 || (Number(entry.mode) & 0o1000) !== 0);
  if (!directory(entries["."]) || !directory(entries[HOME.sessionsDirectory.relativePath])) throw unavailable();
  for (const name of HOME.readOnlyFiles.names) {
    const entry = entries[name];
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink() || entry.uid !== HOME.readOnlyFiles.uid || entry.nlink !== 1 || (Number(entry.mode) & 0o7222) !== 0) throw unavailable();
  }
}

/** The worker's `config.toml` must be exactly the renderer's bytes for the declared policy. */
export function assertGrokWorkerConfigBytes(bytes: Uint8Array, configSha256: string): void {
  if (!/^[0-9a-f]{64}$/u.test(configSha256) || createHash("sha256").update(bytes).digest("hex") !== configSha256) throw unavailable();
}

/**
 * Attests the worker home layout and that `config.toml` is exactly the
 * renderer's bytes for the declared model policy (`configSha256`).
 */
export async function verifyGrokWorkerHome(grokHome: string, configSha256: string): Promise<void> {
  const entries: Record<string, Entry | undefined> = {};
  for (const name of [".", HOME.sessionsDirectory.relativePath, ...HOME.readOnlyFiles.names]) {
    try { entries[name] = await lstat(path.join(grokHome, name)); } catch { entries[name] = undefined; }
  }
  assertGrokWorkerHomeEntries(entries);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path.join(grokHome, "config.toml"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    const before = entries["config.toml"]!;
    if (!opened.isFile() || opened.size > 65_536 || opened.uid !== before.uid || opened.mode !== before.mode || opened.nlink !== 1) throw unavailable();
    assertGrokWorkerConfigBytes(await handle.readFile(), configSha256);
  } catch { throw unavailable(); } finally { await handle?.close().catch(() => undefined); }
}

const unavailable = (): Error => new Error("Grok worker isolation attestation unavailable");
