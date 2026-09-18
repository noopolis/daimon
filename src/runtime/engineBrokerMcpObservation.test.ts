import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";

import test from "node:test";

import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import type { EngineBrokerMcpTunnelObservation } from "./engineBrokerMcpCallLog.js";
import { connectClient, FACADE_URL, sharedFacade, startRig, withDeadline } from "./engineBrokerMcpFacadeRig.test.js";

/**
 * What the facade saw while it was relaying, which is the only place a call or
 * a stream is observable *while it is still running*.
 *
 * Daimon writes a tool receipt on completion and nothing at all for the
 * session's GET tunnel, so a call that never returned, a worker parked on an
 * open stream, and a worker doing nothing were one indistinguishable silence.
 * Both instruments are driven here through the real facade.
 */
/**
 * Daimon writes a tool receipt only on completion, so a call that started and
 * never returned reads exactly like a call that was never made — the one path
 * a seven-minute live hang left unlit. The facade is where that difference is
 * visible, and it has to survive the tear-down that ends the turn: a tunnel
 * destroyed when the worker dies must not mark the call it was blocked on as
 * answered, or the instrument erases the very evidence it exists to keep.
 */
test("MCP facade reports a tool call that started and never returned as outstanding, by name", async () => {
  const facade = await sharedFacade();
  const held: ServerResponse[] = [];
  // Two ways for a mount not to answer: never reply at all (`moltnet_read`),
  // or open the stream and never deliver the result (`memory_recall`).
  const target = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const asked = Buffer.concat(chunks).toString("utf8");
      if (asked.includes("moltnet_read")) { held.push(response); return; }
      if (asked.includes("memory_recall")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": open\n\n"); held.push(response); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address(); if (address === null || typeof address === "string") throw new Error();
  const turnId = "turn-outstanding", token = facade.register("agent", turnId, `http://127.0.0.1:${address.port}/mcp`);
  const post = (name: string, signal?: AbortSignal): Promise<Response> => fetch(FACADE_URL, { method: "POST", signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { text: "argument-bytes-that-must-never-be-recorded" } } }) });
  const pending = new AbortController();
  /**
   * A live call's elapsed time grows with every read, so two identical reads
   * mean every relay has settled — the only moment at which "answered" is
   * final. Polling for a name instead would read the log mid-teardown.
   */
  const settled = async (): Promise<ReturnType<typeof facade.observe>> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const before = JSON.stringify(facade.observe(turnId));
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      if (JSON.stringify(facade.observe(turnId)) === before) return facade.observe(turnId);
    }
    throw new Error("the facade's observation never settled");
  };
  const names = (observed: ReturnType<typeof facade.observe>): readonly string[] => (observed?.outstanding ?? []).map((call) => call.name);
  try {
    const answered = await post("daimon__moltnet_send");
    assert.equal(answered.status, 200); await answered.text();
    const hanging = post("daimon__moltnet_read", pending.signal).catch(() => undefined);
    for (let attempt = 0; attempt < 200 && held.length === 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(held.length, 1, "the mount never received the hung tool call");

    const observed = facade.observe(turnId);
    assert.deepEqual(names(observed), ["daimon__moltnet_read"], "the unanswered call must be outstanding, by name");
    assert.equal(observed?.started, 2); assert.equal(observed?.answered, 1, "the completed call must not be outstanding"); assert.equal(observed?.undecoded, 0);
    assert.ok((observed?.outstanding[0]?.outstandingMs ?? -1) >= 0, "an outstanding call reports how long it has been waiting");
    assert.ok(!JSON.stringify(observed).includes("argument-bytes"), "names and timings only: no arguments");

    // The turn's own death tears the tunnel down. The call was still never
    // answered, and must still say so.
    pending.abort(); await hanging;
    const afterTeardown = await settled();
    assert.deepEqual(names(afterTeardown), ["daimon__moltnet_read"], "a torn-down relay is not an answer");
    assert.equal(afterTeardown?.answered, 1);

    // A stream the facade opened and never finished relaying is not an answer
    // either. Awaiting the headers and one chunk puts the facade inside its own
    // streaming relay before the client walks away, which is the branch that
    // decides whether a half-written tunnel counts as an answer.
    const halted = new AbortController();
    const half = await post("memory_recall", halted.signal);
    assert.equal(half.status, 200); await half.body!.getReader().read(); halted.abort();
    const afterHalfRelay = await settled();
    assert.deepEqual(names(afterHalfRelay), ["daimon__moltnet_read", "memory_recall"], "a half-relayed stream is not an answer");
    assert.equal(afterHalfRelay?.answered, 1);

    facade.revoke(turnId);
    assert.equal(facade.observe(turnId), undefined, "a turn the facade never registered observes as absence, not as zero");
  } finally {
    pending.abort(); facade.revoke(turnId);
    for (const response of held) response.destroy();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

/**
 * The channel the call log could not see.
 *
 * A brokered turn's tool calls all answer and its provider requests all close,
 * and the worker can still sit idle to the deadline — parked on the standalone
 * GET SSE tunnel, which stays open for the whole session and, until now, wrote
 * nothing anywhere. This drives the real transport: the tunnel the real client
 * opens must observe as open with an age while it is open, as *delivered* once
 * the mount pushes a frame through it, and as closed once the client ends it.
 *
 * Mutation: remove `calls.openTunnel` from the facade's route and the first
 * assertion goes red (an open tunnel reads as a turn that opened none); remove
 * `tunnel?.close()` from the relay's `finally` and the last one does (a closed
 * tunnel reads as still open, which is the reading the whole instrument is
 * meant to make trustworthy).
 */
test("the facade observes the standalone GET tunnel: open with its age, whether it delivered, and closed when it ends", async () => {
  const rig = await startRig();
  const tunnels = (): EngineBrokerMcpTunnelObservation | undefined => rig.facade.observe(rig.turnId)?.tunnels;
  const until = async (reason: string, ready: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.ok(ready(), reason);
  };
  try {
    // Before any request the turn is registered and has relayed nothing: a
    // measured zero, which is not the same statement as an open tunnel.
    assert.deepEqual(tunnels(), { opened: 0, closed: 0, delivered: 0, open: [] });
    const { client } = await connectClient(rig.capability);
    const notified = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve()));
    try {
      await until("the client never opened its GET tunnel", () => (tunnels()?.open.length ?? 0) > 0);
      const open = tunnels();
      assert.equal(open?.opened, 1); assert.equal(open?.closed, 0);
      assert.ok((open?.open[0]?.openMs ?? -1) >= 0, "an open tunnel reports how long it has been open");
      assert.equal(open?.open[0]?.delivered, false, "a tunnel the mount has not pushed through is held open in silence");
      assert.equal(open?.delivered, 0);

      // The same tunnel, now actually carrying a server frame. "Held open
      // having delivered nothing" and "in use" are different facts about it.
      rig.server.sendToolListChanged();
      await withDeadline(notified, 4_000, "no server notification reached the client");
      await until("the delivered frame was never attributed to the tunnel", () => (tunnels()?.delivered ?? 0) === 1);
      assert.equal(tunnels()?.open[0]?.delivered, true);
      assert.equal(tunnels()?.closed, 0, "a tunnel that delivered is still open");
    } finally {
      await client.close();
    }
    await until("the closed GET tunnel still reads as open", () => (tunnels()?.closed ?? 0) === 1);
    assert.deepEqual(tunnels(), { opened: 1, closed: 1, delivered: 1, open: [] });
  } finally {
    await rig.close();
  }
});
