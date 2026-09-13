import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const image = process.env.DAIMON_CREDENTIAL_BIND_TEST_IMAGE;
const script = `import fs from 'node:fs/promises';
const home='/native-home',source=home+'/.daimon-inbound/codex-auth';
const before=await fs.lstat(source);
const {materializePortableCredential}=await import('/opt/paideia/credential-test/reader.ts');
const result=await materializePortableCredential({id:'agent:codex',name:'Codex',instructions:'Unused',workspacePath:'/tmp/workspace',runtimeHomePath:home,engine:{kind:'codex'}},home);
if(result!=='created'||await fs.readFile(home+'/.codex/auth.json','utf8')!=='non-secret-dummy-credential')throw Error('dummy credential was not materialized');
const after=await fs.lstat(source);process.stdout.write(JSON.stringify({result,uid:process.getuid(),beforeUid:before.uid,afterUid:after.uid,descriptorRefreshObserved:before.uid!==after.uid,verified:true}));`;

test("actual read-only Docker bind materializes a fresh dummy credential without metadata prewarming", { skip: !image, timeout: 30000 }, async t => {
  const parent = fileURLToPath(new URL("../../.runtime/", import.meta.url));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(parent, "daimon-dummy-credential-bind-"));
  try {
    const home = `${root}/home`, code = `${root}/code`, source = `${root}/dummy-credential`;
    await mkdir(`${home}/.daimon-inbound`, { recursive: true, mode: 0o700 }); await mkdir(code);
    await writeFile(source, "non-secret-dummy-credential", { mode: 0o600 });
    // Execute the edited reader without building dist; its unchanged contract
    // constant comes from the image's public runtime export, never private code.
    const bytes = (await readFile(fileURLToPath(new URL("./portableCredentialMaterial.ts", import.meta.url)), "utf8"))
      .replace('"./contractManifest.js"', '"@noopolis/daimon/runtime"');
    await writeFile(`${code}/reader.ts`, bytes);
    const result = await promisify(execFile)("docker", ["run", "--rm", "--network", "none", "--read-only",
      "--user", `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev", "--mount", `type=bind,source=${home},target=/native-home`,
      "--mount", `type=bind,source=${source},target=/native-home/.daimon-inbound/codex-auth,readonly`,
      "--mount", `type=bind,source=${code},target=/opt/paideia/credential-test,readonly`,
      "--entrypoint", "/usr/local/bin/node", image!, "--experimental-strip-types", "--input-type=module", "-e", script
    ], { timeout: 20000, maxBuffer: 16384 });
    const proof = JSON.parse(result.stdout) as { result: string; uid: number; beforeUid: number; afterUid: number; verified: boolean; descriptorRefreshObserved: boolean };
    assert.equal(proof.result, "created"); assert.equal(proof.verified, true); assert.equal(proof.afterUid, proof.uid);
    t.diagnostic(JSON.stringify(proof));
    // Root can read the dummy file via DAC_OVERRIDE; the reader must still
    // reject its genuinely different owner rather than relying on open EACCES.
    const unsafeOwner = `import fs from 'node:fs/promises';
const home='/native-home',source=home+'/.daimon-inbound/codex-auth';await fs.mkdir(home+'/.daimon-inbound',{mode:448});await fs.writeFile(source,'dummy',{mode:384});await fs.chown(source,501,20);
const opened=await fs.open(source,'r');if((await opened.stat()).uid===process.getuid())throw Error('owner fixture invalid');await opened.close();
const {materializePortableCredential}=await import('/opt/paideia/credential-test/reader.ts');let refused=false;try{await materializePortableCredential({id:'agent:codex',name:'Codex',instructions:'Unused',workspacePath:'/tmp/workspace',runtimeHomePath:home,engine:{kind:'codex'}},home);}catch{refused=true;}
if(!refused)throw Error('unsafe owner imported');try{await fs.access(home+'/.codex/auth.json');throw Error('destination exists');}catch(e){if(e.code!=='ENOENT')throw e;}process.stdout.write('UNSAFE_OWNER_REFUSED');`;
    const negative = await promisify(execFile)("docker", ["run", "--rm", "--network", "none", "--read-only", "--user", "0:0",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev", "--tmpfs", "/native-home:rw,mode=0700",
      "--mount", `type=bind,source=${code},target=/opt/paideia/credential-test,readonly`, "--entrypoint", "/usr/local/bin/node",
      image!, "--experimental-strip-types", "--input-type=module", "-e", unsafeOwner], { timeout: 10000, maxBuffer: 16384 });
    assert.equal(negative.stdout, "UNSAFE_OWNER_REFUSED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
