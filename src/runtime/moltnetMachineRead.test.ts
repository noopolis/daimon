import assert from "node:assert/strict";
import test from "node:test";

import {
  MOLTNET_READ_MAX_PAGES,
  MoltnetMachineError,
  moltnetOperationResult,
  readMoltnetPages,
  type MoltnetReadWirePage
} from "./moltnetMachineRead.js";

const corpus = (count: number): string[] => Array.from({ length: count }, (_value, index) => `m${index + 1}`);

/** A stand-in wire that pages a chronological corpus the way the CLI does. */
function wire(all: readonly string[], options: { readonly rejectAbove?: number; readonly blocked?: string } = {}) {
  const calls: { limit: number; before?: string; after?: string }[] = [];
  const fetch = async (request: { limit: number; before?: string; after?: string }): Promise<MoltnetReadWirePage> => {
    calls.push(request);
    let messages: string[];
    let hasMore = false;
    let nextBefore: string | undefined;
    let nextAfter: string | undefined;
    if (request.after !== undefined) {
      const newer = all.slice(all.indexOf(request.after) + 1);
      hasMore = newer.length > request.limit;
      messages = newer.slice(0, request.limit);
      if (hasMore) nextAfter = messages[messages.length - 1];
    } else {
      const older = request.before === undefined ? [...all] : all.slice(0, all.indexOf(request.before));
      hasMore = older.length > request.limit;
      messages = older.slice(Math.max(0, older.length - request.limit));
      if (hasMore) nextBefore = messages[0];
    }
    if (options.blocked !== undefined && messages.includes(options.blocked)) throw new MoltnetMachineError("read", "transport");
    if (options.rejectAbove !== undefined && messages.length > options.rejectAbove) throw new MoltnetMachineError("read", "transport");
    return { messages, hasMore, ...(nextBefore === undefined ? {} : { nextBefore }), ...(nextAfter === undefined ? {} : { nextAfter }) };
  };
  return { calls, fetch };
}

test("a machine error surfaces its own code instead of a generic refusal", () => {
  assert.throws(
    () => moltnetOperationResult({ version: "moltnet.machine.v1", error: { code: "transport" } }, "read", "read"),
    (error: unknown) => error instanceof MoltnetMachineError && error.code === "transport" && error.message === "Moltnet read failed: transport"
  );
  assert.throws(
    () => moltnetOperationResult({ error: { code: "not_found" } }, "send_nudge", "send"),
    /Moltnet send failed: not_found/u
  );
  assert.throws(() => moltnetOperationResult({ error: {} }, "read", "read"), /Moltnet read failed: unknown/u);
  assert.deepEqual(moltnetOperationResult({ read: { page: { messages: [] } } }, "read", "read"), { page: { messages: [] } });
});

test("a room larger than one page is returned whole and in chronological order", async () => {
  const all = corpus(23);
  const { calls, fetch } = wire(all);
  const read = await readMoltnetPages({ requested: 23, maxBytes: 65_536, fetch });
  assert.deepEqual(read.messages, all, "cursor following must reassemble the room oldest first");
  assert.equal(read.pages, 5);
  assert.equal(read.hasMore, false);
  assert.equal(read.truncated, undefined);
  assert.ok(calls.every((call) => call.limit <= 5), "no page may be requested above the wire page limit");
  assert.equal(calls[0]!.before, undefined);
  assert.equal(calls[1]!.before, "m19", "the second page must follow the first page's next_before");
});

test("a page the wire refuses is halved rather than failing the read", async () => {
  const all = corpus(12);
  const { calls, fetch } = wire(all, { rejectAbove: 2 });
  const read = await readMoltnetPages({ requested: 12, maxBytes: 65_536, fetch });
  assert.deepEqual(read.messages, all);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.limit), [5, 2, 5], "a refusal halves 5 to 2, and the next page retries the full page limit");
  assert.equal(calls.filter((call) => call.limit > 2).length, 5, "every page that could hold three messages is refused once and backed off");
  assert.equal(read.truncated, undefined);
});

test("halving reaches a limit of one before giving up on a page", async () => {
  const all = corpus(6);
  const { calls, fetch } = wire(all, { rejectAbove: 1 });
  const read = await readMoltnetPages({ requested: 6, maxBytes: 65_536, fetch });
  assert.deepEqual(read.messages, all);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.limit), [5, 2, 1]);
});

test("one message that cannot cross the wire truncates the read instead of aborting it", async () => {
  const all = corpus(9);
  const { fetch } = wire(all, { blocked: "m4" });
  const read = await readMoltnetPages({ requested: 9, maxBytes: 65_536, fetch });
  assert.deepEqual(read.messages, ["m5", "m6", "m7", "m8", "m9"], "everything newer than the blockage still reaches the caller");
  assert.equal(read.truncated?.reason, "message_exceeds_machine_wire_caps");
  assert.match(read.truncated!.detail, /4096 bytes/u);
  assert.equal(read.truncated?.cursor, "m5", "the caller is handed the cursor the read stopped at");
  assert.equal(read.hasMore, true);
});

test("a blocked newest message truncates with no cursor rather than throwing", async () => {
  const { fetch } = wire(corpus(3), { blocked: "m3" });
  const read = await readMoltnetPages({ requested: 3, maxBytes: 65_536, fetch });
  assert.deepEqual(read.messages, []);
  assert.equal(read.truncated?.reason, "message_exceeds_machine_wire_caps");
  assert.equal(read.truncated?.cursor, undefined);
});

test("a non-transport machine error is never retried and never swallowed", async () => {
  let calls = 0;
  await assert.rejects(readMoltnetPages({
    requested: 10, maxBytes: 65_536,
    fetch: async () => { calls += 1; throw new MoltnetMachineError("read", "not_found"); }
  }), /Moltnet read failed: not_found/u);
  assert.equal(calls, 1, "only transport refusals are worth halving");
});

test("the requested count bounds the read and reports a resumable cursor", async () => {
  const all = corpus(40);
  const read = await readMoltnetPages({ requested: 7, maxBytes: 65_536, fetch: wire(all).fetch });
  assert.deepEqual(read.messages, ["m34", "m35", "m36", "m37", "m38", "m39", "m40"]);
  assert.equal(read.hasMore, true);
  assert.equal(read.nextBefore, "m34");
});

test("an after cursor pages forward and still returns oldest first", async () => {
  const all = corpus(14);
  const { calls, fetch } = wire(all);
  const read = await readMoltnetPages({ requested: 14, after: "m2", maxBytes: 65_536, fetch });
  assert.deepEqual(read.messages, all.slice(2));
  assert.equal(calls[1]!.after, "m7", "forward paging follows next_after");
  assert.equal(read.nextBefore, undefined);
});

test("the concatenated payload stops at the caller's byte bound", async () => {
  const all = Array.from({ length: 40 }, (_value, index) => `${index}`.padStart(4, "0").repeat(400));
  const read = await readMoltnetPages({ requested: 40, maxBytes: 20_000, fetch: wire(all).fetch });
  assert.ok(Buffer.byteLength(JSON.stringify(read.messages)) <= 20_000);
  assert.equal(read.truncated?.reason, "result_bound");
  assert.equal(read.hasMore, true);
  assert.ok(read.nextBefore !== undefined);
});

test("a wire that never stops paging is bounded rather than spun forever", async () => {
  let calls = 0;
  const read = await readMoltnetPages({
    requested: 100, maxBytes: 65_536,
    // One message per page, so the walk is bounded by the page cap rather than
    // by ever satisfying the requested count.
    fetch: async () => { calls += 1; return { messages: ["x"], hasMore: true, nextBefore: `cursor-${calls}` }; }
  });
  assert.equal(read.pages, MOLTNET_READ_MAX_PAGES);
  assert.equal(read.truncated?.reason, "page_bound");
});

test("a repeated cursor stops the read instead of looping", async () => {
  let calls = 0;
  const read = await readMoltnetPages({
    requested: 100, maxBytes: 65_536,
    fetch: async () => { calls += 1; return { messages: ["a"], hasMore: true, nextBefore: "stuck" }; }
  });
  assert.equal(calls, 2, "the second page repeats the cursor and must end the walk");
  assert.deepEqual(read.messages, ["a", "a"]);
  assert.equal(read.hasMore, true);
});
