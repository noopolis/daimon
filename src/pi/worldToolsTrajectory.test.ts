import assert from "node:assert/strict";
import test from "node:test";

import { createPiWorldTools } from "./worldTools.js";

type WorldTool = ReturnType<typeof createPiWorldTools>[number];
type ToolResult = { content: Array<{ text: string; type: string }>; details: unknown };
const execute = async (tool: WorldTool, params: Record<string, unknown>): Promise<ToolResult> =>
  tool.execute("tool-call", params as never, undefined, undefined, {} as never) as Promise<ToolResult>;
const response = (value: unknown): Response => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("proves a token-free public claim to observe to act trajectory", async () => {
  const bearer = "private-world-bearer";
  const decisionToken = "private-decision-token";
  const requests: Array<{ authorization: string; body: unknown; url: string }> = [];
  const tools = createPiWorldTools({
    world: { url: "http://world/v1/world", tokenEnv: "WORLD_TOKEN" },
    contextRef: { current: Object.freeze({ requestId: "request-trajectory", wakeId: "wake-trajectory" }) },
    readEnvironment: () => bearer,
    fetch: async (url, init) => {
      requests.push({
        authorization: new Headers(init?.headers).get("authorization") ?? "",
        body: JSON.parse(String(init?.body)) as unknown,
        url: String(url),
      });
      if (String(url).endsWith("/claim")) return response({
        decision_id: "decision-trajectory",
        decision_token: decisionToken,
        issued_at_tick: 9,
        valid_through_tick: 99,
      });
      if (String(url).endsWith("/observe")) return response({ tick: 9, visible: ["ball"] });
      return response({ disposition: "queued", receipt_id: "act-trajectory" });
    },
  });
  const select = (name: string): WorldTool => {
    const selected = tools.find((candidate) => candidate.name === name);
    assert.ok(selected);
    return selected;
  };
  const claim = select("world_claim");
  const observe = select("world_observe");
  const act = select("world_act");
  const schemas = [claim, observe, act].map(({ name, parameters }) => ({ name, parameters }));
  assert.equal(JSON.stringify(schemas).includes("token"), false);
  const outputs = [
    await execute(claim, {}),
    await execute(observe, { sense: "world://pitch/sense/vision" }),
    await execute(act, {
      affordance: "world://pitch/affordance/kick",
      target: "world://pitch/entity/ball",
      input: { force: 1 },
    }),
  ];
  assert.deepEqual(outputs.map(({ details }) => details), [
    { claimed: true, issued_at_tick: 9, valid_through_tick: 99 },
    { tick: 9, visible: ["ball"] },
    { disposition: "queued", receipt_id: "act-trajectory" },
  ]);
  assert.equal(JSON.stringify(outputs).includes(bearer), false);
  assert.equal(JSON.stringify(outputs).includes(decisionToken), false);
  assert.deepEqual(requests, [
    {
      authorization: `Bearer ${bearer}`,
      body: { request_id: "request-trajectory", wake_id: "wake-trajectory" },
      url: "http://world/v1/world/claim",
    },
    {
      authorization: `Bearer ${bearer}`,
      body: { decision_token: decisionToken, sense: "world://pitch/sense/vision" },
      url: "http://world/v1/world/observe",
    },
    {
      authorization: `Bearer ${bearer}`,
      body: {
        decision_token: decisionToken,
        request_id: "request-trajectory",
        affordance: "world://pitch/affordance/kick",
        target: "world://pitch/entity/ball",
        input: { force: 1 },
      },
      url: "http://world/v1/world/act",
    },
  ]);
});
