import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../../contracts/runtimeContractManifest.js";
import { DAIMON_GROK_SYSTEM_PROMPT, GROK_WORKER_MAX_TURNS, GROK_WORKER_TOOL_IDS } from "../../contracts/grokWorkerContract.js";
import { GROK_BROKER_PROVIDER_CAPABILITY_ENV, renderGrokBrokerWorkerArgs, renderGrokBrokerWorkerConfig } from "../grokBrokerWorkerConfig.js";

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const unquote = (literal: string): string => {
  assert.match(literal, /^"[^"\\]*"$/u, "launcher literals must not need escaping");
  return literal.slice(1, -1);
};

/** `#define NAME "value"` (optionally continued onto the next line) from the launcher header. */
const defines = (): ReadonlyMap<string, string> => {
  const header = read("engineBrokerLauncher.h").replace(/\\\n\s*/gu, "");
  return new Map([...header.matchAll(/^#define (DBL_GROK_[A-Z_]+)\s+("[^"\n]*")$/gmu)].map((match) => [match[1]!, unquote(match[2]!)]));
};

/** The compiled worker argv, token by token, exactly as `launch()` passes it to `execveat`. */
const compiledArgv = (): readonly string[] => {
  const source = `${read("engineBrokerLauncherCore.inc")}${read("engineBrokerLauncherServer.inc")}`;
  const block = source.match(/char \*const argv\[\] = \{([\s\S]*?)NULL\};/u);
  assert.ok(block, "launcher argv array not found");
  const values = defines();
  return block[1]!.split(",").map((token) => token.trim()).filter(Boolean).map((token) => {
    if (token.startsWith('"')) return unquote(token);
    if (token === "(char *)r->workspace") return "/registered/workspace";
    const value = values.get(token);
    assert.ok(value !== undefined, `unexpected launcher argv token ${token}`);
    return value;
  });
};

test("the native launcher compiles exactly the lean Grok worker argv Daimon renders", () => {
  const argv = compiledArgv();
  assert.equal(argv[0], "grok");
  assert.deepEqual(argv.slice(1), renderGrokBrokerWorkerArgs("/proc/self/fd/3", "/registered/workspace"));
  for (const flag of ["--verbatim", "--no-plan", "--no-subagents", "--no-memory", "--disable-web-search", "--always-approve"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--tools") + 1], GROK_WORKER_TOOL_IDS.join(","));
  assert.equal(argv[argv.indexOf("--max-turns") + 1], String(GROK_WORKER_MAX_TURNS));
  assert.equal(argv.includes("--reasoning-effort"), false, "effort is declared per deployment in config.toml, never compiled");
  assert.equal(argv.includes("--disallowed-tools"), false, "--disallowed-tools is ignored under --tools");
});

test("the compiled system prompt is byte-identical to the contract prompt pinned in the manifest", () => {
  const compiled = defines().get("DBL_GROK_SYSTEM_PROMPT");
  assert.equal(compiled, DAIMON_GROK_SYSTEM_PROMPT);
  assert.equal(createHash("sha256").update(DAIMON_GROK_SYSTEM_PROMPT).digest("hex"), GROK_ENGINE_BROKER.worker.systemPromptSha256);
  assert.match(DAIMON_GROK_SYSTEM_PROMPT, /^[\x20-\x7e]+$/u);
  assert.ok(DAIMON_GROK_SYSTEM_PROMPT.length >= 320 && DAIMON_GROK_SYSTEM_PROMPT.length <= 700, "roughly 80-150 tokens");
  for (const tool of ["daimon__moltnet_read", "daimon__moltnet_send", "use_tool", "search_tool", "read_file"]) assert.ok(DAIMON_GROK_SYSTEM_PROMPT.includes(tool), tool);
});

test("the launcher exports the turn provider capability under the env_key the worker config reads", () => {
  const source = `${read("engineBrokerLauncherCore.inc")}${read("engineBrokerLauncherServer.inc")}`;
  assert.match(source, new RegExp(`"${GROK_BROKER_PROVIDER_CAPABILITY_ENV}=%s"`, "u"));
  assert.match(source, /char \*const envp\[\] = \{home,\s*grok,\s*tmp,\s*mcp_env,\s*provider_env,/u);
  assert.match(renderGrokBrokerWorkerConfig(), new RegExp(`\\nenv_key = "${GROK_BROKER_PROVIDER_CAPABILITY_ENV}"\\n`, "u"));
});

test("the launcher gives every worker a private TMPDIR under its registered home", () => {
  const source = `${read("engineBrokerLauncherCore.inc")}${read("engineBrokerLauncherServer.inc")}`;
  assert.match(source, /snprintf\(tmp, sizeof\(tmp\), "TMPDIR=%s\/tmp", r->home\) >=\s*sizeof\(tmp\)/u);
  assert.match(source, /canonical_path\(r->home, sizeof\(r->home\)\)/u);
  assert.match(source, /char \*const envp\[\] = \{home,\s*grok,\s*tmp,/u);
  assert.equal(GROK_ENGINE_BROKER.worker.home.privateTmp.relativeToWorkerHome, "tmp");
});
