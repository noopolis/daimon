import assert from "node:assert/strict";
import test from "node:test";
import { parseEngineBrokerServiceConfig } from "./engineBrokerServiceCli.js";

test("parses the closed broker service configuration",()=>{
  const registration=reg("agent-a",0);assert.deepEqual(parseEngineBrokerServiceConfig({version:"noopolis.daimon.engine-broker-service.v1",credentialHome:"/var/lib/daimon-engine-broker/credential",turnStore:"/var/lib/daimon-engine-broker/turns",registrations:[registration]}),{credentialHome:"/var/lib/daimon-engine-broker/credential",turnStore:"/var/lib/daimon-engine-broker/turns",registrations:[registration]});
});

test("rejects caller-selected commands, duplicate identities, and traversal",()=>{
  const base={version:"noopolis.daimon.engine-broker-service.v1",credentialHome:"/var/lib/daimon-engine-broker/credential",turnStore:"/var/lib/daimon-engine-broker/turns",registrations:[reg("agent-a",0)]};
  assert.throws(()=>parseEngineBrokerServiceConfig({...base,grokCommand:"evil"}));
  assert.throws(()=>parseEngineBrokerServiceConfig({...base,turnStore:"/var/lib/../secret"}));
  assert.throws(()=>parseEngineBrokerServiceConfig({...base,registrations:[reg("agent-a",0),reg("agent-a",1)]}));
});
const reg=(agentId:string,slot:number)=>({agentId,slot,workerUid:2200+slot,workspace:`/workspace/${slot}`,profilePath:`/workers/${slot}/.grok/sandbox.toml`,eventsPath:`/workers/${slot}/.grok/sandbox-events.jsonl`,profileSha256:"a".repeat(64)});
