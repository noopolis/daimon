#!/usr/bin/env node
// A faithful stand-in for `moltnet machine`, reproducing the behaviours the real
// CLI has and an "echo everything back on EOF" fake did not:
//
//   1. An identifier containing ":" parses as a scoped agent id and is refused
//      with `error: invalid request` on stderr and a non-zero exit.
//   2. End-of-input cancels whatever is still in flight, so a caller that ends
//      stdin with its request gets `{"error":{"code":"canceled"}}`.
//   3. A read is paged and *capped*. `projectRead`
//      (moltnet/internal/machine/service.go) rejects any page that will not
//      encode inside the frozen wire limits and answers
//      `{"error":{"code":"transport"}}`; it never truncates. The previous
//      version of this fixture answered every read with an empty page and
//      enforced no cap at all, which is precisely why a `moltnet_read` that had
//      never once worked in production passed every test in this repository.
//
// The message corpus is supplied by `DAIMON_TEST_MOLTNET_CORPUS`, a JSON file
// mapping `"<kind>:<id>"` to that target's messages in chronological order.
// With no corpus every room is empty, matching the historical behaviour.
//
// `DAIMON_TEST_MOLTNET_JOURNAL`, when set, receives one JSON line per request
// recording the limit, cursor and outcome. Tests assert against it to prove the
// caps were actually exercised rather than merely survived.
import { appendFileSync, readFileSync } from "node:fs";

// Every constant below is quoted from moltnet/pkg/protocol/machine.go.
const MAX_OUTPUT_LINE_BYTES = 16384;
const MAX_READ_PART_TEXT_BYTES = 4096;
const MAX_READ_MESSAGE_PARTS = 64;
const MAX_READ_MENTIONS = 128;
const MAX_READ_LIMIT = 128;
const MAX_CORRELATION_BYTES = 128;
const MAX_TARGET_BYTES = 128;

let buffer = "";
let pending;

const corpus = () => {
  const file = process.env.DAIMON_TEST_MOLTNET_CORPUS;
  return file ? JSON.parse(readFileSync(file, "utf8")) : {};
};

const journal = (entry) => {
  const file = process.env.DAIMON_TEST_MOLTNET_JOURNAL;
  if (file) appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

// `MachineReadPageInfo.Validate` and `MachineReadPage.Validate`
// (moltnet/pkg/protocol/machine_validate_page.go).
const validPage = (page) => {
  if (page.messages.length > MAX_READ_LIMIT) return false;
  for (const message of page.messages) {
    if (!Array.isArray(message.parts) || message.parts.length === 0) return false;
    if (message.parts.length > MAX_READ_MESSAGE_PARTS) return false;
    if ((message.mentions ?? []).length > MAX_READ_MENTIONS) return false;
    for (const part of message.parts) {
      if (Buffer.byteLength(part.text ?? "") > MAX_READ_PART_TEXT_BYTES) return false;
    }
  }
  const info = page.page;
  if (typeof info.has_more !== "boolean") return false;
  if (info.has_more) {
    if (!info.next_before && !info.next_after) return false;
    if (info.next_before && info.next_after) return false;
  } else if (info.next_before || info.next_after) return false;
  // The line cap is measured against a worst-case envelope — a maximum-length
  // correlation id and target id — not against the line the caller receives.
  const envelope = JSON.stringify({
    version: "moltnet.machine.v1",
    correlation_id: "x".repeat(MAX_CORRELATION_BYTES),
    operation: "read",
    read: { target: { kind: "room", id: "x".repeat(MAX_TARGET_BYTES) }, page }
  });
  return Buffer.byteLength(envelope) <= MAX_OUTPUT_LINE_BYTES;
};

const readOutcome = (request) => {
  const { target, limit, before, after } = request.read ?? {};
  if (!target || typeof target.kind !== "string" || typeof target.id !== "string") return { error: { code: "invalid_request" } };
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) return { error: { code: "invalid_request" } };
  if (before && after) return { error: { code: "invalid_request" } };

  const all = corpus()[`${target.kind}:${target.id}`] ?? [];
  let messages;
  let hasMore = false;
  let nextBefore = "";
  let nextAfter = "";

  if (after) {
    const index = all.findIndex((message) => message.id === after);
    // An unknown cursor is ErrInvalidCursor, which the executor reports as transport.
    if (index < 0) return { error: { code: "transport" } };
    const newer = all.slice(index + 1);
    hasMore = newer.length > limit;
    messages = newer.slice(0, limit);
    if (hasMore && messages.length > 0) nextAfter = messages[messages.length - 1].id;
  } else {
    let end = all.length;
    if (before) {
      const index = all.findIndex((message) => message.id === before);
      if (index < 0) return { error: { code: "transport" } };
      end = index;
    }
    const older = all.slice(0, end);
    hasMore = older.length > limit;
    messages = older.slice(Math.max(0, older.length - limit));
    if (hasMore && messages.length > 0) nextBefore = messages[0].id;
  }

  const page = {
    messages,
    page: {
      has_more: hasMore,
      ...(nextBefore ? { next_before: nextBefore } : {}),
      ...(nextAfter ? { next_after: nextAfter } : {})
    }
  };
  if (!validPage(page)) return { error: { code: "transport" } };
  return { read: { target: { kind: target.kind, id: target.id }, page } };
};

const write = (response) => {
  const line = JSON.stringify(response);
  // `EncodeMachineResponseLine` re-checks the real line and refuses to emit an
  // oversized one, so an overflow never reaches the caller as a partial page.
  if (Buffer.byteLength(line) > MAX_OUTPUT_LINE_BYTES) {
    process.stdout.write(`${JSON.stringify({
      version: response.version,
      correlation_id: response.correlation_id,
      operation: response.operation,
      error: { code: "transport" }
    })}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
};

const respond = (request) => {
  const base = { version: "moltnet.machine.v1", correlation_id: request.correlation_id, operation: request.operation };
  if (request.operation === "read") {
    const outcome = readOutcome(request);
    journal({
      operation: "read",
      limit: request.read?.limit,
      before: request.read?.before ?? null,
      after: request.read?.after ?? null,
      error: outcome.error?.code ?? null,
      messages: outcome.read?.page?.messages?.length ?? null
    });
    write({ ...base, ...outcome });
    return;
  }
  write({
    ...base,
    operation: "send_nudge",
    send_nudge: { accepted: true, message_id: "msg-1", event_id: "evt-1", thread_created: false, dm_created: false }
  });
};

const cancel = (request) => {
  process.stdout.write(`${JSON.stringify({
    version: "moltnet.machine.v1",
    correlation_id: request.correlation_id,
    operation: request.operation === "read" ? "read" : "send_nudge",
    error: { code: "canceled" }
  })}\n`);
};

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    const identifiers = [request.correlation_id, request.send_nudge?.delivery_id];
    if (identifiers.some((value) => typeof value === "string" && value.includes(":"))) {
      process.stderr.write("error: invalid request\n");
      process.exit(1);
    }
    pending = { request, timer: setTimeout(() => { pending = undefined; respond(request); }, 25) };
  }
});

process.stdin.on("end", () => {
  if (pending !== undefined) { clearTimeout(pending.timer); cancel(pending.request); pending = undefined; }
  process.exit(0);
});
