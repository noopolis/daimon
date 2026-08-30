import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { parseEngineBrokerResponse,type EngineBrokerRequest, type EngineBrokerResponse } from "./engineBrokerProtocol.js";

type Start = Extract<EngineBrokerRequest, { kind: "start_turn" }>;
type Terminal = Extract<EngineBrokerResponse, { kind: "completed" | "failed" }>;
type Record = { version: "noopolis.daimon.engine-broker-turn.v1"; digest: string; state: "active" | "terminal"; bootId: string; response?: Terminal };
const digest = (request: Start): string => createHash("sha256").update(JSON.stringify([request.turnId, request.agentId, request.wakeId, request.prompt,request.mcpEndpoint])).digest("hex");
const safe = (turnId: string): string => `${createHash("sha256").update(turnId).digest("hex")}.json`;

export class EngineBrokerTurnRegistry {
  constructor(private readonly root: string,private readonly bootId:string=randomUUID()) {}
  async begin(request: Start): Promise<"start" | { replay: Terminal }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, safe(request.turnId)); const expected = digest(request);
    try { const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await handle.writeFile(`${JSON.stringify({ version: "noopolis.daimon.engine-broker-turn.v1", digest: expected, state: "active",bootId:this.bootId })}\n`); await handle.sync(); } finally { await handle.close(); } await syncDirectory(this.root); return "start"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("broker turn registry unavailable"); }
    const observed = JSON.parse(await readFile(file, "utf8")) as Record;
    if (observed.version !== "noopolis.daimon.engine-broker-turn.v1" || observed.digest !== expected) throw new Error("broker turn conflict");
    if (observed.state === "terminal" && observed.response !== undefined) { const response=parseEngineBrokerResponse(observed.response);if(response.kind!=="completed"&&response.kind!=="failed")throw new Error("broker turn registry unavailable");return { replay: response }; }
    if(observed.state==="active"&&observed.bootId!==this.bootId){const response={version:request.version,kind:"failed",requestId:request.requestId,turnId:request.turnId,code:"engine_failed"} as const;await this.finish(request,response);return {replay:response};}
    throw new Error("broker turn already active");
  }
  async finish(request: Start, response: Terminal): Promise<void> {
    const file = path.join(this.root, safe(request.turnId)); const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ version: "noopolis.daimon.engine-broker-turn.v1", digest: digest(request), state: "terminal",bootId:this.bootId, response })}\n`); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, file); await syncDirectory(this.root); } finally { await unlink(temporary).catch(() => undefined); }
  }
}

async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
