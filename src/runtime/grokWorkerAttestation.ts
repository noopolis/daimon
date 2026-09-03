import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat,open } from "node:fs/promises";

type Snapshot=Readonly<{dev:number;ino:number;size:number;mtimeMs:number;denyPaths:readonly string[]}>;
export class GrokWorkerAttestationFailure extends Error { constructor(readonly failureClass:"profile_missing"|"profile_invalid"){super("Grok worker isolation attestation unavailable");} }
/**
 * Reads the `deny` list out of a worker sandbox profile, but only after the
 * bytes match `profileSha256` exactly.
 *
 * There is no minimum length. The floor used to be 3 (subscription realm,
 * bootstrap credential, peer roots), then 1, and an empty list is now the
 * *expected* shape: Grok 1.0.13 re-execs itself inside bubblewrap whenever
 * `deny` is non-empty and then opens each deny-path placeholder — which it
 * created at mode 000 — from a capability-stripped process, gets EACCES, and
 * refuses to start ("possible __GROK_INSIDE_BWRAP spoof") without ever
 * emitting a `ProfileApplied` event. Spawnfile therefore renders `deny = []`
 * and confines the worker with unix permissions plus builtin-`strict`
 * Landlock instead (`containerDaimonBrokerRender.ts`).
 *
 * The integrity guarantee is the hash pin, not the length. `profileSha256`
 * comes from `/etc/daimon-engine-broker/service.json`, which the root
 * provisioning phase writes `0440 root:2100` with `flag: 'wx'` and computes
 * from the same `profileFor()` bytes it writes to the profile; the broker
 * reads that config as uid 2100 and cannot rewrite it. A weaker profile
 * therefore cannot be attested: changing any byte — dropping
 * `restrict_network`, swapping `extends = "strict"` for a permissive base,
 * renaming the profile — changes the digest and fails here. And the deny list
 * this returns is not merely parsed and discarded: it is carried into the
 * snapshot and re-asserted against the kernel's own `ProfileApplied`
 * `deny_paths` by `parseGrokWorkerProfileApplied`, which independently
 * requires `enforced`, `restrict_network`, `platform === "linux/landlock"`
 * and the exact workspace. A length floor would only have caught a Spawnfile
 * rendering bug that produced a trivial profile *and* pinned it consistently
 * — and Spawnfile's own tests pin the rendered bytes.
 */
export function parseGrokWorkerSandboxProfile(bytes:Uint8Array,profileSha256:string):readonly string[]{
  // Never copy the caller's bytes: `prepareGrokWorkerAttestation` zeroes the
  // buffer it owns, and a private copy here would survive that.
  const buffer=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(createHash("sha256").update(buffer).digest("hex")!==profileSha256)throw new Error("Grok worker isolation attestation unavailable");
  const line=buffer.toString("utf8").split("\n").find((entry)=>entry.startsWith("deny = "));
  let parsed:unknown;
  try{parsed=JSON.parse(line?.slice(7)??"null");}catch{throw new Error("Grok worker isolation attestation unavailable");}
  if(!Array.isArray(parsed)||parsed.some((entry)=>typeof entry!=="string")||new Set(parsed).size!==parsed.length)throw new Error("Grok worker isolation attestation unavailable");
  return [...parsed as string[]].sort();
}
export async function prepareGrokWorkerAttestation(input:Readonly<{profilePath:string;eventsPath:string;profileSha256:string;workerUid:number;brokerGid:number}>):Promise<Snapshot>{
  const profile=await secureOpen(input.profilePath,0,0,0o444,65_536);let bytes:Buffer|undefined;let denyPaths:readonly string[]=[];try{bytes=await profile.readFile();denyPaths=parseGrokWorkerSandboxProfile(bytes,input.profileSha256);}catch{throw new Error("Grok worker isolation attestation unavailable");}finally{bytes?.fill(0);await profile.close();}
  const events=await secureOpen(input.eventsPath,input.workerUid,input.brokerGid,0o640,16*1024*1024);try{const stat=await events.stat();return{dev:Number(stat.dev),ino:Number(stat.ino),size:Number(stat.size),mtimeMs:Number(stat.mtimeMs),denyPaths};}finally{await events.close();}
}
export async function verifyGrokWorkerAttestation(input:Readonly<{eventsPath:string;workerUid:number;brokerGid:number;workspace:string}>,before:Snapshot):Promise<void>{
  let handle:Awaited<ReturnType<typeof secureOpen>>;try{handle=await secureOpen(input.eventsPath,input.workerUid,input.brokerGid,0o640,16*1024*1024);}catch{throw new GrokWorkerAttestationFailure("profile_invalid");}let bytes:Buffer|undefined;try{const stat=await handle.stat();if(Number(stat.dev)!==before.dev||Number(stat.ino)!==before.ino)throw new GrokWorkerAttestationFailure("profile_invalid");if(Number(stat.size)<=before.size)throw new GrokWorkerAttestationFailure("profile_missing");bytes=Buffer.alloc(Number(stat.size)-before.size);const read=await handle.read(bytes,0,bytes.length,before.size);if(read.bytesRead!==bytes.length)throw new GrokWorkerAttestationFailure("profile_invalid");const after=await handle.stat();if(Number(after.size)!==Number(stat.size)||Number(after.mtimeMs)!==Number(stat.mtimeMs))throw new GrokWorkerAttestationFailure("profile_invalid");parseGrokWorkerProfileApplied(bytes,input.workspace,before.denyPaths);}catch(error){if(error instanceof GrokWorkerAttestationFailure)throw error;throw new GrokWorkerAttestationFailure("profile_invalid");}finally{bytes?.fill(0);await handle.close();}
}
export function parseGrokWorkerProfileApplied(bytes:Uint8Array,workspace:string,denyPaths:readonly string[]=[]):void{try{const lines=Buffer.from(bytes).toString("utf8").trim().split("\n");const event=JSON.parse(lines.at(-1)??"null") as Record<string,unknown>|null;const observed=Array.isArray(event?.deny_paths)?event.deny_paths.filter((entry):entry is string=>typeof entry==="string").sort():[];if(event?.event_type!=="ProfileApplied"||event.profile!=="daimon-strict"||event.enforced!==true||event.restrict_network!==true||event.platform!=="linux/landlock"||event.workspace!==workspace||JSON.stringify(observed)!==JSON.stringify([...denyPaths].sort()))throw new Error();}catch{throw new Error("Grok worker isolation attestation unavailable");}}
async function secureOpen(file:string,uid:number,gid:number,mode:number,max:number,links=1){try{const before=await lstat(file);const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile()||stat.isSymbolicLink()||Number(stat.uid)!==uid||Number(stat.gid)!==gid||(Number(stat.mode)&0o777)!==mode||Number(stat.nlink)!==links||Number(stat.size)>max||before.dev!==stat.dev||before.ino!==stat.ino){await handle.close();throw new Error();}return handle;}catch{throw new Error("Grok worker isolation attestation unavailable");}}
