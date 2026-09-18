import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { NativeBrokerTurn } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { createLedgeredGrokInferenceGrants } from "./grokInferenceGrants.js";
import { dedupeInferenceUsageRows, INFERENCE_USAGE_LEDGER_VERSION } from "./inferenceUsageLedger.js";
import { WakeFuse } from "./wakeFuse.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const judgeBody = JSON.stringify({ messages: [{ role: "system", content: "judge" }, { role: "user", content: "Rate." }], model: "grok-4.5", reasoning_effort: "medium", stream: true, stream_options: { include_usage: true } });
const post = (port: number, bearer: string, body: string): Promise<number> => new Promise((resolve, reject) => {
  const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${bearer}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
  req.on("error", reject); req.end(body);
});
const rows = async (file: string): Promise<Record<string, unknown>[]> => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const eventually = async (check: () => Promise<boolean>): Promise<void> => { for (let attempt = 0; attempt < 100 && !await check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 10)); };

test("a judge grant used while a subject turn runs meters only into the inference ledger and never into the subject turn, its ledger or the wake fuse", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-inference-ledger-"));
  const usageLedger = path.join(root, "slot0", "usage.jsonl"), inferenceLedger = path.join(root, "evaluator", "inference.jsonl");
  await mkdir(path.dirname(usageLedger)); await mkdir(path.dirname(inferenceLedger));
  const grants = createLedgeredGrokInferenceGrants(inferenceLedger);
  const upstreamUsage = (model: string) => ({ prompt_tokens: model === "grok-4.6" ? 1_000 : 40_000, completion_tokens: 50, total_tokens: model === "grok-4.6" ? 1_050 : 40_050 });
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async (request) => {
    const model = (JSON.parse(Buffer.from(request.body).toString("utf8")) as { model: string }).model;
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(`data: ${JSON.stringify({ choices: [], usage: upstreamUsage(model) })}\n\ndata: [DONE]\n\n`) };
  }, undefined, 0, grants);
  try {
    const issued = grants.issue({ model: "grok-4.5", reasoningEffort: "medium", purpose: "judge" });
    const registration: EngineBrokerServiceRegistration = { agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: usageLedger, limits: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 }, model: { model: "grok-4.6", reasoningEffort: "low" } };
    let judgeStatus = 0;
    const deps: GrokEngineBrokerTurnDependencies = {
      turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy, credentialStale: () => false,
      mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => undefined },
      prepareIsolation: async () => async () => undefined,
      runNative: async (input: NativeBrokerTurn) => {
        assert.equal(await post(proxy.port, input.providerCapability, leanBody), 200);
        judgeStatus = await post(proxy.port, issued.token, judgeBody);
        assert.equal(await post(proxy.port, input.providerCapability, leanBody), 200);
        return { text: "", workerPid: 4_242, workerUid: 2_200, startTicks: 99n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 4_242, workerUid: 2_200, startTicks: "99" } };
      }
    };
    await assert.rejects(runGrokEngineBrokerTurn(deps, registration, "wake-1", "prompt", "http://127.0.0.1:43124/mcp"));
    assert.equal(judgeStatus, 200);
    await eventually(async () => (await rows(inferenceLedger)).length > 0);

    const subject = await rows(usageLedger), subjectRequests = await rows(path.join(path.dirname(usageLedger), "requests.jsonl")), inference = await rows(inferenceLedger);
    assert.deepEqual(subject.map((row) => [row.requests ?? row.calls, row.total, row.model]), [[2, 2_100, "grok-4.6"]], "the subject turn counts only its own two requests");
    assert.deepEqual(subjectRequests.map((row) => row.total), [1_050, 1_050]);
    assert.deepEqual(inference.map((row) => [row.v, row.kind, row.purpose, row.grant, row.request, row.model, row.total, row.usage_source]), [[INFERENCE_USAGE_LEDGER_VERSION, "inference", "judge", issued.grantId, 0, "grok-4.5", 40_050, "upstream"]]);

    // Even if an inference row reached the subject ledger, the wake fuse would not count it:
    // 2,100 subject tokens are under a 2,101 ceiling; counted, the 40,050-token row would trip it.
    await writeFile(usageLedger, [...subject, ...inference].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const fuseDirectory = path.join(root, "fuse"); await mkdir(fuseDirectory);
    const fuse = await WakeFuse.open({ organizationKey: "org", now: () => new Date(Date.parse(String(subject[0]!.at)) - 1), environment: { DAIMON_WAKE_FUSE_DIRECTORY: fuseDirectory, DAIMON_WAKE_FUSE_EPOCH: "grants", DAIMON_WAKE_FUSE_MAX_WAKES: "10", DAIMON_WAKE_FUSE_MAX_TOKENS: "2101", DAIMON_TURN_USAGE_LEDGER_PATH: usageLedger } });
    assert.deepEqual(await fuse.admit("foreman", "next"), { state: "admitted" });
  } finally { grants.close(); await proxy.close(); await rm(root, { recursive: true, force: true }); }
});

test("inference readers count each (grant, request) once", () => {
  type Row = Readonly<{ grant?: string; request?: number; total: number }>;
  const row = (grant: string, request: number, total: number): Row => ({ grant, request, total });
  assert.deepEqual(dedupeInferenceUsageRows<Row>([row("a", 0, 1), row("a", 1, 2), row("a", 0, 1), row("b", 0, 3), { total: 9 }]).map((value) => value.total), [1, 2, 3]);
});
