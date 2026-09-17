import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, link, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import {
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

test("refuses an events file with a second hard link", async (t) => {
  const { dir, file, before, input } = await fixture(t);
  await appendFile(file, applied());
  await verifyGrokWorkerAttestation(input, before);
  await link(file, path.join(dir, "second-name.jsonl"));
  assert.equal(await refusal(verifyGrokWorkerAttestation(input, before)), "profile_invalid");
});

test("refuses events that change while they are being read", async (t) => {
  const { file, before, input } = await fixture(t);
  await appendFile(file, applied());
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = prototype.read;
  const reading = mock.method(prototype, "read", async function (this: unknown, ...args: unknown[]) {
    const result = await original.apply(this, args);
    await appendFile(file, violation);
    return result;
  });
  try { assert.equal(await refusal(verifyGrokWorkerAttestation(input, before)), "profile_invalid"); } finally { reading.mock.restore(); }
  assert.ok(reading.mock.callCount() >= 1);
});

test("prepare refuses a worker home that fails attestation even when profile, temp and events are valid", async (t) => {
  // Run as a non-root owner so the profile, temp and events legs pass; the home
  // leg (root-owned, read-only config) cannot, and must be what refuses.
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-guard-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, ".grok");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { mode: 0o700 });
  const profile = path.join(home, "sandbox.toml");
  const text = '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = []\n';
  await writeFile(profile, text); await chmod(profile, 0o444);
  const events = path.join(home, "sessions", "sandbox-events.jsonl");
  await writeFile(events, ""); await chmod(events, 0o640);
  const input = { profilePath: profile, eventsPath: events, profileSha256: createHash("sha256").update(text).digest("hex"), workerUid: self.uid, brokerGid: self.gid, configSha256: "0".repeat(64) };
  await assert.rejects(prepareGrokWorkerAttestation(input, { uid: self.uid, gid: Number((await stat(profile)).gid), sharedTmpRoots: [] }), (error: Error) => error.message === "Grok worker isolation attestation unavailable");
});

test("prepare refuses a worker without a private temp directory before the home check", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-guard-tmp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grokHome = path.join(root, ".grok");
  await mkdir(path.join(grokHome, "sessions"), { recursive: true });
  const profile = path.join(grokHome, "sandbox.toml");
  const text = '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = []\n';
  await writeFile(profile, text); await chmod(profile, 0o444);
  const events = path.join(grokHome, "sessions", "sandbox-events.jsonl");
  await writeFile(events, ""); await chmod(events, 0o640);
  const input = { profilePath: profile, eventsPath: events, profileSha256: createHash("sha256").update(text).digest("hex"), workerUid: self.uid, brokerGid: self.gid, configSha256: "0".repeat(64) };
  const owner = { uid: self.uid, gid: Number((await stat(profile)).gid) };
  // No <home>/tmp: the temp leg refuses (the home leg would refuse too, with a different message).
  await assert.rejects(prepareGrokWorkerAttestation(input, owner), /temp isolation attestation unavailable/u);
  // A profile outside <home>/.grok cannot name the launcher's TMPDIR home.
  await mkdir(path.join(root, "elsewhere", "sessions"), { recursive: true });
  const stray = { ...input, profilePath: path.join(root, "elsewhere", "sandbox.toml"), eventsPath: path.join(root, "elsewhere", "sessions", "sandbox-events.jsonl") };
  await writeFile(stray.profilePath, text); await chmod(stray.profilePath, 0o444); await writeFile(stray.eventsPath, ""); await chmod(stray.eventsPath, 0o640);
  await assert.rejects(prepareGrokWorkerAttestation(stray, owner), (error: Error) => /attestation unavailable/u.test(error.message) && !/temp/u.test(error.message));
});
