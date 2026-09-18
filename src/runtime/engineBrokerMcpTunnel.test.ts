import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import test from "node:test";

import { awaitMcpTunnelDrain } from "./engineBrokerMcpFacade.js";

const withDeadline = async <T>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};

/**
 * The relay parks on this await whenever a tunnel is backpressured, and a
 * parked await is invisible from outside: no status, no refusal, no line. So
 * the assertion is that it settles at all — on a client that hung up
 * mid-write, on the turn's abort, and on a genuine drain — with a deadline
 * standing in for the hang.
 */
test("a backpressured MCP tunnel always settles: on a hang-up, on the turn's abort, and on a real drain", async () => {
  const parked = new Map<string, Promise<string>>();
  // One controller per phase: the turn whose abort is under test must not be
  // the turn that is still relaying.
  const controllers = new Map<string, AbortController>();
  const server = createServer((request, response) => {
    const phase = request.url ?? "";
    const controller = new AbortController(); controllers.set(phase, controller);
    response.writeHead(200, { "content-type": "text/event-stream" });
    // A paused client cannot absorb this, so `write` reports backpressure and
    // the relay would park exactly here.
    response.write("data: open\n\n");
    if (phase === "/drain") assert.equal(response.write(Buffer.alloc(16 * 1024 * 1024, 0x61)), false, "a paused client must backpressure the tunnel");
    parked.set(phase, awaitMcpTunnelDrain(response, controller.signal).then(() => "drained", (error: Error) => error.message));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error();
  const open = (phase: string): Promise<Socket> => new Promise((resolve) => {
    const socket = connect(address.port, "127.0.0.1", () => socket.write(`GET ${phase} HTTP/1.1\r\nhost: facade\r\n\r\n`));
    socket.once("data", () => { socket.pause(); resolve(socket); });
  });
  const settled = (phase: string): Promise<string> => withDeadline(parked.get(phase)!, 3_000, `the ${phase} await never settled: the relay is parked`);
  const sockets: Socket[] = [];
  try {
    sockets.push(await open("/hangup"));
    sockets[0]!.destroy();
    assert.equal(await settled("/hangup"), "MCP tunnel closed", "a client that hung up mid-write wakes the await");
    sockets.push(await open("/abort"));
    controllers.get("/abort")!.abort();
    assert.equal(await settled("/abort"), "MCP tunnel aborted", "the turn's own abort wakes the await");
    const draining = await open("/drain");
    sockets.push(draining);
    draining.resume();
    assert.equal(await settled("/drain"), "drained", "a client that resumes reading resolves the await");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
