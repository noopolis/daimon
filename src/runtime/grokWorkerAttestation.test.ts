import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseGrokWorkerProfileApplied, parseGrokWorkerSandboxProfile } from "./grokWorkerAttestation.js";

const workspace="/var/lib/daimon-workers/2200/workspace";
const profileText=(denied:readonly string[]):string=>`[profiles.daimon-strict]\nextends = "strict"\nrestrict_network = true\ndeny = [${denied.map((entry)=>JSON.stringify(entry)).join(", ")}]\n`;
const sha256=(value:string):string=>createHash("sha256").update(Buffer.from(value)).digest("hex");
const event=(overrides:Record<string,unknown>={})=>Buffer.from(`${JSON.stringify({event_type:"ProfileApplied",profile:"daimon-strict",enforced:true,restrict_network:true,platform:"linux/landlock",workspace,...overrides})}\n`);

test("accepts only exact enforced cognition-worker profile evidence",()=>{
  assert.doesNotThrow(()=>parseGrokWorkerProfileApplied(event(),workspace));
  for(const invalid of [{enforced:false},{restrict_network:false},{platform:"darwin"},{profile:"strict"},{workspace:"/peer"}])assert.throws(()=>parseGrokWorkerProfileApplied(event(invalid),workspace),/attestation unavailable/u);
});

test("requires a complete final ProfileApplied event",()=>{
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
