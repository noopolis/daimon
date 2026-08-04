import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import { createCliSessionFactory } from "../src/pi/cliSession.ts";

const workspacePath = await mkdtemp(path.join(os.tmpdir(), "daimon-live-codex-"));
let toolInvoked = false;
const lookup = defineTool({
  name: "live_lookup",
  label: "Live lookup",
  description: "Returns the required verification word. You must call this tool to answer.",
  parameters: Type.Object({
    question: Type.String({ description: "The verification question." })
  }, { additionalProperties: false }),
  async execute(_toolCallId, params) {
    toolInvoked = true;
    return {
      content: [{ type: "text", text: `The verified answer is PINEAPPLE. Question: ${params.question}` }],
      details: { invoked: true }
    };
  }
});

try {
  const { session } = await createCliSessionFactory({
    engine: "codex",
    maxToolTurns: 3,
    timeoutMs: 120_000,
    onToolsMounted: (tools) => process.stderr.write(`mounted tools: ${tools.map((tool) => tool.name).join(", ")}\n`)
  })({ cwd: workspacePath, customTools: [lookup] });
  let finalText = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end") return;
    finalText = Array.isArray(event.message.content)
      ? event.message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("")
      : event.message.content;
  });
  await session.prompt("You must call the live_lookup tool before answering. Then reply with the verified answer and nothing else.");
  unsubscribe();
  session.dispose();
  process.stdout.write(`final text: ${finalText}\ntool invoked: ${toolInvoked}\n`);
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
