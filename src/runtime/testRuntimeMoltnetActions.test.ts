import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createScriptedMoltnetActions } from "./testRuntimeMoltnetActions.js";
import { occurrenceFor } from "./schedule.js";

test("scripted Moltnet actions accept actual durable cron and every delivery ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-test-moltnet-action-"));
  try {
    const config = path.join(root, "client.json");
    await writeFile(config, JSON.stringify({ version: "moltnet.client.v1", attachments: [{ network_id: "news", rooms: [{ id: "desk" }] }] }));
    const at = Date.parse("2026-08-16T14:00:00.000Z");
    const deliveryIds = [
      occurrenceFor("alpha", { kind: "cron", cron: "0 16 * * *", timezone: "Europe/Berlin", prompt: "draft" }, at).deliveryId,
      occurrenceFor("alpha", { kind: "every", interval_ms: 60_000, prompt: "draft" }, at).deliveryId
    ];
    assert.match(deliveryIds[0]!, /T16:00@GMT\+02:00$/u); assert.match(deliveryIds[1]!, /\.000Z$/u);
    const run = await createScriptedMoltnetActions(deliveryIds.map((delivery_id) => ({ delivery_id, network_id: "news", target: "room:desk", text: "draft" })), "/unused/moltnet", config);
    assert.deepEqual(await run("schedule:not-the-occurrence"), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("scripted Moltnet actions reject unbounded or malformed schedule ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-test-moltnet-action-invalid-"));
  try {
    const config = path.join(root, "client.json");
    await writeFile(config, JSON.stringify({ version: "moltnet.client.v1", attachments: [{ network_id: "news", rooms: [{ id: "desk" }] }] }));
    await assert.rejects(createScriptedMoltnetActions([{ delivery_id: `schedule:${"a".repeat(64)}:invalid`, network_id: "news", target: "room:desk", text: "draft" }], "/unused/moltnet", config), /invalid scripted Moltnet action/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
