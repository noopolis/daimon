import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  bindPiRawTrainingCapture,
  capturePiRawTrainingEvent,
  createPiRawTrainingCapture,
  persistPiRawTrainingCapture,
  type PiRawTrainingCaptureRef
} from "./rawTrainingCapture.js";

const tempDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), "daimon-raw-training-"));

describe("Pi raw training capture", () => {
  it("records the effective provider payload without changing hook semantics", async () => {
    const ref: PiRawTrainingCaptureRef = { current: createPiRawTrainingCapture() };
    const session: {
      agent: {
        onPayload?: (...args: any[]) => unknown | Promise<unknown>;
        onResponse?: (...args: any[]) => void | Promise<void>;
      };
      model: unknown;
      sessionFile: string;
      sessionId: string;
      thinkingLevel: string;
    } = {
      agent: {
        onPayload: (payload: unknown) => ({ wrapped: payload }),
        onResponse: () => undefined
      },
      model: { id: "teacher" },
      sessionFile: "/unused",
      sessionId: "session-1",
      thinkingLevel: "high"
    };
    bindPiRawTrainingCapture(session, ref);
    const transformed = await session.agent.onPayload?.(
      { messages: [{ role: "system", content: "complete private prompt" }] },
      { id: "teacher" }
    );
    await session.agent.onResponse?.({ status: 200 }, { id: "teacher" });

    assert.deepEqual(transformed, {
      wrapped: { messages: [{ role: "system", content: "complete private prompt" }] }
    });
    assert.deepEqual(ref.current?.requests[0]?.payload, transformed);
    assert.deepEqual(ref.current?.requests[0]?.response, { status: 200 });
  });

  it("copies native Pi bytes, retains unredacted payload/events, and prunes old turns", async () => {
    const root = await tempDir();
    const sessionFile = path.join(root, "native.jsonl");
    const nativeBytes = [
      "{\"type\":\"session\",\"id\":\"native\"}",
      "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"private reasoning\"}]}}",
      ""
    ].join("\n");
    await writeFile(sessionFile, nativeBytes, "utf8");

    for (let index = 0; index < 2; index += 1) {
      const capture = createPiRawTrainingCapture();
      capture.requests.push({
        model: { id: "teacher", headers: { "x-private": "raw" } },
        payload: {
          system: "system secret",
          tools: [{ name: "world_act", parameters: { type: "object" } }]
        },
        requested_at: new Date(index).toISOString(),
        sequence: 0
      });
      capturePiRawTrainingEvent(capture, {
        type: "message_update",
        message: { content: [{ type: "thinking", thinking: "private reasoning" }] }
      }, new Date(index));
      await persistPiRawTrainingCapture({
        agentId: "red",
        capture,
        completedAt: new Date(index + 1),
        options: { enabled: true, retention: { maxTurns: 1 } },
        runtimeHomePath: root,
        session: {
          agent: {},
          model: { id: "teacher" },
          sessionFile,
          sessionId: "native",
          thinkingLevel: "high"
        },
        startedAt: new Date(index),
        status: "completed",
        totalMs: 7,
        turnId: `wake-${index}`,
        world: {
          decisionToken: "not-a-join-key",
          requestId: "request",
          runId: "run",
          tick: index,
          wakeId: `wake-${index}`
        }
      });
    }

    const turnsPath = path.join(root, "private-training", "pi", "raw", "turns");
    const [turn] = await readdir(turnsPath);
    assert.match(turn ?? "", /wake-1$/u);
    const turnPath = path.join(turnsPath, turn ?? "");
    assert.equal(await readFile(path.join(turnPath, "pi-session.jsonl"), "utf8"), nativeBytes);
    assert.match(
      await readFile(path.join(turnPath, "provider-exchange.json"), "utf8"),
      /system secret/u
    );
    assert.match(
      await readFile(path.join(turnPath, "events.ndjson"), "utf8"),
      /private reasoning/u
    );
    assert.equal((await stat(turnPath)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(turnPath, "manifest.json"))).mode & 0o777, 0o600);
    const manifest = JSON.parse(
      await readFile(path.join(turnPath, "manifest.json"), "utf8")
    ) as Record<string, any>;
    assert.equal(manifest.access.export_by_default, false);
    assert.equal(manifest.join.run_id, "run");
    assert.equal(JSON.stringify(manifest).includes("not-a-join-key"), false);
  });
});
