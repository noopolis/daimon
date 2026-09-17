import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat,open } from "node:fs/promises";
import path from "node:path";

import { verifyGrokWorkerHome } from "./grokWorkerHomeAttestation.js";
import { grokWorkerEventsPathFor } from "./grokWorkerSandboxProfile.js";

/**
 * The per-turn freshness watermark taken before the worker is launched: the
 * exact inode and its byte length at that moment. Everything at or below
 * `size` is pre-turn history and is never read back — a `ProfileApplied` down
 * there is a replay, not evidence about this turn.
 */
export type GrokWorkerAttestationSnapshot=Readonly<{dev:number;ino:number;size:number;denyPaths:readonly string[]}>;
type Snapshot=GrokWorkerAttestationSnapshot;
export class GrokWorkerAttestationFailure extends Error { constructor(readonly failureClass:"profile_missing"|"profile_invalid"){super("Grok worker isolation attestation unavailable");} }
/**
 * Reads the `deny` list out of a worker sandbox profile, but only after the
 * bytes match `profileSha256` exactly.
 *
 * There is no minimum length, and a populated list is supported. Grok 1.0.13
 * refused to start on any non-empty `deny` (its mode-000 placeholders failed
 * an EACCES "__GROK_INSIDE_BWRAP spoof" check), so deployments rendered
 * `deny = []`. Grok 1.0.34 runs every profile inside bubblewrap and enforces a
 * non-empty list, and since its strict base reads all of `/run`, `/var` and
 * `/tmp`, the deny list is what keeps evaluator and host-bind paths away from
 * the worker. `grokWorkerSandboxProfile.ts` renders these bytes.
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
/**
 * Pre-launch half of the per-turn attestation. Besides the pinned profile and
 * the events watermark it requires the 1.0.34 layout: events under
 * `$GROK_HOME/sessions/` (the root `sandbox-events.jsonl` stays empty on
 * 1.0.34), and a root-owned read-only worker home whose `config.toml` hashes to
 * the declared renderer output (`grokWorkerHomeAttestation.ts`).
 */
export async function prepareGrokWorkerAttestation(input:Readonly<{profilePath:string;eventsPath:string;profileSha256:string;workerUid:number;brokerGid:number;configSha256:string}>,profileOwner:Readonly<{uid:number;gid:number}>={uid:0,gid:0}):Promise<Snapshot>{
  if(input.eventsPath!==grokWorkerEventsPathFor(input.profilePath))throw new Error("Grok worker sandbox events must be read from $GROK_HOME/sessions/sandbox-events.jsonl");
  const profile=await secureOpen(input.profilePath,profileOwner.uid,profileOwner.gid,0o444,65_536);let bytes:Buffer|undefined;let denyPaths:readonly string[]=[];try{bytes=await profile.readFile();denyPaths=parseGrokWorkerSandboxProfile(bytes,input.profileSha256);}catch{throw new Error("Grok worker isolation attestation unavailable");}finally{bytes?.fill(0);await profile.close();}
  await verifyGrokWorkerHome(path.dirname(input.profilePath),input.configSha256);
  const events=await secureOpen(input.eventsPath,input.workerUid,input.brokerGid,0o640,16*1024*1024);try{const stat=await events.stat();return{dev:Number(stat.dev),ino:Number(stat.ino),size:Number(stat.size),denyPaths};}finally{await events.close();}
}
/**
 * The accepted `ProfileApplied` line of one turn, as an absolute byte range of
 * the events file plus its digest.
 */
export type GrokWorkerAttestationLock={accepted?:Readonly<{offset:number;length:number;digest:string}>;refused?:GrokWorkerAttestationFailure["failureClass"]};

/**
 * The per-turn isolation guard: every model request of a turn, and the
 * post-turn check, go through the same lock.
 *
 * Why the first verification is trustworthy: the proxy awaits this guard before
 * *every* upstream request, including the first, and the only worker-uid
 * process that exists before request 1 is the Grok the launcher started under
 * the pinned profile — tool children are created only after a model response.
 * So the event accepted at request 1 was written before any tool child could
 * write to the (worker-owned) events file. Later requests must find that exact
 * line, byte for byte, at the same offset: a `ProfileApplied` appended later —
 * which a tool child could forge — is never a substitute, and once a turn has
 * been refused it stays refused.
 */
export function createGrokWorkerIsolationGuard(input:Parameters<typeof verifyGrokWorkerAttestation>[0],before:Snapshot):()=>Promise<void>{
  const lock:GrokWorkerAttestationLock={};
  return async()=>{
    if(lock.refused!==undefined)throw new GrokWorkerAttestationFailure(lock.refused);
    try{await verifyGrokWorkerAttestation(input,before,lock);}
    catch(error){const failure=error instanceof GrokWorkerAttestationFailure?error:new GrokWorkerAttestationFailure("profile_invalid");lock.refused=failure.failureClass;throw failure;}
  };
}
export async function verifyGrokWorkerAttestation(input:Readonly<{eventsPath:string;workerUid:number;brokerGid:number;workspace:string}>,before:Snapshot,lock?:GrokWorkerAttestationLock):Promise<void>{
  let handle:Awaited<ReturnType<typeof secureOpen>>;try{handle=await secureOpen(input.eventsPath,input.workerUid,input.brokerGid,0o640,16*1024*1024);}catch{throw new GrokWorkerAttestationFailure("profile_invalid");}
  let bytes:Buffer|undefined;
  try{
    const stat=await handle.stat();
    if(Number(stat.dev)!==before.dev||Number(stat.ino)!==before.ino)throw new GrokWorkerAttestationFailure("profile_invalid");
    if(Number(stat.size)<=before.size)throw new GrokWorkerAttestationFailure("profile_missing");
    const accepted=lock?.accepted;
    const start=accepted===undefined?before.size:before.size+accepted.offset;
    const length=accepted===undefined?Number(stat.size)-before.size:accepted.length;
    if(start+length>Number(stat.size))throw new GrokWorkerAttestationFailure("profile_invalid");
    bytes=Buffer.alloc(length);
    const read=await handle.read(bytes,0,bytes.length,start);
    if(read.bytesRead!==bytes.length)throw new GrokWorkerAttestationFailure("profile_invalid");
    // The file must not change while it is read: a concurrent writer could
    // otherwise show this check bytes that no single state of the file held.
    const after=await handle.stat();
    if(Number(after.size)!==Number(stat.size)||Number(after.mtimeMs)!==Number(stat.mtimeMs))throw new GrokWorkerAttestationFailure("profile_invalid");
    if(accepted!==undefined){
      if(createHash("sha256").update(bytes).digest("hex")!==accepted.digest)throw new GrokWorkerAttestationFailure("profile_invalid");
      return;
    }
    const event=locateGrokWorkerProfileApplied(bytes,input.workspace,before.denyPaths);
    if(lock!==undefined)lock.accepted={offset:event.offset,length:event.length,digest:createHash("sha256").update(bytes.subarray(event.offset,event.offset+event.length)).digest("hex")};
  }catch(error){if(error instanceof GrokWorkerAttestationFailure)throw error;throw new GrokWorkerAttestationFailure("profile_invalid");}finally{bytes?.fill(0);await handle.close();}
}
/**
 * Requires one fully-conforming `ProfileApplied` event *somewhere* in the
 * fresh region — not as its last line.
 *
 * `sandbox-events.jsonl` is not a profile log. Grok (1.0.13 and 1.0.34) writes its whole
 * sandbox event vocabulary there — verified by reading the shipped binary:
 * `ProfileApplied, ApplyFailed, FsViolation, NetViolation, BypassGranted,
 * BypassDenied` (one contiguous enum blob beside the record fields
 * `timestamp, event_type, read_only_paths, deny_paths, operation, target,
 * command, tool_call_id`, emitted from `xai_grok_sandbox::logging`), and its
 * own embedded documentation says so outright: "Sandbox events (profile
 * applied, violations) are logged to `~/.grok/sandbox-events.jsonl`" (1.0.34
 * moved the file to `~/.grok/sessions/`; a 1.0.34 turn logs `ProfileApplied`
 * followed by an `FsViolation` for every denied read).
 *
 * Requiring `ProfileApplied` to be the *last* line therefore failed on the
 * first denied access of any turn: the violation Grok logged next became the
 * last line, this threw, the proxy's per-request isolation guard refused, and
 * the turn died `profile_invalid`. Denials are the normal operating state of
 * a working sandbox, so that check turned the sandbox doing its job into a
 * turn failure.
 *
 * Scanning the region is not weaker. The region is fresh by construction —
 * the caller reads only bytes above the pre-launch dev/ino/size watermark, so
 * nothing here predates this turn and a stale or replayed event below it is
 * unreachable. Both forms are equally forgeable by the same single actor (a
 * worker-uid process, which can only exist by being a Grok that the launcher
 * already started under the pinned profile), and both detect the failure this
 * guard exists for: a Grok that came up without kernel enforcement, which
 * emits no conforming `ProfileApplied` at all.
 */
export function parseGrokWorkerProfileApplied(bytes:Uint8Array,workspace:string,denyPaths:readonly string[]=[]):void{locateGrokWorkerProfileApplied(bytes,workspace,denyPaths);}
/** Byte range (within `bytes`) of the first fully-conforming `ProfileApplied` line. */
export function locateGrokWorkerProfileApplied(bytes:Uint8Array,workspace:string,denyPaths:readonly string[]=[]):Readonly<{offset:number;length:number}>{
  const expected=JSON.stringify([...denyPaths].sort());
  const buffer=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  for(let offset=0;offset<buffer.length;){
    const newline=buffer.indexOf(0x0a,offset);const end=newline===-1?buffer.length:newline;const line=buffer.subarray(offset,end).toString("utf8");const lineOffset=offset;offset=end+1;
    if(line.trim()==="")continue;
    let event:Record<string,unknown>;
    try{const parsed=JSON.parse(line) as unknown;if(parsed===null||typeof parsed!=="object"||Array.isArray(parsed))continue;event=parsed as Record<string,unknown>;}catch{continue;}
    if(event.event_type!=="ProfileApplied")continue;
    const observed=Array.isArray(event.deny_paths)?event.deny_paths.filter((entry):entry is string=>typeof entry==="string").sort():[];
    if(event.profile==="daimon-strict"&&event.enforced===true&&event.restrict_network===true&&event.platform==="linux/landlock"&&event.workspace===workspace&&JSON.stringify(observed)===expected)return{offset:lineOffset,length:end-lineOffset};
  }
  throw new Error("Grok worker isolation attestation unavailable");
}
async function secureOpen(file:string,uid:number,gid:number,mode:number,max:number,links=1){try{const before=await lstat(file);const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await handle.stat();if(!stat.isFile()||stat.isSymbolicLink()||Number(stat.uid)!==uid||Number(stat.gid)!==gid||(Number(stat.mode)&0o777)!==mode||Number(stat.nlink)!==links||Number(stat.size)>max||before.dev!==stat.dev||before.ino!==stat.ino){await handle.close();throw new Error();}return handle;}catch{throw new Error("Grok worker isolation attestation unavailable");}}
