import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GrokWorkerAttestationFailure,
  parseGrokWorkerProfileApplied,
  parseGrokWorkerSandboxProfile,
  prepareGrokWorkerAttestation,
  verifyGrokWorkerAttestation,
  type GrokWorkerAttestationSnapshot
} from "./grokWorkerAttestation.js";

const workspace="/var/lib/daimon-workers/2200/workspace";
const profileText=(denied:readonly string[]):string=>`[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = [${denied.map((entry)=>JSON.stringify(entry)).join(", ")}]\n`;
const sha256=(value:string):string=>createHash("sha256").update(Buffer.from(value)).digest("hex");
const event=(overrides:Record<string,unknown>={})=>Buffer.from(`${JSON.stringify({event_type:"ProfileApplied",profile:"daimon-strict",enforced:true,restrict_network:true,platform:"linux/landlock",workspace,...overrides})}\n`);

test("accepts only exact enforced cognition-worker profile evidence",()=>{
  assert.doesNotThrow(()=>parseGrokWorkerProfileApplied(event(),workspace));
  for(const invalid of [{enforced:false},{restrict_network:false},{platform:"darwin"},{profile:"strict"},{workspace:"/peer"}])assert.throws(()=>parseGrokWorkerProfileApplied(event(invalid),workspace),/attestation unavailable/u);
});

test("requires a complete, conforming ProfileApplied event somewhere in the region",()=>{
  assert.throws(()=>parseGrokWorkerProfileApplied(Buffer.from('{"event_type":"ProfileApplied"'),workspace),/attestation unavailable/u);
  assert.throws(()=>parseGrokWorkerProfileApplied(Buffer.from('{}\n'),workspace),/attestation unavailable/u);
});

// Grok 1.0.13 refuses to start on any non-empty `deny` list — it opens each
// mode-000 placeholder from a capability-stripped bwrap re-exec, gets EACCES,
// and treats that as a spoofed sandbox — so Spawnfile renders `deny = []` and
// confines the worker with unix permissions plus builtin-strict Landlock.
// There is no length floor left; the hash pin is the whole guarantee.
test("accepts an empty deny list whose bytes match the pinned digest",()=>{
  const profile=profileText([]);
  assert.equal(profile.includes("deny = []\n"),true);
  assert.deepEqual(parseGrokWorkerSandboxProfile(Buffer.from(profile),sha256(profile)),[]);
});

test("accepts a populated deny list and returns it sorted",()=>{
  const profile=profileText(["/z/second","/a/first"]);
  assert.deepEqual(parseGrokWorkerSandboxProfile(Buffer.from(profile),sha256(profile)),["/a/first","/z/second"]);
});

// Mutation-critical: delete the `createHash(...) !== profileSha256` comparison
// in `parseGrokWorkerSandboxProfile` and this test must go red. Lowering the
// floor to zero leaves this pin as the only thing standing between the worker
// and an attacker-chosen profile, so it must have a failing test of its own.
test("rejects a profile whose bytes do not match the pinned digest",()=>{
  const pinned=profileText([]);
  for(const tampered of [
    profileText(["/anything"]),
    pinned.replace("restrict_network = true","restrict_network = false"),
    pinned.replace('extends = "strict"','extends = "permissive"'),
    pinned.replace("[profiles.daimon-strict]","[profiles.daimon-loose]"),
    `${pinned}\n`
  ]){
    assert.notEqual(sha256(tampered),sha256(pinned));
    assert.throws(()=>parseGrokWorkerSandboxProfile(Buffer.from(tampered),sha256(pinned)),/attestation unavailable/u);
  }
});

test("rejects a profile with no deny line or a malformed one, even when the digest matches",()=>{
  for(const invalid of [
    '[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\n',
    'deny = ["/a", "/a"]\n',
    'deny = ["/a", 7]\n',
    'deny = {}\n',
    'deny = [\n'
  ]){
    assert.throws(()=>parseGrokWorkerSandboxProfile(Buffer.from(invalid),sha256(invalid)),/attestation unavailable/u);
  }
});

// ---------------------------------------------------------------------------
// `prepareGrokWorkerAttestation` / `verifyGrokWorkerAttestation` / `secureOpen`
// had no unit tests at all, so the freshness watermark and the events-file
// inode pin — the kernel-side half of the isolation guarantee, the half the
// hash pin does NOT cover — were defended by code reading alone. Both are
// mutation-locked below.
//
// The profile leg of `prepare` demands uid 0 / gid 0 / 0444 and cannot be
// exercised without root; its rejection paths are covered here instead, and
// the events leg is covered in full because it expects the caller's own uid.
const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const applied = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ event_type: "ProfileApplied", profile: "daimon-strict", enforced: true, restrict_network: true, platform: "linux/landlock", workspace, deny_paths: [], ...overrides });
// Grok 1.0.13's real violation shape: same file, same writer, fields taken
// from the binary's own record vocabulary.
const violation = (event_type: string): string =>
  JSON.stringify({ event_type, timestamp: "2026-09-04T00:00:00Z", operation: "file-read", target: "/etc/shadow", command: "cat", tool_call_id: "call_1" });

const workspaceDir = async (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "daimon-attest-"));
const eventsFile = async (dir: string, initial = ""): Promise<string> => {
  const file = path.join(dir, "sandbox-events.jsonl");
  await writeFile(file, initial);
  await chmod(file, 0o640);
  return file;
};
const watermark = async (file: string, denyPaths: readonly string[] = []): Promise<GrokWorkerAttestationSnapshot> => {
  const info = await stat(file);
  return { dev: Number(info.dev), ino: Number(info.ino), size: Number(info.size), mtimeMs: Number(info.mtimeMs), denyPaths };
};
const verify = (eventsPath: string, before: GrokWorkerAttestationSnapshot, brokerGid = self.gid): Promise<void> =>
  verifyGrokWorkerAttestation({ eventsPath, workerUid: self.uid, brokerGid, workspace }, before);
const failureClass = async (run: Promise<unknown>): Promise<string> => {
  try { await run; } catch (error) {
    assert.ok(error instanceof GrokWorkerAttestationFailure, `expected a GrokWorkerAttestationFailure, got ${String(error)}`);
    return error.failureClass;
  }
  throw new Error("expected the attestation to be refused");
};

test("accepts a ProfileApplied that a later sandbox violation follows", async (t) => {
  // The regression this whole change exists for. Grok logs ProfileApplied,
  // FsViolation, NetViolation, ApplyFailed, BypassGranted and BypassDenied to
  // one file (confirmed against the 1.0.13 binary), so under the old
  // last-line rule the first denied access in a turn made the next model call
  // refuse and killed the turn. Mutation-critical: restoring `lines.at(-1)`
  // must turn this red.
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await eventsFile(dir);
  const before = await watermark(file);
  await appendFile(file, `${applied()}\n${violation("FsViolation")}\n${violation("NetViolation")}\n`);
  await verify(file, before);
});

test("accepts a ProfileApplied that violations precede, and refuses a fresh region with no ProfileApplied at all", async (t) => {
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await eventsFile(dir);
  const before = await watermark(file);
  await appendFile(file, `${violation("BypassDenied")}\n${applied()}\n`);
  await verify(file, before);

  const other = await eventsFile(await workspaceDir());
  const otherBefore = await watermark(other);
  await appendFile(other, `${violation("FsViolation")}\n${violation("ApplyFailed")}\n`);
  assert.equal(await failureClass(verify(other, otherBefore)), "profile_invalid");
});

test("refuses a ProfileApplied that is only a replay from below the freshness watermark", async (t) => {
  // Mutation-critical for the watermark: read the whole file instead of only
  // `stat.size - before.size` bytes from offset `before.size` and this goes
  // green, because the previous turn's perfectly valid ProfileApplied comes
  // back into view.
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await eventsFile(dir, `${applied()}\n`);
  const before = await watermark(file);
  await appendFile(file, `${violation("FsViolation")}\n`);
  assert.equal(await failureClass(verify(file, before)), "profile_invalid");
});

test("refuses an events file that did not grow, or that shrank below the watermark", async (t) => {
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await eventsFile(dir, `${applied()}\n`);
  const before = await watermark(file);
  assert.equal(await failureClass(verify(file, before)), "profile_missing");
  await truncate(file, 4);
  assert.equal(await failureClass(verify(file, before)), "profile_missing");
});

test("refuses an events file whose inode is not the one the watermark pinned", async (t) => {
  // Mutation-critical: delete the dev/ino comparison and this goes green. A
  // worker that unlinks the attested file and drops a fresh one in its place
  // would otherwise attest that replacement.
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await eventsFile(dir);
  const before = await watermark(file);
  await appendFile(file, `${applied()}\n`);
  assert.equal(await failureClass(verify(file, { ...before, ino: before.ino + 1 })), "profile_invalid");
  assert.equal(await failureClass(verify(file, { ...before, dev: before.dev + 1 })), "profile_invalid");
  await verify(file, before);
});

test("refuses an events file a worker replaced, a symlink, a FIFO, or a widened mode", async (t) => {
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await eventsFile(dir);
  const before = await watermark(file);
  await appendFile(file, `${applied()}\n`);

  // A worker-created replacement carries the worker's own gid, not the
  // broker's, which is what `secureOpen`'s owner check is for.
  assert.equal(await failureClass(verify(file, before, self.gid + 1)), "profile_invalid");
  await chmod(file, 0o644);
  assert.equal(await failureClass(verify(file, before)), "profile_invalid");
  await chmod(file, 0o640);

  const link = path.join(dir, "linked-events.jsonl");
  await symlink(file, link);
  assert.equal(await failureClass(verify(link, await watermark(file))), "profile_invalid");

  // `secureOpen` opens O_NONBLOCK precisely so this returns instead of
  // blocking forever on a FIFO the worker planted; four such hangs would
  // starve libuv's threadpool and stop the whole broker. Bounded so a
  // regression fails the test rather than hanging the suite.
  const fifo = path.join(dir, "fifo-events.jsonl");
  execFileSync("mkfifo", ["-m", "640", fifo]);
  const timer = setTimeout(() => undefined, 5_000);
  const refused = await Promise.race([
    failureClass(verify(fifo, await watermark(fifo))),
    new Promise<string>((resolve) => { timer.refresh(); setTimeout(() => resolve("blocked"), 5_000).unref(); })
  ]);
  clearTimeout(timer);
  assert.equal(refused, "profile_invalid");
});

test("refuses a sandbox profile that is not root-owned, and one reached through a symlink", async (t) => {
  const dir = await workspaceDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = path.join(dir, "sandbox.toml");
  const text = `[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = []\n`;
  await writeFile(profile, text);
  await chmod(profile, 0o444);
  const events = await eventsFile(dir);
  const input = { profilePath: profile, eventsPath: events, profileSha256: sha256(text), workerUid: self.uid, brokerGid: self.gid };
  // Owned by the test user rather than root: `secureOpen` must refuse it even
  // though its bytes hash correctly.
  await assert.rejects(prepareGrokWorkerAttestation(input), /attestation unavailable/u);
  const link = path.join(dir, "linked-sandbox.toml");
  await symlink(profile, link);
  await assert.rejects(prepareGrokWorkerAttestation({ ...input, profilePath: link }), /attestation unavailable/u);
});

test("holds the kernel's reported deny_paths to exactly what the pinned profile declared", () => {
  // With today's `deny = []` this comparison is vacuous — `[]` against `[]`
  // — so a mutation that deletes it stays green against every other test
  // here. Exercise it against a populated list so the guarantee is locked
  // for the day a deny path can be used again, and so "the kernel applied
  // fewer denies than the profile declared" is a tested rejection rather
  // than an asserted one.
  const bytes = (denyPaths: readonly string[]) => Buffer.from(`${applied({ deny_paths: denyPaths })}\n`);
  assert.doesNotThrow(() => parseGrokWorkerProfileApplied(bytes(["/b", "/a"]), workspace, ["/a", "/b"]));
  for (const observed of [[], ["/a"], ["/a", "/b", "/c"], ["/a", "/z"]]) {
    assert.throws(() => parseGrokWorkerProfileApplied(bytes(observed), workspace, ["/a", "/b"]), /attestation unavailable/u);
  }
  assert.throws(() => parseGrokWorkerProfileApplied(bytes(["/a"]), workspace, []), /attestation unavailable/u);
});
