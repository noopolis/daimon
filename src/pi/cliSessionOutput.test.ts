import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLI_ENGINE_MAX_DIAGNOSTIC_BYTES,
  CLI_ENGINE_MAX_OUTPUT_BYTES,
  createCliSessionFactory,
  readChild,
  spawnEngine
} from "./cliSession.js";
import { GrokSubscriptionAuthenticationRejectedError } from "../runtime/grokAuthenticationError.js";

test("verbose progress stderr is drained without invalidating a bounded successful reply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-stderr-progress-"));
  const engine = path.join(root, "verbose-success.mjs");
  await writeFile(engine, [
    `process.stderr.write("p".repeat(${CLI_ENGINE_MAX_OUTPUT_BYTES * 8}));`,
    'process.stdout.write("valid assistant reply");'
  ].join("\n"));
  try {
    const child = spawnEngine({
      command: process.execPath,
      commandArgs: [engine],
      engine: "agy",
      maxToolTurns: 1,
      timeoutMs: 10_000
    }, "verbose", { cwd: root }, undefined);
    assert.equal(await readChild(child, 10_000, []), "valid assistant reply");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed verbose stderr retains a redacted bounded window of its head AND its tail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-stderr-diagnostic-"));
  const engine = path.join(root, "verbose-failure.mjs");
  const secret = "bounded-diagnostic-secret-value";
  await writeFile(engine, [
    // The real shape of an early death: the cause first, then a flood, then
    // the last thing the child happened to print. A pure tail kept only the
    // last of the three.
    `process.stderr.write(${JSON.stringify("first-cause: profile refused\n")});`,
    `process.stderr.write("p".repeat(${CLI_ENGINE_MAX_OUTPUT_BYTES * 8}));`,
    `process.stderr.write(${JSON.stringify(` final-error ${secret}`)});`,
    "process.exitCode = 7;"
  ].join("\n"));
  try {
    const child = spawnEngine({
      command: process.execPath,
      commandArgs: [engine],
      engine: "agy",
      maxToolTurns: 1,
      timeoutMs: 10_000
    }, "verbose", { cwd: root }, undefined);
    await assert.rejects(readChild(child, 10_000, [secret]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CLI engine exited 7/);
      assert.match(error.message, /first-cause: profile refused/, "the head of the output is the error, and must survive the bound");
      assert.match(error.message, /final-error \[REDACTED\]/);
      assert.match(error.message, /\[… \d+ bytes elided …\]/, "and what was dropped between the two ends is named");
      assert.equal(error.message.includes(secret), false);
      assert.ok(Buffer.byteLength(error.message) <= CLI_ENGINE_MAX_DIAGNOSTIC_BYTES + 80);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The mirror of the long-secret case, at the other cut. Retaining both ends
 * only stays safe while each end carries a whole secret's worth beyond its
 * reported share: sizing the two ends by halving one shared budget let a
 * 2000-byte secret straddle the cut and leak its own tail verbatim.
 */
test("a secret straddling the head's own retention edge is still redacted whole", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-head-edge-secret-"));
  const engine = path.join(root, "head-edge-secret.mjs");
  // The first ten bytes are a distinctive token, so any surviving prefix of
  // this credential is visible to the assertion rather than merely shorter.
  const secret = `CREDENTIAL-${"z".repeat(200)}-END`;
  // Land it across the edge of the head's REPORTED share
  // (`CLI_ENGINE_MAX_DIAGNOSTIC_BYTES / 2`): 80 bytes inside the window, the
  // rest past it. Only the extra secret-length the head retains beyond that
  // share lets the redactor match it whole; without it those 80 bytes are a
  // verbatim credential prefix in the diagnostic.
  const pad = Math.floor(CLI_ENGINE_MAX_DIAGNOSTIC_BYTES / 2) - 80;
  await writeFile(engine, [
    `process.stderr.write("h".repeat(${pad}));`,
    `process.stderr.write(${JSON.stringify(secret)});`,
    `process.stderr.write("p".repeat(${CLI_ENGINE_MAX_OUTPUT_BYTES * 8}));`,
    `process.stderr.write(${JSON.stringify(" terminal-detail")});`,
    "process.exitCode = 9;"
  ].join("\n"));
  try {
    const child = spawnEngine({
      command: process.execPath, commandArgs: [engine], engine: "agy",
      maxToolTurns: 1, timeoutMs: 10_000
    }, "verbose", { cwd: root }, undefined);
    await assert.rejects(readChild(child, 10_000, [secret]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /terminal-detail/u, "the tail still reports the last words");
      assert.doesNotMatch(error.message, /CREDENTIAL|z{32}/u, "no fragment of the secret may survive the cut");
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("redacts a 2000-byte exact secret before retaining a failed stderr tail", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cli-long-secret-"));
  const engine = path.join(root, "long-secret-failure.mjs");
  const secret = `secret-start-${"q".repeat(1970)}-secret-end`;
  await writeFile(engine, [
    `process.stderr.write("p".repeat(${CLI_ENGINE_MAX_OUTPUT_BYTES * 8}));`,
    `process.stderr.write(${JSON.stringify(` failure ${secret} terminal-detail`)});`,
    "process.exitCode = 9;"
  ].join("\n"));
  try {
    const child = spawnEngine({
      command: process.execPath, commandArgs: [engine], engine: "agy",
      maxToolTurns: 1, timeoutMs: 10_000
    }, "verbose", { cwd: root }, undefined);
    await assert.rejects(readChild(child, 10_000, [secret]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /terminal-detail/u);
      assert.doesNotMatch(error.message, /secret-start|secret-end|q{32}/u);
      assert.ok(Buffer.byteLength(error.message) <= CLI_ENGINE_MAX_DIAGNOSTIC_BYTES + 80);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok replies redact both the staged credential and a credential rotated during the turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-output-redaction-"));
  const engine = path.join(root, "grok.mjs");
  const oldSecret = "old-access-secret-1234567890";
  const rotatedSecret = "rotated-refresh-secret-0987654321";
  const reply = `provider echoed ${oldSecret} and ${rotatedSecret}`;
  await writeFile(engine, `const a=process.argv.slice(2);if(a.includes("mcp"))process.stdout.write("ok");else{const r=${JSON.stringify(reply)},s="session";process.stdout.write(JSON.stringify({type:"assistant",session_id:s,parent_tool_use_id:null,message:{role:"assistant",stop_reason:"end_turn",content:[{type:"text",text:r}]}})+"\\n"+JSON.stringify({type:"result",subtype:"success",is_error:false,stop_reason:"end_turn",errors:[],result:r,session_id:s})+"\\n");}`);
  let reads = 0;
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "grok", engineHomePath: path.join(root, ".grok"),
      credentialSecretValues: async () => ++reads === 1 ? [oldSecret] : [rotatedSecret]
    })({ cwd: root });
    let emitted = "";
    session.subscribe((event) => {
      if (event.type === "turn_end") {
        const message = event.message as { content: Array<{ text?: string; type: string }> };
        emitted = message.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
      }
    });
    await session.prompt("work");
    assert.equal(reads, 2);
    assert.doesNotMatch(emitted, /old-access|rotated-refresh/u);
    assert.match(emitted, /\[REDACTED\]/u);
    await session.disposeAsync?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok auth rejection is typed and never retains raw credential diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-auth-rejection-"));
  const engine = path.join(root, "grok.mjs");
  const secret = "access-auth-rejection-secret-123456";
  await writeFile(engine, `const a=process.argv.slice(2);if(a.includes("mcp"))process.stdout.write("ok");else{process.stderr.write("Authentication rejected by server ${secret}");process.exitCode=7;}`);
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "grok", engineHomePath: path.join(root, ".grok"),
      credentialSecretValues: async () => [secret]
    })({ cwd: root });
    await assert.rejects(session.prompt("work"), (error: unknown) => {
      assert.ok(error instanceof GrokSubscriptionAuthenticationRejectedError);
      assert.doesNotMatch(error.message, /secret|server/u);
      return true;
    });
    await session.disposeAsync?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok auth rejection is classified before a long secret and verbose tail are truncated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-streaming-auth-rejection-"));
  const engine = path.join(root, "grok.mjs");
  const secret = `access-start-${"s".repeat(1970)}-access-end`;
  await writeFile(engine, [
    "const a=process.argv.slice(2);",
    "if(a.includes('mcp'))process.stdout.write('ok');",
    `else{process.stderr.write("RefreshToken");process.stderr.write("Rejected "+${JSON.stringify(secret)}+" "+"tail".repeat(250));process.exitCode=7;}`
  ].join("\n"));
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "grok", engineHomePath: path.join(root, ".grok"),
      credentialSecretValues: async () => [secret]
    })({ cwd: root });
    await assert.rejects(session.prompt("work"), (error: unknown) => {
      assert.ok(error instanceof GrokSubscriptionAuthenticationRejectedError);
      assert.doesNotMatch(error.message, /RefreshToken|access-start|access-end|s{32}|tail/u);
      return true;
    });
    await session.disposeAsync?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});
