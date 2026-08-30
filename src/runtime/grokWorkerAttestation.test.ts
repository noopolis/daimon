import assert from "node:assert/strict";
import test from "node:test";
import { parseGrokWorkerProfileApplied } from "./grokWorkerAttestation.js";

const workspace="/var/lib/daimon-workers/2200/workspace";
const event=(overrides:Record<string,unknown>={})=>Buffer.from(`${JSON.stringify({event_type:"ProfileApplied",profile:"daimon-strict",enforced:true,restrict_network:true,platform:"linux/landlock",workspace,...overrides})}\n`);

test("accepts only exact enforced cognition-worker profile evidence",()=>{
  assert.doesNotThrow(()=>parseGrokWorkerProfileApplied(event(),workspace));
  for(const invalid of [{enforced:false},{restrict_network:false},{platform:"darwin"},{profile:"strict"},{workspace:"/peer"}])assert.throws(()=>parseGrokWorkerProfileApplied(event(invalid),workspace),/attestation unavailable/u);
});

test("requires a complete final ProfileApplied event",()=>{
  assert.throws(()=>parseGrokWorkerProfileApplied(Buffer.from('{"event_type":"ProfileApplied"'),workspace),/attestation unavailable/u);
  assert.throws(()=>parseGrokWorkerProfileApplied(Buffer.from('{}\n'),workspace),/attestation unavailable/u);
});
