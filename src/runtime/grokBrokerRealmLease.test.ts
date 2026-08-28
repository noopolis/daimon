import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireGrokBrokerRealmLease } from "./grokBrokerRealmLease.js";

test("broker realm lease excludes a second broker and releases on close",{skip:spawnSync("flock",["--version"]).error!==undefined},async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"grok-broker-lease-"));try{const first=await acquireGrokBrokerRealmLease(root);await assert.rejects(acquireGrokBrokerRealmLease(root),/already in use/u);await first.close();const replacement=await acquireGrokBrokerRealmLease(root);await replacement.close();}finally{await rm(root,{recursive:true,force:true});}});
