import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export async function readGrokBrokerCredential(file: string): Promise<Readonly<{ accessToken: string; digest: string }>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined; let bytes: Buffer | undefined;
  try {
    const before = await lstat(file); assertFile(before); handle = await open(file, constants.O_RDONLY | noFollow()); const opened = await handle.stat(); assertFile(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(); bytes = await handle.readFile(); if (bytes.length > 64 * 1024) throw new Error(); const after = await handle.stat(); if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error();
    const root = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; const rows = Object.values(root).filter((value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value));
    if (rows.length !== 1 || typeof rows[0]!.key !== "string" || rows[0]!.key.length < 32 || typeof rows[0]!.refresh_token !== "string" || rows[0]!.refresh_token.length < 16) throw new Error();
    return { accessToken: rows[0]!.key, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch { throw new Error("Grok broker credential authority unavailable"); }
  finally { bytes?.fill(0); await handle?.close().catch(() => undefined); }
}
function assertFile(entry: Awaited<ReturnType<typeof lstat>>): void { if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.uid) !== process.getuid?.() || Number(entry.nlink) !== 1 || (Number(entry.mode) & 0o777) !== 0o600 || Number(entry.size) < 2 || Number(entry.size) > 64 * 1024) throw new Error(); }
function noFollow(): number { return constants.O_NOFOLLOW ?? 0; }
