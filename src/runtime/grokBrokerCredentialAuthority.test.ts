import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DurableGrokBrokerCredentialAuthority } from "./grokBrokerCredentialAuthority.js";

test("credential authority resumes only a journal matching durable credential",async()=>{const home=await fixture();try{const bytes=await import("node:fs/promises").then(({readFile})=>readFile(path.join(home,"auth.json"))),digest=createHash("sha256").update(bytes).digest("hex");await journal(home,{state:"promoted",generation:1,sourceDigest:"a".repeat(64),promotedDigest:digest});const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await authority.initialize();assert.equal((await authority.accessToken(false)).length>=32,true);}finally{await rm(home,{recursive:true,force:true});}});

test("credential authority fails closed after indeterminate restart",async()=>{const home=await fixture();try{await journal(home,{state:"refreshing",generation:1,sourceDigest:"b".repeat(64)});const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await assert.rejects(authority.initialize(),/unavailable/u);await assert.rejects(authority.accessToken(false),/unavailable/u);}finally{await rm(home,{recursive:true,force:true});}});

test("stale fence durably records the rejected credential digest and generation for operator recovery",async()=>{const home=await fixture();try{const auth=await readFile(path.join(home,"auth.json")),digest=createHash("sha256").update(auth).digest("hex");await journal(home,{state:"promoted",generation:7,sourceDigest:"a".repeat(64),promotedDigest:digest});const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await authority.initialize();await assert.rejects(authority.markRejected(),/unavailable/u);const observed=JSON.parse(await readFile(path.join(home,".daimon-broker","credential-journal.json"),"utf8")) as Record<string,unknown>;assert.equal(observed.state,"stale");assert.equal(observed.generation,7);assert.equal(observed.sourceDigest,digest);assert.equal(observed.promotedDigest,digest);}finally{await rm(home,{recursive:true,force:true});}});

test("a late rejection cannot stale-fence a newer access token",async()=>{const home=await fixture();try{const authority=new DurableGrokBrokerCredentialAuthority("/usr/local/bin/grok",home);await authority.initialize();const old=createHash("sha256").update("k".repeat(40)).digest("hex");await writeFile(path.join(home,"auth.json"),JSON.stringify({subscription:{key:"n".repeat(40),refresh_token:"r".repeat(20)}}),{mode:0o600});await assert.rejects(authority.markRejected(old),/unavailable/u);assert.equal(authority.isStale(),false);}finally{await rm(home,{recursive:true,force:true});}});

async function fixture():Promise<string>{const home=await mkdtemp(path.join(tmpdir(),"grok-authority-"));const value={subscription:{key:"k".repeat(40),refresh_token:"r".repeat(20)}};await writeFile(path.join(home,"auth.json"),JSON.stringify(value),{mode:0o600});return home;}
async function journal(home:string,value:Record<string,unknown>):Promise<void>{const root=path.join(home,".daimon-broker");await mkdir(root,{mode:0o700});const file=path.join(root,"credential-journal.json");await writeFile(file,JSON.stringify({version:"noopolis.daimon.broker-credential-journal.v1",...value}),{mode:0o600});await chmod(file,0o600);}

test("credential authority promotes a fake CLI rotation and resumes promoted journal",async()=>{const home=await fixture();try{const command=await rotatingGrok(home,"rotated");const authority=new DurableGrokBrokerCredentialAuthority(command,home);await authority.initialize();const fresh=await authority.refreshAfterRejection(createHash("sha256").update("k".repeat(40)).digest("hex"));assert.equal(fresh,tokenFor("rotated"));const promoted=JSON.parse(await readFile(path.join(home,".daimon-broker","credential-journal.json"),"utf8")) as Record<string,unknown>;assert.equal(promoted.state,"promoted");const resumed=new DurableGrokBrokerCredentialAuthority(command,home);await resumed.initialize();assert.equal(await resumed.accessToken(false),tokenFor("rotated"));}finally{await rm(home,{recursive:true,force:true});}});

test("credential authority treats an unchanged successful CLI refresh as stale",async()=>{const home=await fixture();try{const command=await noopGrok(home);const authority=new DurableGrokBrokerCredentialAuthority(command,home);await authority.initialize();await assert.rejects(authority.refreshAfterRejection(createHash("sha256").update("k".repeat(40)).digest("hex")),/unavailable/u);assert.equal(authority.isStale(),true);const observed=JSON.parse(await readFile(path.join(home,".daimon-broker","credential-journal.json"),"utf8")) as Record<string,unknown>;assert.equal(observed.state,"stale");}finally{await rm(home,{recursive:true,force:true});}});

test("concurrent rejections of the same broker bearer spend one fake CLI exchange",async()=>{const home=await fixture();try{const command=await rotatingGrok(home,"singleflight");const authority=new DurableGrokBrokerCredentialAuthority(command,home);await authority.initialize();const rejected=createHash("sha256").update("k".repeat(40)).digest("hex");const results=await Promise.all([authority.refreshAfterRejection(rejected),authority.refreshAfterRejection(rejected),authority.refreshAfterRejection(rejected)]);assert.deepEqual(results,[tokenFor("singleflight"),tokenFor("singleflight"),tokenFor("singleflight")]);assert.equal(Number(await readFile(path.join(home,"refresh-count"),"utf8")),1);}finally{await rm(home,{recursive:true,force:true});}});

function tokenFor(label:string):string{return label.repeat(Math.ceil(40/label.length)).slice(0,40);}

async function rotatingGrok(home:string,label:string):Promise<string>{const command=path.join(home,`grok-${label}`);const token=tokenFor(label);await writeFile(command,`#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"),home=process.env.GROK_HOME;
if(process.argv[2]!=="models")process.exit(9);
const count=path.join(home,"refresh-count");
const previous=Number(fs.existsSync(count)?fs.readFileSync(count,"utf8"):"0");
fs.writeFileSync(count,String(previous+1));
fs.writeFileSync(path.join(home,"auth.json"),JSON.stringify({subscription:{key:${JSON.stringify(token)},refresh_token:"${"r".repeat(20)}"}}));
`,{mode:0o700});await chmod(command,0o700);return command;}
async function noopGrok(home:string):Promise<string>{const command=path.join(home,"grok-noop");await writeFile(command,`#!/usr/bin/env node
if(process.argv[2]!=="models")process.exit(9);
`,{mode:0o700});await chmod(command,0o700);return command;}
