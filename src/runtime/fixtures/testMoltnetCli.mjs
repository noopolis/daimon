#!/usr/bin/env node
/**
 * A stand-in for the `moltnet` CLI, implementing only the send contract
 * `testRuntimeMoltnetActions.ts` actually invokes:
 *
 *   moltnet send --config <path> --network <id> --target <kind:id> --text <text>
 *   env DAIMON_WAKE_ID=<delivery id>
 *   stdout: {"accepted":true,"message_id":"..."}
 *
 * The test used to exec `../moltnet/bin/moltnet` — a 30 MB binary built by hand
 * in a SIBLING REPOSITORY and gitignored there. That path exists on a developer
 * box that happens to have built it and cannot exist in CI, which checks out
 * daimon alone, so the test failed on Linux for a reason unrelated to daimon.
 * Depending on a sibling checkout also breaks the ecosystem rule that these
 * repositories are independent.
 *
 * This asserts the invocation contract rather than merely tolerating it: a
 * missing flag, a missing DAIMON_WAKE_ID, or an undeclared network exits
 * non-zero, so the test still fails if daimon stops calling the CLI correctly.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(2); };
if (args[0] !== "send") fail(`unsupported moltnet subcommand: ${args[0]}`);

const flags = new Map();
for (let index = 1; index < args.length; index += 2) {
  if (!args[index].startsWith("--") || args[index + 1] === undefined) fail(`malformed flag near ${args[index]}`);
  flags.set(args[index].slice(2), args[index + 1]);
}
for (const required of ["config", "network", "target", "text"]) {
  if (!flags.has(required)) fail(`missing --${required}`);
}
// The real CLI is told which wake it is acting for; losing it would silently
// decouple the outbound message from the turn that produced it.
if (!process.env.DAIMON_WAKE_ID) fail("missing DAIMON_WAKE_ID");

const config = JSON.parse(readFileSync(flags.get("config"), "utf8"));
if (config.version !== "moltnet.client.v1") fail("unsupported client config version");
const attachment = (config.attachments ?? []).find((item) => item.network_id === flags.get("network"));
if (!attachment) fail(`network ${flags.get("network")} is not declared in the client config`);

const response = await fetch(`${attachment.base_url}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    network_id: flags.get("network"),
    target: flags.get("target"),
    parts: [{ kind: "text", text: flags.get("text") }]
  })
});
const body = await response.text();
if (!response.ok) fail(`moltnet send rejected with ${response.status}: ${body}`);
process.stdout.write(`${body}\n`);
