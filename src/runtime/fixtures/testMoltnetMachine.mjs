#!/usr/bin/env node
// A faithful stand-in for `moltnet machine`, reproducing the two behaviours the
// real CLI has and an "echo everything back on EOF" fake did not:
//
//   1. An identifier containing ":" parses as a scoped agent id and is refused
//      with `error: invalid request` on stderr and a non-zero exit.
//   2. End-of-input cancels whatever is still in flight, so a caller that ends
//      stdin with its request gets `{"error":{"code":"canceled"}}`.
let buffer = "";
let pending;

const respond = (request) => {
  if (request.operation === "read") {
    process.stdout.write(`${JSON.stringify({
      version: "moltnet.machine.v1",
      correlation_id: request.correlation_id,
      operation: "read",
      read: { page: { messages: [] } }
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    version: "moltnet.machine.v1",
    correlation_id: request.correlation_id,
    operation: "send_nudge",
    send_nudge: { accepted: true, message_id: "msg-1", event_id: "evt-1", thread_created: false, dm_created: false }
  })}\n`);
};

const cancel = (request) => {
  process.stdout.write(`${JSON.stringify({
    version: "moltnet.machine.v1",
    correlation_id: request.correlation_id,
    operation: "send_nudge",
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
