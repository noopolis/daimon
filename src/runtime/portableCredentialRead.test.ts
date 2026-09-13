import assert from "node:assert/strict";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { materializePortableCredential } from "./portableCredentialMaterial.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const altered = (entry: Stats, patch: Partial<Stats>): Stats => Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, patch);
async function fixture(run: (agent: OrganizationRuntimeAgentConfig, source: string, destination: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "daimon-credential-descriptor-"));
  const agent: OrganizationRuntimeAgentConfig = { id: "agent:codex", name: "Codex", instructions: "Unused.", workspacePath: `${root}/workspace`, runtimeHomePath: `${root}/home`, engine: { kind: "codex" } };
  const source = `${agent.runtimeHomePath}/.daimon-inbound/codex-auth`, destination = `${agent.runtimeHomePath}/.codex/auth.json`;
  await fs.mkdir(path.dirname(source), { recursive: true, mode: 0o700 });
  await fs.writeFile(source, "dummy-credential", { mode: 0o600 });
  try { await run(agent, source, destination); }
  finally { mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(root, { recursive: true, force: true }); }
}

test("opens before validation when a bind's pathname metadata refreshes on open", async () => {
  await fixture(async (agent, source, destination) => {
    const originalOpen = fs.open, originalLstat = fs.lstat;
    const order: string[] = [];
    let opened = false;
    mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const entry = await originalLstat(...args);
      if (args[0] !== source) return entry;
      order.push("path");
      return opened ? entry : altered(entry as Stats, { uid: (process.getuid?.() ?? 0) + 1 });
    });
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === source) {
        order.push("open"); opened = true;
        assert.ok((Number(args[1]) & constants.O_NOFOLLOW) !== 0);
        assert.ok((Number(args[1]) & constants.O_NONBLOCK) !== 0);
        const stat = handle.stat.bind(handle), read = handle.read.bind(handle);
        mock.method(handle, "stat", async () => { order.push("descriptor"); return stat(); });
        mock.method(handle, "read", (buffer: Buffer, offset: number, length: number, position: number) => { order.push("read"); return read(buffer, offset, length, position); });
      }
      return handle;
    });
    syncBuiltinESMExports();
    assert.equal(await materializePortableCredential(agent, agent.runtimeHomePath), "created");
    assert.deepEqual(order, ["open", "descriptor", "path", "read", "read", "descriptor", "path"]);
    assert.equal(await fs.readFile(destination, "utf8"), "dummy-credential");
  });
});

for (const [name, patch] of [
  ["owner", { uid: (process.getuid?.() ?? 0) + 1 }], ["mode", { mode: 0o100644 }],
  ["link count", { nlink: 2 }], ["empty", { size: 0 }], ["oversize", { size: 65537 }],
  ["directory", { mode: 0o040600 }]
] as const) test(`rejects unsafe descriptor ${name} before reading`, async () => {
  await fixture(async (agent, source, destination) => {
    const originalOpen = fs.open;
    let reads = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === source) {
        const entry = await handle.stat(), read = handle.read.bind(handle);
        mock.method(handle, "stat", async () => altered(entry, patch));
        mock.method(handle, "read", (buffer: Buffer, offset: number, length: number, position: number) => { reads++; return read(buffer, offset, length, position); });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(materializePortableCredential(agent, agent.runtimeHomePath), /credential materialization failed/u);
    assert.equal(reads, 0);
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  });
});

for (const phase of ["before", "after"] as const) test(`rejects a pathname replaced ${phase} the read`, async () => {
  await fixture(async (agent, source, destination) => {
    const originalLstat = fs.lstat;
    let paths = 0;
    mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const entry = await originalLstat(...args);
      if (args[0] !== source) return entry;
      paths++;
      return paths >= (phase === "before" ? 1 : 2) ? altered(entry as Stats, { ino: Number(entry.ino) + 1 }) : entry;
    });
    syncBuiltinESMExports();
    await assert.rejects(materializePortableCredential(agent, agent.runtimeHomePath), /credential materialization failed/u);
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  });
});

test("rejects descriptor metadata and byte-length changes during the read", async () => {
  for (const changed of ["mtime", "bytes"] as const) await fixture(async (agent, source, destination) => {
    const originalOpen = fs.open;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === source) {
        const entry = await handle.stat(); let stats = 0;
        mock.method(handle, "stat", async () => ++stats === 1 || changed === "bytes" ? entry : altered(entry, { mtimeMs: entry.mtimeMs + 1 }));
        if (changed === "bytes") mock.method(handle, "read", async (buffer: Buffer) => ({ bytesRead: 0, buffer }));
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(materializePortableCredential(agent, agent.runtimeHomePath), /credential materialization failed/u);
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  });
});

test("assembles partial descriptor reads within one expected-size-plus-one buffer", async () => {
  await fixture(async (agent, source, destination) => {
    const originalOpen = fs.open, expected = await fs.readFile(source);
    const buffers = new Set<Buffer>(); let calls = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === source) {
        const read = handle.read.bind(handle);
        mock.method(handle, "readFile", () => { throw Error("unbounded read forbidden"); });
        mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          calls++; buffers.add(buffer);
          assert.equal(buffer.length, expected.length + 1);
          assert.equal(position, offset); assert.ok(offset + length <= buffer.length);
          return read(buffer, offset, Math.min(length, 3), position);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    assert.equal(await materializePortableCredential(agent, agent.runtimeHomePath), "created");
    assert.deepEqual(await fs.readFile(destination), expected);
    assert.equal(buffers.size, 1); assert.equal(calls, Math.ceil(expected.length / 3) + 1);
  });
});

for (const partial of [false, true]) test(`growth after safe metadata remains byte-bounded (${partial ? "partial" : "full"} reads)`, async () => {
  await fixture(async (agent, source, destination) => {
    const originalOpen = fs.open, expectedSize = (await fs.stat(source)).size;
    const buffers = new Set<Buffer>(); let calls = 0, bytes = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === source) {
        const read = handle.read.bind(handle);
        mock.method(handle, "readFile", () => { throw Error("unbounded read forbidden"); });
        mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (calls++ === 0) await fs.truncate(source, 16 * 1024 * 1024);
          buffers.add(buffer); assert.equal(buffer.length, expectedSize + 1);
          assert.ok(length > 0 && offset + length <= buffer.length);
          const result = await read(buffer, offset, partial ? 1 : length, position); bytes += result.bytesRead; return result;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(materializePortableCredential(agent, agent.runtimeHomePath), /credential materialization failed/u);
    assert.equal(bytes, expectedSize + 1); assert.equal(buffers.size, 1);
    assert.equal(calls, partial ? expectedSize + 1 : 1);
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  });
});

for (const size of [0, 5]) test(`rejects truncation to ${size} bytes after safe metadata`, async () => {
  await fixture(async (agent, source, destination) => {
    const originalOpen = fs.open; let calls = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === source) {
        const read = handle.read.bind(handle);
        mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (calls++ === 0) await fs.truncate(source, size);
          return read(buffer, offset, length, position);
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(materializePortableCredential(agent, agent.runtimeHomePath), /credential materialization failed/u);
    assert.equal(calls, size === 0 ? 1 : 2);
    await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  });
});
