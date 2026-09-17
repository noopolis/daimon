import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, link, mkdir, mkdtemp, open, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import {
  createGrokWorkerIsolationGuard,
  GrokWorkerAttestationFailure,
  prepareGrokWorkerAttestation,
  verifyGrokWorkerAttestation,
  type GrokWorkerAttestationSnapshot
} from "./grokWorkerAttestation.js";

const workspace = "/var/lib/daimon-workers/2200/workspace";
const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const applied = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ event_type: "ProfileApplied", profile: "daimon-strict", enforced: true, restrict_network: true, platform: "linux/landlock", workspace, deny_paths: [], ...overrides })}\n`;
const violation = `${JSON.stringify({ event_type: "FsViolation", profile: "daimon-strict", operation: "read", target: "/run/paideia/context.json" })}\n`;

const fixture = async (t: { after(fn: () => Promise<void>): void }, initial = "") => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daimon-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sandbox-events.jsonl");
  await writeFile(file, initial);
  await chmod(file, 0o640);
  const info = await stat(file);
  const before: GrokWorkerAttestationSnapshot = { dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), denyPaths: [] };
  const input = { eventsPath: file, workerUid: self.uid, brokerGid: self.gid, workspace };
  return { dir, file, before, input };
};
const refusal = async (run: Promise<unknown>): Promise<string> => {
  try { await run; } catch (error) {
    assert.ok(error instanceof GrokWorkerAttestationFailure, `expected a GrokWorkerAttestationFailure, got ${String(error)}`);
    return error.failureClass;
  }
  throw new Error("expected the attestation to be refused");
};

test("a turn refused at its first request stays refused after a conforming ProfileApplied is appended", async (t) => {
  // Before request 1 only the launcher-started Grok can have written events; a
  // line appended after it can come from a tool child and must never repair the turn.
  const { file, before, input } = await fixture(t);
  const guard = createGrokWorkerIsolationGuard(input, before);
  await appendFile(file, applied({ enforced: false }));
  assert.equal(await refusal(guard()), "profile_invalid");
  await appendFile(file, applied());
  assert.equal(await refusal(guard()), "profile_invalid");
  // Without the lock the same bytes would be accepted, so the refusal above is the lock's doing.
  await verifyGrokWorkerAttestation(input, before);
});

test("later requests need the accepted event at the same offset, not any newly appended one", async (t) => {
  const { file, before, input } = await fixture(t, "{\"event_type\":\"stale\"}\n");
  const guard = createGrokWorkerIsolationGuard(input, before);
  await appendFile(file, `${violation}${applied()}`);
  await guard();
  await appendFile(file, `${violation}${applied()}`);
  await guard();

  // Rewrite the accepted line in place (same length, different bytes) and append a fresh conforming one.
  const bytes = await readFile(file, "utf8");
  const acceptedAt = bytes.indexOf(applied());
  const handle = await open(file, "r+");
  try { await handle.write(Buffer.from(applied({ workspace: workspace.replace("workspace", "workspacX") })), 0, undefined, acceptedAt); } finally { await handle.close(); }
  await appendFile(file, applied());
  assert.equal(await refusal(guard()), "profile_invalid");
});

test("a truncated accepted event region is refused on the next request", async (t) => {
  const { file, before, input } = await fixture(t);
  const guard = createGrokWorkerIsolationGuard(input, before);
  await appendFile(file, applied());
  await guard();
  await truncate(file, 10);
  await appendFile(file, `\n${applied()}`);
  assert.equal(await refusal(guard()), "profile_invalid");
});
