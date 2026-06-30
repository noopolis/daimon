import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentHandle, WakeEvent, WakeResult } from "../core/types.js";
import { JsonlMemoryStore } from "@noopolis/mneme";
import { seedPiOpenAICodexAuthFromCodex } from "../pi/auth.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daimonRoot = path.resolve(__dirname, "../..");
const runtimeRoot = path.join(daimonRoot, ".runtime", "pi-memory-org");
const piAuthPath = path.join(runtimeRoot, "auth", "auth.json");
const codexAuthPath = path.join(process.env.HOME ?? "", ".codex", "auth.json");

interface DemoAgent {
  id: string;
  marker: string;
  name: string;
}

const demoAgents: DemoAgent[] = [
  { id: "atlas", name: "Atlas", marker: "ATLAS_BLUE_17" },
  { id: "oracle", name: "Oracle", marker: "ORACLE_GOLD_23" },
  { id: "keeper", name: "Keeper", marker: "KEEPER_GREEN_31" }
];

const roomContext = {
  networkId: "memory-lab",
  roomId: "council",
  teamId: "memory-e2e",
  participants: demoAgents.map((agent) => agent.id)
};

const assertIncludes = (label: string, content: string, expected: string): void => {
  if (!content.includes(expected)) {
    throw new Error(`${label} did not include ${expected}.\nActual:\n${content}`);
  }
};

const assertCurrentPromptDoesNotLeakMarkers = (event: WakeEvent): void => {
  for (const agent of demoAgents) {
    if (event.text.includes(agent.marker)) {
      throw new Error(`wake ${event.id} leaked marker ${agent.marker} in current prompt`);
    }
  }
};

const agentRuntimeHome = (agentId: string): string =>
  path.join(runtimeRoot, "agents", agentId, "runtime");

const prepareWorkspace = async (agentId: string): Promise<{ workspacePath: string; runtimeHomePath: string }> => {
  const workspacePath = path.join(runtimeRoot, "agents", agentId, "workspace");
  const runtimeHomePath = agentRuntimeHome(agentId);
  await mkdir(workspacePath, { recursive: true });
  await mkdir(runtimeHomePath, { recursive: true });
  await writeFile(
    path.join(workspacePath, "AGENTS.md"),
    [
      `# ${agentId}`,
      "",
      "This workspace is part of the Daimon Pi memory-org E2E.",
      "The test intentionally disables file tools and verifies persisted Daimon memory."
    ].join("\n")
  );
  return { workspacePath, runtimeHomePath };
};

const setupRuntime = async (): Promise<void> => {
  await access(codexAuthPath);
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(path.dirname(piAuthPath), { recursive: true });
  await seedPiOpenAICodexAuthFromCodex({ codexAuthPath, piAuthPath });
};

const resetPiSessionHistory = async (agentId: string): Promise<void> => {
  await rm(path.join(agentRuntimeHome(agentId), "sessions"), { recursive: true, force: true });
};

const startAgent = async (adapter: PiHarnessAdapter, agent: DemoAgent): Promise<AgentHandle> => {
  const paths = await prepareWorkspace(agent.id);
  return adapter.startAgent({
    id: agent.id,
    name: agent.name,
    instructions: [
      "You are participating in a live Daimon memory E2E.",
      "Use the Memory context injected above the wake event as authoritative recalled memory.",
      "When asked to recall marker tokens, copy exact marker tokens from memory.",
      "Keep every response to one concise line unless the wake explicitly asks otherwise."
    ].join(" "),
    tools: [],
    ...paths
  });
};

const startAllAgents = async (adapter: PiHarnessAdapter): Promise<Map<string, AgentHandle>> => {
  const handles = new Map<string, AgentHandle>();
  for (const agent of demoAgents) {
    handles.set(agent.id, await startAgent(adapter, agent));
  }
  return handles;
};

const stopAll = async (handles: Map<string, AgentHandle>): Promise<void> => {
  await Promise.all([...handles.values()].map((handle) => handle.stop()));
};

const wake = async (
  handle: AgentHandle,
  event: WakeEvent,
  options: { assertNoMarkerLeak?: boolean } = {}
): Promise<WakeResult> => {
  if (options.assertNoMarkerLeak) {
    assertCurrentPromptDoesNotLeakMarkers(event);
  }
  const result = await handle.wake(event);
  console.log(`[${event.id}] ${result.agentId}: ${result.text}`);
  return result;
};

const seedPrivateMemories = async (handles: Map<string, AgentHandle>): Promise<void> => {
  console.log("\n== Private seed phase ==");
  for (const agent of demoAgents) {
    const result = await handles.get(agent.id)?.wake({
      id: `seed-${agent.id}`,
      kind: "manual",
      text: [
        "Private memory seed.",
        `Remember this exact marker token for later recall: ${agent.marker}`,
        "Do not write files. Reply with exactly: stored"
      ].join("\n")
    });
    console.log(`[seed-${agent.id}] ${agent.id}: ${result?.text ?? ""}`);
  }
};

const runRoomConversation = async (handles: Map<string, AgentHandle>): Promise<string[]> => {
  console.log("\n== Room recall phase ==");
  const transcript: string[] = [];

  const atlas = await wake(handles.get("atlas")!, {
    id: "room-atlas-1",
    kind: "manual",
    context: roomContext,
    text: [
      "Moltnet room simulation. Visible room transcript so far:",
      transcript.join("\n") || "(empty)",
      "Recall your private marker token from Daimon memory.",
      "Reply in one line: @oracle atlas recalls <exact token>",
      "Do not invent markers for other agents."
    ].join("\n")
  }, { assertNoMarkerLeak: true });
  assertIncludes("atlas room reply", atlas.text, "ATLAS_BLUE_17");
  transcript.push(`atlas: ${atlas.text}`);

  const oracle = await wake(handles.get("oracle")!, {
    id: "room-oracle-1",
    kind: "manual",
    context: roomContext,
    text: [
      "Moltnet room simulation. Visible room transcript so far:",
      transcript.join("\n"),
      "Recall your private marker token from Daimon memory and acknowledge Atlas from the transcript.",
      "Reply in one line: @keeper oracle recalls <exact token>; observed atlas=<atlas token>"
    ].join("\n")
  });
  assertIncludes("oracle room reply", oracle.text, "ORACLE_GOLD_23");
  assertIncludes("oracle room reply", oracle.text, "ATLAS_BLUE_17");
  transcript.push(`oracle: ${oracle.text}`);

  const keeper = await wake(handles.get("keeper")!, {
    id: "room-keeper-1",
    kind: "manual",
    context: roomContext,
    text: [
      "Moltnet room simulation. Visible room transcript so far:",
      transcript.join("\n"),
      "Recall your private marker token from Daimon memory and acknowledge Atlas and Oracle from the transcript.",
      "Reply in one line: keeper recalls <exact token>; observed atlas=<atlas token> oracle=<oracle token>"
    ].join("\n")
  });
  assertIncludes("keeper room reply", keeper.text, "KEEPER_GREEN_31");
  assertIncludes("keeper room reply", keeper.text, "ATLAS_BLUE_17");
  assertIncludes("keeper room reply", keeper.text, "ORACLE_GOLD_23");
  transcript.push(`keeper: ${keeper.text}`);

  console.log("\nRoom transcript:");
  for (const line of transcript) {
    console.log(line);
  }
  return transcript;
};

const verifyFreshSessionRecall = async (
  adapter: PiHarnessAdapter,
  previousKeeper: AgentHandle
): Promise<void> => {
  console.log("\n== Fresh session recall phase ==");
  await previousKeeper.stop();
  await resetPiSessionHistory("keeper");
  const keeper = await startAgent(adapter, demoAgents.find((agent) => agent.id === "keeper")!);
  try {
    const event: WakeEvent = {
      id: "room-keeper-2",
      kind: "manual",
      context: roomContext,
      text: [
        "Fresh session check. You do not get the room transcript in this wake.",
        "Use only Daimon memory recalled into this turn.",
        "Report the marker tokens for atlas, oracle, and keeper from your previous memory-lab room turn.",
        "Reply in one line: final atlas=<token> oracle=<token> keeper=<token>"
      ].join("\n")
    };
    const result = await wake(keeper, event, { assertNoMarkerLeak: true });
    assertIncludes("fresh keeper recall", result.text, "ATLAS_BLUE_17");
    assertIncludes("fresh keeper recall", result.text, "ORACLE_GOLD_23");
    assertIncludes("fresh keeper recall", result.text, "KEEPER_GREEN_31");
  } finally {
    await keeper.stop();
  }
};

const printMemoryCounts = async (): Promise<void> => {
  console.log("\nMemory event counts:");
  for (const agent of demoAgents) {
    const events = await new JsonlMemoryStore(agentRuntimeHome(agent.id)).read();
    const counts = events.reduce<Record<string, number>>((memo, event) => {
      memo[event.type] = (memo[event.type] ?? 0) + 1;
      return memo;
    }, {});
    console.log(`${agent.id}: ${JSON.stringify(counts)}`);
  }
};

const run = async (): Promise<void> => {
  await setupRuntime();
  const adapter = new PiHarnessAdapter({
    authPath: piAuthPath,
    model: {
      provider: "openai-codex",
      name: process.env.HARNESS_PI_MODEL ?? "gpt-5.4-mini"
    },
    memory: {
      tokenBudget: 1800
    }
  });

  const seedHandles = await startAllAgents(adapter);
  await seedPrivateMemories(seedHandles);
  await stopAll(seedHandles);
  await Promise.all(demoAgents.map((agent) => resetPiSessionHistory(agent.id)));

  const roomHandles = await startAllAgents(adapter);
  try {
    await runRoomConversation(roomHandles);
    await verifyFreshSessionRecall(adapter, roomHandles.get("keeper")!);
    await roomHandles.get("atlas")?.stop();
    await roomHandles.get("oracle")?.stop();
    await printMemoryCounts();
    console.log("\ne2e:pi-memory-org ok");
  } finally {
    await Promise.all([
      roomHandles.get("atlas")?.stop(),
      roomHandles.get("oracle")?.stop()
    ]);
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
