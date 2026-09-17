import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { grokBrokerWorkerConfigSha256, renderGrokBrokerWorkerConfig } from "./grokBrokerWorkerConfig.js";
import { assertGrokWorkerConfigBytes, assertGrokWorkerHomeEntries, verifyGrokWorkerHome } from "./grokWorkerHomeAttestation.js";

type Kind = "dir" | "file" | "link";
const entry = (kind: Kind, mode: number, uid = 0, nlink = 1) => ({
  uid, mode: (kind === "dir" ? 0o040000 : kind === "file" ? 0o100000 : 0o120000) | mode, nlink,
  isFile: () => kind === "file", isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link"
});
const files = ["config.toml", "managed_config.toml", "requirements.toml", "sandbox.toml", "trusted_folders.toml"];
const layout = (overrides: Record<string, ReturnType<typeof entry> | undefined> = {}) => ({
  ".": entry("dir", 0o1771), sessions: entry("dir", 0o1771), ...Object.fromEntries(files.map((name) => [name, entry("file", 0o444)])), ...overrides
});

test("accepts the root-owned sticky worker home with root-owned read-only config and trust files", () => {
  assert.doesNotThrow(() => assertGrokWorkerHomeEntries(layout()));
  assert.doesNotThrow(() => assertGrokWorkerHomeEntries(layout({ ".": entry("dir", 0o711), sessions: entry("dir", 0o750) })));
});

test("refuses a worker home where the worker could change its config or trust state", () => {
  const refusals: Record<string, ReturnType<typeof layout>> = {
    "worker-owned home": layout({ ".": entry("dir", 0o1771, 2200) }),
    "group-writable home without sticky bit": layout({ ".": entry("dir", 0o771) }),
    "world-writable home": layout({ ".": entry("dir", 0o1777) }),
    "worker-owned sessions": layout({ sessions: entry("dir", 0o700, 2200) }),
    "group-writable sessions without sticky bit": layout({ sessions: entry("dir", 0o770) })
  };
  for (const name of files) {
    refusals[`${name} missing`] = layout({ [name]: undefined });
    refusals[`${name} worker-owned`] = layout({ [name]: entry("file", 0o444, 2200) });
    refusals[`${name} owner-writable`] = layout({ [name]: entry("file", 0o644) });
    refusals[`${name} group-writable`] = layout({ [name]: entry("file", 0o464) });
    refusals[`${name} symlink`] = layout({ [name]: entry("link", 0o444) });
    refusals[`${name} hard-linked`] = layout({ [name]: entry("file", 0o444, 0, 2) });
  }
  for (const [label, entries] of Object.entries(refusals)) assert.throws(() => assertGrokWorkerHomeEntries(entries), /attestation unavailable/u, label);
});

test("refuses a real home that is not root-owned even when every file exists", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "sessions"));
  for (const name of files) await writeFile(path.join(home, name), "", { mode: 0o444 });
  await assert.rejects(verifyGrokWorkerHome(home, "0".repeat(64)), /attestation unavailable/u);
});

test("accepts only the renderer's exact config bytes for the declared model policy", () => {
  const declared = { model: "grok-4.6", reasoningEffort: "low" } as const;
  const bytes = Buffer.from(renderGrokBrokerWorkerConfig(declared));
  assert.doesNotThrow(() => assertGrokWorkerConfigBytes(bytes, grokBrokerWorkerConfigSha256(declared)));
  for (const tampered of [
    renderGrokBrokerWorkerConfig({ model: "grok-4.6", reasoningEffort: "high" }),
    renderGrokBrokerWorkerConfig(declared).replace(/\[skills\]\ndisabled = \[[^\]]*\]\n/u, ""),
    renderGrokBrokerWorkerConfig(declared).replace('session_summary = "daimon-session-title-disabled"', 'session_summary = "grok-4.6"'),
    `${renderGrokBrokerWorkerConfig(declared)}\n[mcp_servers.extra]\nurl = "http://127.0.0.1:1/mcp"\n`
  ]) assert.throws(() => assertGrokWorkerConfigBytes(Buffer.from(tampered), grokBrokerWorkerConfigSha256(declared)), /attestation unavailable/u);
});

const ownHome = async (t: { after(fn: () => Promise<void>): void }) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-home-owned-"));
  t.after(async () => { await chmod(home, 0o700); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(home, "sessions"));
  const declared = { model: "grok-4.6", reasoningEffort: "low" } as const;
  for (const name of files) await writeFile(path.join(home, name), name === "config.toml" ? renderGrokBrokerWorkerConfig(declared) : "", { mode: 0o444 });
  await chmod(path.join(home, "sessions"), 0o1771); await chmod(home, 0o1771);
  return { home, sha: grokBrokerWorkerConfigSha256(declared), uid: process.getuid?.() ?? 0 };
};

test("attests a correctly laid out home whose config is the declared renderer output", async (t) => {
  const { home, sha, uid } = await ownHome(t);
  await verifyGrokWorkerHome(home, sha, uid);
  await assert.rejects(verifyGrokWorkerHome(home, grokBrokerWorkerConfigSha256({ model: "grok-4.6", reasoningEffort: "high" }), uid), /attestation unavailable/u);
});

test("refuses a config.toml whose opened inode is not the one lstat saw", async (t) => {
  const { home, sha, uid } = await ownHome(t);
  const probe = await open(path.join(home, "config.toml"), "r");
  const prototype = Object.getPrototypeOf(probe) as { stat: (...args: unknown[]) => Promise<{ ino: number }> };
  await probe.close();
  const original = prototype.stat;
  const swapped = mock.method(prototype, "stat", async function (this: unknown, ...args: unknown[]) {
    const real = await original.apply(this, args);
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino: Number(real.ino) + 1 });
  });
  try { await assert.rejects(verifyGrokWorkerHome(home, sha, uid), /attestation unavailable/u); } finally { swapped.mock.restore(); }
  await verifyGrokWorkerHome(home, sha, uid);
});
