import assert from "node:assert/strict";
import test from "node:test";
import { EngineBrokerGenerationFence, EngineBrokerSingleflight } from "./engineBrokerSingleflight.js";

test("credential refresh is singleflight and generation fenced", async () => {
  const flight = new EngineBrokerSingleflight<number>(); let calls = 0; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operation = async () => { calls += 1; await gate; return 7; };
  const left = flight.run(operation); const right = flight.run(operation); release();
  assert.equal(await left, 7); assert.equal(await right, 7); assert.equal(calls, 1);
  const fence = new EngineBrokerGenerationFence(); const zero = fence.snapshot(); assert.equal(fence.promote(zero), 1);
  assert.throws(() => fence.promote(zero), /conflict/); fence.markStale(); assert.throws(() => fence.snapshot(), /stale/);
});
