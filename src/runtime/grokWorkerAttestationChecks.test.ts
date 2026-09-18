import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, link, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import {
    GrokWorkerAttestationFailure,
  grokBrokerAttestationInput,
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
  await assert.rejects(prepareGrokWorkerAttestation(input, { uid: self.uid, gid: Number((await stat(profile)).gid), tmp: { sharedRoots: [root], sharedOwnerUid: self.uid, firstWorkerUid: self.uid } }), (error: Error) => error.message === "Grok worker isolation attestation unavailable");
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

test("prepare refuses the current turn when a sibling registered worker's private temp is 0777", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-guard-sibling-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (name: string) => {
    const home = path.join(root, name), grok = path.join(home, ".grok");
    await mkdir(path.join(grok, "sessions"), { recursive: true }); await mkdir(path.join(home, "tmp"), { mode: 0o700 });
    return { home, profile: path.join(grok, "sandbox.toml"), events: path.join(grok, "sessions", "sandbox-events.jsonl") };
  };
  const own = await make("own"), sibling = await make("sibling");
  const text = '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = []\n';
  await writeFile(own.profile, text); await chmod(own.profile, 0o444);
  await writeFile(own.events, ""); await chmod(own.events, 0o640);
  const registration = { profilePath: own.profile, eventsPath: own.events, profileSha256: createHash("sha256").update(text).digest("hex"), workerUid: self.uid, workspace: "/w" };
  const input = grokBrokerAttestationInput(registration, [registration, { profilePath: sibling.profile, workerUid: self.uid }], "0".repeat(64));
  assert.deepEqual(input.registeredWorkers.map((entry) => entry.profilePath), [own.profile, sibling.profile]);
  const seams = { uid: self.uid, gid: Number((await stat(own.profile)).gid), tmp: { sharedRoots: [root], sharedOwnerUid: self.uid, firstWorkerUid: self.uid } };
  await chmod(root, 0o700);
  // Sibling well provisioned: temp passes and the (root-only) home leg is what refuses.
  await assert.rejects(prepareGrokWorkerAttestation({ ...input, brokerGid: self.gid }, seams), (error: Error) => error.message === "Grok worker isolation attestation unavailable");
  await chmod(path.join(sibling.home, "tmp"), 0o777);
  await assert.rejects(prepareGrokWorkerAttestation({ ...input, brokerGid: self.gid }, seams), /temp isolation attestation unavailable/u);
});

test("prepare refuses a deny entry bubblewrap could not materialize, before any other leg", async (t) => {
  // The production defect: the wake-acceptance store sits under a `0700` organization state directory,
  // so bubblewrap — which materializes every deny target as the worker uid — could not create it and
  // Grok refused the whole profile, failing every turn with `bwrap: Can't create file at …`.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "daimon-guard-deny-")));
  t.after(async () => { await chmod(path.join(root, "state"), 0o700); await rm(root, { recursive: true, force: true }); });
  const grokHome = path.join(root, ".grok");
  await mkdir(path.join(grokHome, "sessions"), { recursive: true });
  await mkdir(path.join(root, "tmp"), { mode: 0o700 });
  await mkdir(path.join(root, "state", "wake-acceptance"), { recursive: true });
  const profile = path.join(grokHome, "sandbox.toml");
  const events = path.join(grokHome, "sessions", "sandbox-events.jsonl");
  await writeFile(events, ""); await chmod(events, 0o640);
  const owner = { uid: self.uid, gid: Number((await stat(path.join(root, "tmp"))).gid) };
  const withDeny = async (denied: string) => {
    const text = `[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = ["${denied}"]\n`;
    await chmod(profile, 0o644).catch(() => undefined);
    await writeFile(profile, text); await chmod(profile, 0o444);
    return { profilePath: profile, eventsPath: events, profileSha256: createHash("sha256").update(text).digest("hex"), workerUid: self.uid, brokerGid: self.gid, configSha256: "0".repeat(64) };
  };
  await chmod(path.join(root, "state"), 0o600);
  await assert.rejects(
    prepareGrokWorkerAttestation(await withDeny(path.join(root, "state", "wake-acceptance")), owner),
    (error: Error) => /is not placeable/u.test(error.message) && error.message.includes(`cannot search ${path.join(root, "state")}`)
  );
  // The lift: the private directory itself is placeable, so this leg passes and a later one refuses.
  await assert.rejects(
    prepareGrokWorkerAttestation(await withDeny(path.join(root, "state")), owner),
    (error: Error) => !/is not placeable/u.test(error.message)
  );
});
