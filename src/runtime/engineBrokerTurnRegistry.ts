import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseEngineBrokerResponse, parseEngineBrokerV1TerminalResponse, type EngineBrokerRequest, type EngineBrokerTerminalResponse } from "./engineBrokerProtocol.js";
import type { GrokBrokerModel } from "./grokBrokerModelPolicy.js";
import { EMPTY_BROKER_TURN_LEDGER, parseBrokerTurnLedgerLines, type BrokerTurnLedgerLines } from "./grokEngineBrokerLedger.js";

type Start = Extract<EngineBrokerRequest, { kind: "start_turn" }>;
type Terminal = EngineBrokerTerminalResponse;
export const ENGINE_BROKER_TURN_RECORD_V1 = "noopolis.daimon.engine-broker-turn.v1" as const;
export const ENGINE_BROKER_TURN_RECORD_V2 = "noopolis.daimon.engine-broker-turn.v2" as const;
// The digest deliberately excludes `limits` and the protocol version, so a v1
// record written before the upgrade still identifies the same turn.
const digest = (request: Start): string => createHash("sha256").update(JSON.stringify([request.turnId, request.agentId, request.wakeId, request.prompt,request.mcpEndpoint])).digest("hex");
const safe = (turnId: string): string => `${createHash("sha256").update(turnId).digest("hex")}.json`;
type Observed = Readonly<{ version: typeof ENGINE_BROKER_TURN_RECORD_V1 | typeof ENGINE_BROKER_TURN_RECORD_V2; digest: string; state: "active" | "terminal"; bootId: string; response?: Terminal; ledger?: BrokerTurnLedgerLines }>;

/**
 * Durable per-turn state. Record v2 stores the terminal response *with* its
 * sealed accounting (usage, outcome, model, requests, limitReason), so a replay
 * returns exactly what was metered and never meters again: metering happens
 * only on the path that returned `"start"`.
 */
export class EngineBrokerTurnRegistry {
  /** `syncDirectoryOf` is injectable only so the post-publish failure path can be exercised under test. */
  constructor(private readonly root: string,private readonly bootId:string=randomUUID(),private readonly syncDirectoryOf:(directory:string)=>Promise<void>=syncDirectory) {}
  /** `model` is the registration's declared model, used only to upgrade a v1 record on replay. */
  async begin(request: Start, model: GrokBrokerModel): Promise<"start" | { replay: Terminal; ledger: BrokerTurnLedgerLines }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, safe(request.turnId)); const expected = digest(request);
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await handle.writeFile(`${JSON.stringify({ version: ENGINE_BROKER_TURN_RECORD_V2, digest: expected, state: "active",bootId:this.bootId })}\n`); await handle.sync(); } finally { await handle.close(); } await this.syncDirectoryOf(this.root); return "start"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("broker turn registry unavailable"); }
    const observed = parseEngineBrokerTurnRecord(await readFile(file, "utf8"), model);
    if (observed.digest !== expected) throw new Error("broker turn conflict");
    if (observed.state === "terminal" && observed.response !== undefined) return { replay: observed.response, ledger: observed.ledger ?? EMPTY_BROKER_TURN_LEDGER };
    if(observed.state==="active"&&observed.bootId!==this.bootId){const response={version:request.version,kind:"failed",requestId:request.requestId,turnId:request.turnId,code:"engine_failed",outcome:"failed",usage:null,model,requests:0,limitReason:"none"} as const;await this.finish(request,response);return {replay:response,ledger:EMPTY_BROKER_TURN_LEDGER};}
    throw new Error("broker turn already active");
  }
  /**
   * `ledger` is the exact ledger bytes this turn owes, sealed with it so a replay can finish an interrupted append.
   *
   * The rename is the publish point. A failure before it rejects (nothing was
   * published); a failure after it — the directory fsync — must not, because
   * the terminal record is already the visible truth and a caller that saw a
   * rejection would believe the turn unsealed and write a contradicting
   * record over it. That durability gap is reported as `directorySynced: false`
   * instead: the record is published but may not survive a power loss.
   */
  async finish(request: Start, response: Terminal, ledger: BrokerTurnLedgerLines = EMPTY_BROKER_TURN_LEDGER): Promise<Readonly<{ directorySynced: boolean }>> {
    const file = path.join(this.root, safe(request.turnId)); const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ version: ENGINE_BROKER_TURN_RECORD_V2, digest: digest(request), state: "terminal",bootId:this.bootId, response, ledger })}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => undefined); }
    try { await this.syncDirectoryOf(this.root); return { directorySynced: true }; } catch { return { directorySynced: false }; }
  }
}

/**
 * Strict record parser. v2 accepts exactly `{version,digest,state,bootId}`
 * plus `response` and its sealed `ledger` bytes when terminal, and the response must be a v2 terminal frame.
 * v1 records keep their historical looser shape and are upgraded on read: no
 * usage (`null`), zero requests, `limitReason: "none"`, the declared model.
 */
export function parseEngineBrokerTurnRecord(text: string, model: GrokBrokerModel): Observed {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("broker turn registry unavailable"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("broker turn registry unavailable");
  const input = value as Record<string, unknown>;
  if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/u.test(input.digest) || typeof input.bootId !== "string" || (input.state !== "active" && input.state !== "terminal")) throw new Error("broker turn registry unavailable");
  const base = { digest: input.digest, state: input.state, bootId: input.bootId } as const;
  if (input.version === ENGINE_BROKER_TURN_RECORD_V1) {
    if (input.state !== "terminal" || input.response === undefined) return { version: ENGINE_BROKER_TURN_RECORD_V1, ...base };
    let legacy;
    try { legacy = parseEngineBrokerV1TerminalResponse(input.response); } catch { throw new Error("broker turn registry unavailable"); }
    const accounting = { outcome: legacy.kind, usage: null, model, requests: 0, limitReason: "none" } as const;
    const response: Terminal = { ...legacy, ...accounting, version: "noopolis.daimon.engine-broker.v2" } as Terminal;
    return { version: ENGINE_BROKER_TURN_RECORD_V1, ...base, response };
  }
  if (input.version !== ENGINE_BROKER_TURN_RECORD_V2) throw new Error("broker turn conflict");
  const fields = input.state === "terminal" ? ["version", "digest", "state", "bootId", "response", "ledger"] : ["version", "digest", "state", "bootId"];
  if (Object.keys(input).length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) throw new Error("broker turn registry unavailable");
  if (input.state === "active") return { version: ENGINE_BROKER_TURN_RECORD_V2, ...base };
  let response;
  try { response = parseEngineBrokerResponse(input.response); } catch { throw new Error("broker turn registry unavailable"); }
  if (response.kind !== "completed" && response.kind !== "failed") throw new Error("broker turn registry unavailable");
  const ledger = parseBrokerTurnLedgerLines(input.ledger, response.turnId);
  if ((response.usage === null) !== (ledger.usage === null)) throw new Error("broker turn registry unavailable");
  return { version: ENGINE_BROKER_TURN_RECORD_V2, ...base, response, ledger };
}

async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
