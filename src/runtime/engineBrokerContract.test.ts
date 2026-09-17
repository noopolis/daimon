import assert from "node:assert/strict";
import test from "node:test";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { ENGINE_BROKER_VERSION } from "./engineBrokerProtocol.js";
import { ENGINE_BROKER_SERVICE_V1, ENGINE_BROKER_SERVICE_V2 } from "./engineBrokerServiceConfig.js";
import { ENGINE_BROKER_TURN_RECORD_V1, ENGINE_BROKER_TURN_RECORD_V2 } from "./engineBrokerTurnRegistry.js";
import { DEFAULT_CODEX_WAKE_TIMEOUT_MS, DEFAULT_CODEX_WAKE_TOKEN_CEILING, DAIMON_ENGINE_WAKE_TIMEOUT_MS_ENV, DAIMON_ENGINE_WAKE_TOKEN_CEILING_ENV } from "../pi/engineWakeLimits.js";

test("the manifest pins the broker accounting contract the runtime actually speaks", () => {
  assert.equal(GROK_ENGINE_BROKER.controlProtocolVersion, ENGINE_BROKER_VERSION);
  assert.deepEqual(GROK_ENGINE_BROKER.turnRecordVersions, [ENGINE_BROKER_TURN_RECORD_V1, ENGINE_BROKER_TURN_RECORD_V2]);
  assert.deepEqual(GROK_ENGINE_BROKER.serviceConfigVersions, [ENGINE_BROKER_SERVICE_V1, ENGINE_BROKER_SERVICE_V2]);
  assert.deepEqual(GROK_ENGINE_BROKER.wakeLimitEnvironment, { timeoutMs: DAIMON_ENGINE_WAKE_TIMEOUT_MS_ENV, maxTokens: DAIMON_ENGINE_WAKE_TOKEN_CEILING_ENV });
  assert.deepEqual([GROK_ENGINE_BROKER.turnLimits.v1Defaults.timeoutMs, GROK_ENGINE_BROKER.turnLimits.v1Defaults.maxTokens], [DEFAULT_CODEX_WAKE_TIMEOUT_MS, DEFAULT_CODEX_WAKE_TOKEN_CEILING]);
  assert.ok(GROK_ENGINE_BROKER.turnLimits.bounds.maxRequests[1] <= GROK_ENGINE_BROKER.worker.maxTurns, "the broker request ceiling fires before the launcher --max-turns backstop");
});
