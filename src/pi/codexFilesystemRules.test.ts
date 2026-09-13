import assert from "node:assert/strict";
import test from "node:test";

import { renderCodexArgs } from "./cliEngineSpawn.js";
import { codexFilesystemRules } from "./codexFilesystemRules.js";

test("prunes redundant nested denies independently of declaration order", () => {
  for (const denies of [["/run", "/run/control", "/run/control/acceptance"], ["/run/control/acceptance", "/run/control", "/run"]]) {
    assert.deepEqual(codexFilesystemRules(denies, []), { "/run": "deny" });
  }
  assert.deepEqual(codexFilesystemRules(["/run", "/runner", "/other/control"], []), {
    "/run": "deny", "/runner": "deny", "/other/control": "deny"
  });
});

test("preserves a deny below an intervening readable exception", () => {
  assert.deepEqual(codexFilesystemRules([
    "/vault", "/vault/shared/auth", "/vault/shared/auth/deeper", "/vault/secret"
  ], ["/vault/shared"]), {
    "/vault/shared": "read", "/vault": "deny", "/vault/shared/auth": "deny"
  });
});

test("normalizes aliases before testing ancestry, including a shared path that escapes /run", () => {
  assert.deepEqual(codexFilesystemRules(["/run/", "/run//control/", "/run/../var/lib/private/control/", "/var/lib/private/control"], []), {
    "/run": "deny", "/var/lib/private/control": "deny"
  });
  assert.deepEqual(codexFilesystemRules(["/vault/", "/vault/open//secret/"], ["/vault/unused/../open/"]), {
    "/vault/open": "read", "/vault": "deny", "/vault/open/secret": "deny"
  });
  assert.deepEqual(codexFilesystemRules(["/vault", "/vault/work/secret"], [], "/vault//work/"), {
    "/vault": "deny", "/vault/work/secret": "deny"
  });
});

test("same-path deny wins over a read and does not open a descendant", () => {
  assert.deepEqual(codexFilesystemRules(["/vault", "/vault/auth"], ["/vault"]), { "/vault": "deny" });
});

test("implicit workspace write is an intervening exception, including in production argv", () => {
  const denies = ["/vault", "/vault/workspace/secret", "/vault/workspace/secret/deeper"];
  assert.deepEqual(codexFilesystemRules(denies, [], "/vault/workspace"), {
    "/vault": "deny", "/vault/workspace/secret": "deny"
  });
  const args = renderCodexArgs({ codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    codexSandboxProtectedPaths: denies }, "/vault/workspace", "http://127.0.0.1:1/mcp");
  const config = args.find(arg => arg.startsWith("permissions="))!;
  assert.ok(config.includes('"/vault/workspace/secret"="deny"'));
  assert.ok(!config.includes('"/vault/workspace/secret/deeper"'));
});

test("root deny subsumes descendants and a same-path workspace deny remains authoritative", () => {
  assert.deepEqual(codexFilesystemRules(["/", "/run"], []), { "/": "deny" });
  assert.deepEqual(codexFilesystemRules(["/workspace", "/workspace/secret"], [], "/workspace"), { "/workspace": "deny" });
  assert.deepEqual(codexFilesystemRules([], [], "/workspace"), {});
});

test("pruning preserves the most specific permission across alternating rules", () => {
  const deny = ["/v", "/v/a", "/v/a/read/secret", "/v/a/read/secret/deeper", "/v/work/secret"];
  const read = ["/v/a/read", "/v/a/read/secret/open"];
  const before = { "/v/work": "write", ...Object.fromEntries(read.map(p => [p, "read"])), ...Object.fromEntries(deny.map(p => [p, "deny"])) };
  const after = { "/v/work": "write", ...codexFilesystemRules(deny, read, "/v/work") };
  const permission = (rules: Record<string, string>, target: string): string | undefined => Object.entries(rules)
    .filter(([root]) => target === root || target.startsWith(`${root}/`)).sort(([a], [b]) => b.length - a.length)[0]?.[1];
  for (const entry of [...deny, ...read, "/v/work", "/v/work/secret", "/v/ab", "/other"]) {
    for (const target of [entry, `${entry}/file`]) assert.equal(permission(after, target), permission(before, target), target);
  }
});
