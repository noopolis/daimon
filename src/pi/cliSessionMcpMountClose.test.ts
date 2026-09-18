import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createCliSessionFactory } from "./cliSession.js";

type PublishedTurn = { readonly message: { readonly content: readonly unknown[] } };

/**
 * A finished turn must not wait on a connection to its own per-wake MCP mount.
 *
 * The mount's HTTP server is torn down on the wake's completion path, and
 * `Server.close()` only stops accepting: it waits for every open connection.
 * The MCP transport ends the sessions it knows about, but a connection it has
 * no record of — a socket opened before `initialize`, or an idle HTTP
 * keep-alive socket a client's connection pool is still holding — is not its
 * to end. The broker MCP facade is exactly such a client: relaying a turn's
 * session leaves pooled connections to the mount behind it.
 *
 * Measured before this was bounded: the broker turn returned its result and
 * the wake then never completed and never published — the terminal evidence
 * that is the whole point of letting a finished turn finish.
 */
const TURN_COMPLETION_BOUND_MS = 5_000;

test("a finished Grok broker turn publishes without waiting on an open connection to its own MCP mount", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-mount-close-"));
  const peers: Socket[] = [];
  const hangUp = (): void => { for (const peer of peers) peer.destroy(); };
  try {
    const { session } = await createCliSessionFactory({
      engine: "grok",
      command: "/nonexistent-engine",
      grokBrokerTurn: async (_prompt, mcpEndpoint) => {
        // A peer holding a connection the transport never saw an `initialize`
        // on: none of this connection is the mount's own session state.
        const peer = connect({ host: "127.0.0.1", port: Number(new URL(mcpEndpoint).port) });
        peers.push(peer);
        peer.on("error", () => undefined);
        await new Promise<void>((resolve, reject) => { peer.once("connect", resolve); peer.once("error", reject); });
        return "Filed and delivered.";
      }
    })({ cwd: root });
    const published: PublishedTurn[] = [];
    session.subscribe((event) => { published.push(event as unknown as PublishedTurn); });
    try {
      const settled = session.prompt("wake").then(() => "completed" as const);
      const outcome = await Promise.race([settled, delay(TURN_COMPLETION_BOUND_MS).then(() => "parked" as const)]);
      // Hang the peer up before asserting, so a regression reports the parked
      // wake instead of parking the suite's own teardown behind it.
      hangUp();
      assert.equal(outcome, "completed", `the finished wake did not complete within ${TURN_COMPLETION_BOUND_MS}ms`);
      assert.equal(published.length, 1);
      assert.deepEqual(published[0]?.message.content, [{ type: "text", text: "Filed and delivered." }]);
    } finally { hangUp(); await session.disposeAsync?.(); }
  } finally {
    hangUp();
    await rm(root, { recursive: true, force: true });
  }
});
