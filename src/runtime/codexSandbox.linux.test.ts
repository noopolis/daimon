import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { renderCodexArgs } from "../pi/cliEngineSpawn.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./engineDispatcher.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const image = process.env.DAIMON_CODEX_SANDBOX_TEST_IMAGE;
const script = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net');
const input=JSON.parse(process.argv[1]);
for(const p of [input.workspace,input.home,...input.denied.filter(p=>p!=='/proc'&&p!=='/run').map(p=>p.endsWith('/auth.json')?path.dirname(p):p),...input.readable])fs.mkdirSync(p,{recursive:true,mode:448});
const canaries=input.denied.filter(p=>p!=='/proc').map(p=>p.endsWith('/auth.json')?p:path.join(p,'canary'));
for(const p of canaries)fs.writeFileSync(p,'non-secret-denied-canary',{mode:384});
for(const p of canaries)if(fs.readFileSync(p,'utf8')!=='non-secret-denied-canary')throw Error('outside-sandbox canary missing');
for(const p of input.readable)fs.writeFileSync(path.join(p,'canary'),'readable-canary');
fs.writeFileSync(path.join(input.workspace,'input'),'workspace-read');
const server=net.createServer(s=>s.destroy());
server.listen(0,'127.0.0.1',()=>{
const command=input.workspaceDenied?\`const fs=require('node:fs');
for(const p of \${JSON.stringify([input.workspace+'/input',input.workspace+'/secret/canary'])}){let denied=false;try{fs.readFileSync(p);}catch{denied=true;}if(!denied)throw Error('workspace deny lost to implicit write');}
let denied=false;try{fs.writeFileSync(\${JSON.stringify(input.workspace+'/output')},'forbidden');}catch{denied=true;}if(!denied)throw Error('denied workspace writable');
process.stdout.write('EXACT_WORKSPACE_DENIED');\`:\`const fs=require('node:fs'),net=require('node:net');
if(fs.readFileSync('input','utf8')!=='workspace-read')throw Error('workspace read failed');
fs.writeFileSync('output','workspace-write');
for(const p of \${JSON.stringify(canaries)}){let denied=false;try{fs.readFileSync(p);}catch{denied=true;}if(!denied)throw Error('canary became readable: '+p);}
for(const p of \${JSON.stringify(input.readable)})if(fs.readFileSync(p+'/canary','utf8')!=='readable-canary')throw Error('readable exception missing');
const socket=net.connect({host:'127.0.0.1',port:\${server.address().port}});let done=false;
socket.once('connect',()=>{done=true;socket.destroy();throw Error('network reached outside sandbox');});
socket.once('error',()=>{if(!done){done=true;fs.writeFileSync('complete','CODEX_SANDBOX_ENFORCED');}});
socket.setTimeout(1500,()=>{socket.destroy();if(!done){done=true;throw Error('network probe timed out');}});\`;
const env={PATH:process.env.PATH,HOME:input.home,CODEX_HOME:input.home+'/.codex',TMPDIR:'/tmp',LANG:'C.UTF-8'};
const executable=input.workspaceDenied?['/bin/sh','-c','cd /tmp && exec /usr/local/bin/node -e "$1"','probe',command]:['/usr/local/bin/node','-e',command];
cp.execFile('codex',['sandbox','-P','daimon-strict','-C',input.workspace,'-c',input.profile,'--',...executable],{env,timeout:15000,maxBuffer:65536},(error,stdout,stderr)=>{
server.close();
if(error){process.stderr.write(stderr);process.exitCode=1;return;}
if(input.workspaceDenied){if(stdout!=='EXACT_WORKSPACE_DENIED'||fs.existsSync(path.join(input.workspace,'output')))throw Error('workspace deny not enforced: '+JSON.stringify({stdout,stderr,outputExists:fs.existsSync(path.join(input.workspace,'output'))}));process.stdout.write('CODEX_SANDBOX_ENFORCED');return;}
if(fs.readFileSync(path.join(input.workspace,'complete'),'utf8')!=='CODEX_SANDBOX_ENFORCED'||fs.readFileSync(path.join(input.workspace,'output'),'utf8')!=='workspace-write')throw Error('missing sandbox side effect');
process.stdout.write('CODEX_SANDBOX_ENFORCED');
});});`;

async function runSandbox(input: { workspace: string; home: string; denied: readonly string[]; readable: readonly string[]; profile: string; workspaceDenied?: boolean }): Promise<string> {
  return (await promisify(execFile)("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--user", "501:20", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
    ...["/tmp", "/run", "/var/lib/daimon", "/var/lib/spawnfile"].flatMap(target => ["--tmpfs", `${target}:rw,uid=501,gid=20,mode=0700`]),
    "--entrypoint", "/usr/local/bin/node", image!, "-e", script, JSON.stringify(input)
  ], { timeout: 25000, maxBuffer: 131072 })).stdout;
}

test("actual Codex sandbox executes the production policy with overlapping control denies", { skip: !image, timeout: 60000 }, async () => {
  const configFile = process.env.DAIMON_CODEX_SANDBOX_TEST_CONFIG;
  const agent: OrganizationRuntimeAgentConfig = configFile
    ? (JSON.parse(await readFile(configFile, "utf8")) as { agents: OrganizationRuntimeAgentConfig[] }).agents[0]!
    : { id: "agent:current", name: "Current", instructions: "Unused in this mechanical probe.",
      workspacePath: "/var/lib/daimon/workspace", runtimeHomePath: "/var/lib/daimon/home",
      engine: { kind: "codex", codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } } };
  const control = "/run/paideia/control";
  const denied = codexSandboxProtectedPaths(agent.id, agent, path.join(agent.runtimeHomePath, ".codex"), [agent], [control]);
  const readable = codexSandboxReadablePaths(agent);
  const profile = renderCodexArgs({ codexSandbox: agent.engine.codexSandbox,
    codexSandboxProtectedPaths: denied, codexSandboxReadablePaths: readable }, agent.workspacePath, "http://127.0.0.1:1/mcp")
    .find(arg => arg.startsWith("permissions="))!;
  assert.ok(denied.includes("/run") && denied.includes(control));
  assert.ok(!profile.includes(`"${control}"="deny"`));
  const run = (permissionConfig: string): Promise<string> => runSandbox({ workspace: agent.workspacePath,
    home: agent.runtimeHomePath, denied, readable, profile: permissionConfig });
  assert.equal(await run(profile), "CODEX_SANDBOX_ENFORCED");
  // Restore the exact redundant deny emitted before the fix. The real sandbox
  // must reproduce the setup failure instead of merely executing an empty shell.
  await assert.rejects(run(profile.replace('"/run"="deny"', `"/run"="deny","${control}"="deny"`)), /Can't mkdir parents.*Read-only file system/u);
});

test("a denied workspace fails readiness when Codex exits zero without executing the command", { skip: !image, timeout: 30000 }, async () => {
  const workspace = "/var/lib/daimon/workspace", home = "/var/lib/daimon/home";
  const denied = [workspace, `${workspace}/secret`, "/run", "/proc", `${home}/.codex/auth.json`];
  const profile = renderCodexArgs({ codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    codexSandboxProtectedPaths: denied }, workspace, "http://127.0.0.1:1/mcp").find(arg => arg.startsWith("permissions="))!;
  assert.ok(!profile.includes(`"${workspace}/secret"="deny"`));
  // Codex 0.142.3 executes neither Node nor the shell wrapper in this geometry.
  // Exit zero is not readiness: the missing sentinel must reject it.
  await assert.rejects(runSandbox({ workspace, home, denied, readable: [], profile, workspaceDenied: true }),
    /workspace deny not enforced: \{"stdout":"","stderr":"","outputExists":false\}/u);
  await assert.rejects(runSandbox({ workspace, home, denied, readable: [], workspaceDenied: true,
    profile: profile.replace(`,"${workspace}"="deny"`, "") }), /workspace deny lost to implicit write/u);
});

test("a shared protected path containing .. cannot inherit the wrong ancestor deny", { skip: !image, timeout: 30000 }, async () => {
  const workspace = "/var/lib/daimon/workspace", home = "/var/lib/daimon/home";
  const denied = ["/run", "/run/../var/lib/daimon/control/", "/proc", `${home}/.codex/auth.json`];
  const profile = renderCodexArgs({ codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    codexSandboxProtectedPaths: denied }, workspace, "http://127.0.0.1:1/mcp").find(arg => arg.startsWith("permissions="))!;
  assert.ok(profile.includes('"/var/lib/daimon/control"="deny"'));
  assert.equal(await runSandbox({ workspace, home, denied, readable: [], profile }), "CODEX_SANDBOX_ENFORCED");
  await assert.rejects(runSandbox({ workspace, home, denied, readable: [],
    profile: profile.replace(',"/var/lib/daimon/control"="deny"', "") }), /canary became readable/u);
});

test("unsupported nested exception geometry fails closed instead of dropping its protected descendant", { skip: !image, timeout: 30000 }, async () => {
  const workspace = "/var/lib/daimon/workspace", home = "/var/lib/daimon/home", vault = "/var/lib/daimon/vault";
  const denied = ["/run", "/proc", `${home}/.codex/auth.json`, `${home}/.daimon-inbound`, vault, `${vault}/open/secret`];
  const readable = [`${vault}/open`];
  const profile = renderCodexArgs({ codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    codexSandboxProtectedPaths: denied, codexSandboxReadablePaths: readable }, workspace, "http://127.0.0.1:1/mcp")
    .find(arg => arg.startsWith("permissions="))!;
  assert.ok(profile.includes(`"${vault}/open/secret"="deny"`));
  // Codex 0.142.3 cannot mount this nonredundant geometry. Keep the deny and
  // require the actual-profile readiness probe to refuse it before cognition.
  await assert.rejects(runSandbox({ workspace, home, denied, readable, profile }), /Can't mkdir parents.*Read-only file system/u);
  await assert.rejects(runSandbox({ workspace, home, denied, readable,
    profile: profile.replace(`,"${vault}/open/secret"="deny"`, "") }), /canary became readable/u);
});
