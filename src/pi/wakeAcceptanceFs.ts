import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { open as openDirectory } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

import {
  WAKE_ACCEPTANCE_FILE,
  WAKE_ACCEPTANCE_FILE_BYTES_MAX
} from "./wakeAcceptanceSchema.js";
import { WakeAcceptanceError } from "./wakeAcceptanceSchema.js";

const UTF8 = "utf8";

const isNoEnt = (value: unknown): boolean =>
  Boolean(value && typeof value === "object" && "code" in value && (value as { code?: unknown }).code === "ENOENT");

const isEEXIST = (value: unknown): boolean =>
  Boolean(value && typeof value === "object" && "code" in value && (value as { code?: unknown }).code === "EEXIST");

const isExactMode = (mode: number, expected: number): boolean => (mode & 0o777) === expected;

const hasGroupOrWorldWrite = (mode: number): boolean => (mode & 0o022) !== 0;

const isSymbolic = (stats: Stats): boolean => stats.isSymbolicLink();

const safeDirectory = (stats: Stats): void => {
  if (!stats.isDirectory() || isSymbolic(stats) || hasGroupOrWorldWrite(stats.mode)) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }
};

const exactDirectory = (stats: Stats): void => {
  if (!stats.isDirectory() || isSymbolic(stats) || !isExactMode(stats.mode, 0o700)) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }
};

const exactFile = (stats: Stats): void => {
  if (!stats.isFile() || isSymbolic(stats) || !isExactMode(stats.mode, 0o600)) {
    throw new WakeAcceptanceError("wake_acceptance_store_corrupt");
  }
};

const syncDirectory = async (directoryPath: string): Promise<void> => {
  const handle = await openDirectory(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const markSafeToRelease = (
  error: WakeAcceptanceError,
  safeToRelease: boolean
): WakeAcceptanceError => {
  (error as WakeAcceptanceError & { safeToRelease: boolean }).safeToRelease = safeToRelease;
  return error;
};

const noEntAsSafe = (error: WakeAcceptanceError): WakeAcceptanceError =>
  markSafeToRelease(error, true);

const convertErr = (safeToRelease = true): WakeAcceptanceError =>
  markSafeToRelease(new WakeAcceptanceError("wake_acceptance_store_corrupt"), safeToRelease);

const runHook = async (
  hook: ((...args: string[]) => void | Promise<void>) | undefined,
  safeToRelease: boolean,
  ...args: string[]
): Promise<void> => {
  if (hook === undefined) return;
  try {
    await hook(...args);
  } catch {
    throw convertErr(safeToRelease);
  }
};

const stateTempPrefix = `${WAKE_ACCEPTANCE_FILE}.`;
const stateTempSuffix = ".tmp";
const isStateTempNamespace = (name: string): boolean =>
  name.startsWith(stateTempPrefix) && name.endsWith(stateTempSuffix);
const isOwnedStateTemp = (name: string): boolean =>
  isStateTempNamespace(name) && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    name.slice(stateTempPrefix.length, -stateTempSuffix.length)
  );

export interface WakeAcceptanceFsHooks {
  preWrite?: (tempPath: string) => void | Promise<void>;
  preSync?: (tempPath: string) => void | Promise<void>;
  preClose?: (tempPath: string) => void | Promise<void>;
  preRename?: (tempPath: string, finalPath: string) => void | Promise<void>;
  preDirectorySync?: (directoryPath: string) => void | Promise<void>;
  preClaimAcquire?: () => void | Promise<void>;
  preClaimRelease?: () => void | Promise<void>;
}

export interface WakeAcceptanceFsDependencies {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  readdir: typeof readdir;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
  syncDirectory: (directoryPath: string) => Promise<void>;
}

export interface WakeAcceptanceFsOptions {
  dependencies?: Partial<WakeAcceptanceFsDependencies>;
  hooks?: WakeAcceptanceFsHooks;
  randomUUID?: () => string;
}

export class WakeAcceptanceFs {
  readonly stateDirectoryPath: string;
  readonly stateFilePath: string;
  readonly lockPath: string;
  readonly deps: WakeAcceptanceFsDependencies;
  private readonly randomId: () => string;
  private readonly hooks: WakeAcceptanceFsHooks;

  constructor(readonly runtimeHomePath: string, options: WakeAcceptanceFsOptions = {}) {
    this.stateDirectoryPath = path.join(runtimeHomePath, ".wake-acceptance");
    this.stateFilePath = path.join(this.stateDirectoryPath, WAKE_ACCEPTANCE_FILE);
    this.lockPath = path.join(this.stateDirectoryPath, "claim.lock");
    this.randomId = options.randomUUID ?? randomUUID;
    this.hooks = options.hooks ?? {};
    this.deps = {
      lstat,
      mkdir,
      open,
      readdir,
      readFile,
      rename,
      unlink,
      syncDirectory,
      ...options.dependencies
    };
  }

  async assertRuntimeDirectory(): Promise<void> {
    try {
      const stat = await this.deps.lstat(this.runtimeHomePath);
      safeDirectory(stat);
      return;
    } catch (error) {
      if (!isNoEnt(error)) {
        throw convertErr();
      }
    }

    try {
      await this.deps.mkdir(this.runtimeHomePath, { mode: 0o700 });
      const stat = await this.deps.lstat(this.runtimeHomePath);
      safeDirectory(stat);
      return;
    } catch (error) {
      if (isEEXIST(error)) {
        try {
          const stat = await this.deps.lstat(this.runtimeHomePath);
          safeDirectory(stat);
          return;
        } catch (statsError) {
          if (statsError instanceof WakeAcceptanceError) {
            throw statsError;
          }
          throw convertErr();
        }
      }
      throw convertErr();
    }
  }

  async assertStoreDirectory(): Promise<void> {
    await this.assertRuntimeDirectory();

    try {
      const stats = await this.deps.lstat(this.stateDirectoryPath);
      exactDirectory(stats);
      return;
    } catch (error) {
      if (!isNoEnt(error)) {
        throw convertErr();
      }
    }

    try {
      await this.deps.mkdir(this.stateDirectoryPath, { mode: 0o700 });
      const stat = await this.deps.lstat(this.stateDirectoryPath);
      exactDirectory(stat);
    } catch (error) {
      if (isEEXIST(error)) {
        try {
          const stat = await this.deps.lstat(this.stateDirectoryPath);
          exactDirectory(stat);
          return;
        } catch (statsError) {
          if (statsError instanceof WakeAcceptanceError) {
            throw statsError;
          }
          throw convertErr();
        }
      }
      throw convertErr();
    }
  }

  async acquireClaim(): Promise<void> {
    await this.assertStoreDirectory();
    await runHook(this.hooks.preClaimAcquire, true);

    let acquiredHandle = false;
    let handle: FileHandle | undefined;

    try {
      handle = await this.deps.open(this.lockPath, "wx", 0o600);
      acquiredHandle = true;
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.deps.syncDirectory(this.stateDirectoryPath);
      return;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        handle = undefined;
      }
      if (isEEXIST(error) && !acquiredHandle) {
        try {
          const lockStat = await this.deps.lstat(this.lockPath);
          exactFile(lockStat);
          throw markSafeToRelease(new WakeAcceptanceError("wake_delivery_incomplete"), false);
        } catch (statsError) {
          if (statsError instanceof WakeAcceptanceError) {
            throw statsError;
          }
          throw convertErr();
        }
      }

      throw convertErr(false);
    }
  }

  async releaseClaim(): Promise<void> {
    try {
      await runHook(this.hooks.preClaimRelease, false);
      await this.deps.unlink(this.lockPath);
      await this.deps.syncDirectory(this.stateDirectoryPath);
    } catch (error) {
      if (error instanceof WakeAcceptanceError) {
        throw error;
      }
      throw convertErr(false);
    }
  }

  async readStateText(): Promise<string | undefined> {
    await this.assertStoreDirectory();

    try {
      const stats = await this.deps.lstat(this.stateFilePath);
      exactFile(stats);
      const body = await this.deps.readFile(this.stateFilePath, UTF8);
      if (Buffer.byteLength(body, UTF8) > WAKE_ACCEPTANCE_FILE_BYTES_MAX) {
        throw convertErr();
      }
      return body;
    } catch (error) {
      if (isNoEnt(error)) {
        return undefined;
      }
      if (error instanceof WakeAcceptanceError) {
        throw error;
      }
      throw convertErr();
    }
  }

  private async removeOwnedTemp(pathName: string): Promise<void> {
    try {
      const stats = await this.deps.lstat(pathName);
      exactFile(stats);
      await this.deps.unlink(pathName);
    } catch (error) {
      if (isNoEnt(error)) {
        return;
      }
      throw convertErr(false);
    }
  }

  async writeStateText(body: string): Promise<void> {
    if (Buffer.byteLength(body, UTF8) > WAKE_ACCEPTANCE_FILE_BYTES_MAX) {
      throw convertErr(true);
    }

    await this.assertStoreDirectory();

    const tempPath = `${this.stateFilePath}.${this.randomId()}.tmp`;
    let handle: FileHandle | undefined;
    let renamed = false;
    let tempCreated = false;

    try {
      handle = await this.deps.open(tempPath, "wx", 0o600);
      tempCreated = true;
      await handle.chmod(0o600);

      await runHook(this.hooks.preWrite, true, tempPath);

      await handle.writeFile(body, UTF8);
      await handle.sync();

      await runHook(this.hooks.preSync, true, tempPath);

      await runHook(this.hooks.preClose, true, tempPath);

      await handle.close();
      handle = undefined;

      await runHook(this.hooks.preRename, true, tempPath, this.stateFilePath);

      try {
        const finalStat = await this.deps.lstat(this.stateFilePath);
        exactFile(finalStat);
      } catch (error) {
        if (!isNoEnt(error)) {
          throw convertErr(true);
        }
      }

      await this.deps.rename(tempPath, this.stateFilePath);
      renamed = true;

      await runHook(this.hooks.preDirectorySync, true, this.stateDirectoryPath);
      await this.deps.syncDirectory(this.stateDirectoryPath);

      const finalStateStat = await this.deps.lstat(this.stateFilePath);
      exactFile(finalStateStat);
      return;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }

      let safeToRelease = true;
      if (!renamed && tempCreated) {
        try {
          await this.removeOwnedTemp(tempPath);
        } catch (cleanupError) {
          safeToRelease = false;
          if (cleanupError instanceof WakeAcceptanceError) {
            throw markSafeToRelease(cleanupError, false);
          }
          throw convertErr(false);
        }
      }

      safeToRelease = safeToRelease && !renamed;

      if (error instanceof WakeAcceptanceError) {
        throw markSafeToRelease(error, safeToRelease);
      }

      throw convertErr(safeToRelease);
    }
  }

  async cleanupTemps(): Promise<void> {
    await this.assertStoreDirectory();

    let entries: Dirent[] = [];
    try {
      entries = await this.deps.readdir(this.stateDirectoryPath, { withFileTypes: true });
    } catch (error) {
      if (isNoEnt(error)) {
        return;
      }
      throw convertErr();
    }

    for (const entry of entries) {
      if (!isStateTempNamespace(entry.name)) {
        continue;
      }
      if (!isOwnedStateTemp(entry.name)) throw convertErr(false);
      await this.removeOwnedTemp(path.join(this.stateDirectoryPath, entry.name));
    }
  }
}
