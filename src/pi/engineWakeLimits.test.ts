import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling, resolveEngineWakeLimitOverrides } from "./engineWakeLimits.js";

test("engine-neutral wake bounds drive Codex, with the Codex names kept as aliases", () => {
  assert.equal(resolveCodexWakeTimeoutMs({}), 240_000);
  assert.equal(resolveCodexWakeTokenCeiling({}), 300_000);
  assert.equal(resolveCodexWakeTimeoutMs({ DAIMON_ENGINE_WAKE_TIMEOUT_MS: "5000" }), 5_000);
  assert.equal(resolveCodexWakeTokenCeiling({ DAIMON_CODEX_WAKE_TOKEN_CEILING: "7000" }), 7_000);
  assert.equal(resolveCodexWakeTokenCeiling({ DAIMON_ENGINE_WAKE_TOKEN_CEILING: "7000", DAIMON_CODEX_WAKE_TOKEN_CEILING: "7000" }), 7_000);
  assert.throws(() => resolveCodexWakeTokenCeiling({ DAIMON_ENGINE_WAKE_TOKEN_CEILING: "7000", DAIMON_CODEX_WAKE_TOKEN_CEILING: "8000" }), /disagree/u);
  assert.throws(() => resolveCodexWakeTimeoutMs({ DAIMON_ENGINE_WAKE_TIMEOUT_MS: "0" }), /positive integer/u);
});

test("the broker receives only the bounds an operator actually set, as lowering limits", () => {
  assert.equal(resolveEngineWakeLimitOverrides({}), undefined);
  assert.deepEqual(resolveEngineWakeLimitOverrides({ DAIMON_ENGINE_WAKE_TOKEN_CEILING: "400000" }), { maxTokens: 400_000 });
  assert.deepEqual(resolveEngineWakeLimitOverrides({ DAIMON_CODEX_WAKE_TIMEOUT_MS: "480000", DAIMON_ENGINE_WAKE_TOKEN_CEILING: "1" }), { timeoutMs: 480_000, maxTokens: 1 });
});
