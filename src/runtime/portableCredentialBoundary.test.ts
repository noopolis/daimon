import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { materializePortableCredential } from "./portableCredentialMaterial.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const execute = promisify(execFile);
const reader = fileURLToPath(new URL("./portableCredentialMaterial.ts", import.meta.url));
const child = `const {materializePortableCredential}=await import(process.argv[1]);const home=process.argv[2];try{await materializePortableCredential({id:'agent:codex',name:'Codex',instructions:'Unused',workspacePath:home+'/workspace',runtimeHomePath:home,engine:{kind:'codex'}},home);process.stdout.write('UNEXPECTED_IMPORT');}catch{process.stdout.write('MATERIALIZATION_REFUSED');}`;

for (const kind of ["mode", "hardlink", "directory", "empty", "oversize", "symlink"] as const) {
  test(`real filesystem rejects unsafe credential ${kind}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-credential-boundary-"));
    const source = `${root}/.daimon-inbound/codex-auth`;
    const agent: OrganizationRuntimeAgentConfig = { id: "agent:codex", name: "Codex", instructions: "Unused", workspacePath: `${root}/workspace`, runtimeHomePath: root, engine: { kind: "codex" } };
    try {
      await mkdir(path.dirname(source), { mode: 0o700 });
      if (kind === "directory") await mkdir(source, { mode: 0o600 });
      else if (kind === "symlink") { await writeFile(`${root}/target`, "dummy", { mode: 0o600 }); await symlink(`${root}/target`, source); }
      else {
        await writeFile(source, kind === "empty" ? "" : kind === "oversize" ? "x".repeat(65537) : "dummy", { mode: 0o600 });
        if (kind === "mode") await chmod(source, 0o644);
        if (kind === "hardlink") await link(source, `${root}/second-link`);
      }
      await assert.rejects(materializePortableCredential(agent, root), /credential materialization failed/u);
      await assert.rejects(readFile(`${root}/.codex/auth.json`), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("a real FIFO is rejected promptly; deleting nonblocking open makes the subprocess hang", { skip: process.platform === "win32", timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-credential-fifo-"));
  try {
    await mkdir(`${root}/.daimon-inbound`, { mode: 0o700 });
    await execute("mkfifo", ["-m", "600", `${root}/.daimon-inbound/codex-auth`]);
    const run = (modulePath: string) => execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, modulePath, root], { timeout: 3000, killSignal: "SIGKILL" });
    assert.equal((await run(reader)).stdout, "MATERIALIZATION_REFUSED");
    const original = await readFile(reader, "utf8");
    const mutated = original.replace(" | constants.O_NONBLOCK", "").replace('"./contractManifest.js"', JSON.stringify(fileURLToPath(new URL("./contractManifest.ts", import.meta.url))));
    assert.notEqual(mutated, original);
    await writeFile(`${root}/package.json`, '{"type":"module"}');
    const mutant = `${root}/mutant.ts`; await writeFile(mutant, mutated);
    await assert.rejects(run(mutant), (error: NodeJS.ErrnoException & { killed?: boolean; signal?: string }) => error.killed === true && error.signal === "SIGKILL");
  } finally { await rm(root, { recursive: true, force: true }); }
});
