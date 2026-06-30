import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WakeEvent, WakeResult } from "../core/types.js";
import { createMemoryRuntime } from "@noopolis/mneme";
import { JsonlMemoryStore } from "@noopolis/mneme";
import type { MemoryRuntime } from "@noopolis/mneme";
import { OrgObserver } from "../observability/index.js";
import { runEngineDetailed, type EngineKind } from "./mixedEngineCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daimonRoot = path.resolve(__dirname, "../..");
const runtimeRoot = path.join(daimonRoot, ".runtime", "mixed-engine-org");

interface OrgAgentConfig {
  engine: EngineKind;
  id: string;
  name: string;
  signalPrefix: string;
}

const observer = new OrgObserver({
  orgId: "mixed-engine-org",
  runId: `run-${Date.now().toString(36)}`
});
const maxMemoryChars = 1800;
const maxTranscriptLines = 3;

class MixedEngineAgent {
  readonly runtimeHomePath: string;
  readonly workspacePath: string;
  private readonly memory: MemoryRuntime;

  constructor(readonly config: OrgAgentConfig) {
    this.workspacePath = path.join(runtimeRoot, "agents", config.id, "workspace");
    this.runtimeHomePath = path.join(runtimeRoot, "agents", config.id, "runtime");
    this.memory = createMemoryRuntime({
      agentId: config.id,
      runtimeHomePath: this.runtimeHomePath,
      source: `daimon/mixed-engine/${config.engine}`,
      tokenBudget: 2200
    });
  }

  async prepare(): Promise<void> {
    await mkdir(this.workspacePath, { recursive: true });
    await mkdir(this.runtimeHomePath, { recursive: true });
    await writeFile(
      path.join(this.workspacePath, "AGENTS.md"),
      [
        `# ${this.config.name}`,
        "",
        `Engine: ${this.config.engine}`,
        "This workspace belongs to the mixed-engine Daimon org E2E.",
        "The test uses real CLI engines and Daimon's persisted memory."
      ].join("\n")
    );
  }

  async wake(event: WakeEvent): Promise<WakeResult> {
    const startedAt = Date.now();
    const prepareStartedAt = Date.now();
    const prepared = await this.memory.prepareTurn({
      eventId: event.id,
      kind: event.kind,
      text: event.text,
      from: event.from,
      context: event.context ?? {}
    });
    const memoryPrepareMs = Date.now() - prepareStartedAt;
    const rawMemoryText = prepared.packet.sections.length === 0
      ? "(no recalled memories)"
      : prepared.packet.sections
        .map((section) => `- ${section.heading}: ${section.text}`)
        .join("\n");
    const memoryText = rawMemoryText.length <= maxMemoryChars
      ? rawMemoryText
      : `${rawMemoryText.slice(0, maxMemoryChars).trim()}\n[truncated memory]`;
    const prompt = [
      `${this.config.name} (${this.config.id}) running on ${this.config.engine}.`,
      "Use recalled Daimon memory as authoritative context.",
      "Answer only the requested final line.",
      "Memory:",
      memoryText,
      "",
      "Task:",
      event.text
    ].join("\n");
    const engineResult = await runEngineDetailed(this.config.engine, prompt, {
      runtimeHomePath: this.runtimeHomePath,
      workspacePath: this.workspacePath
    });

    const recordStartedAt = Date.now();
    await this.memory.recordTurn({
      principal: prepared.principal,
      prompt: prepared.packet,
      request: {
        eventId: event.id,
        kind: event.kind,
        text: event.text,
        from: event.from,
        context: event.context ?? {}
      },
      recall: prepared.recall,
      result: "completed",
      outputText: engineResult.text
    });
    const memoryRecordMs = Date.now() - recordStartedAt;

    observer.recordTurn({
      agent: this.config.id,
      engine: this.config.engine,
      event: event.id,
      eventText: event.text,
      totalMs: Date.now() - startedAt,
      memoryPrepareMs,
      engineMs: engineResult.durationMs,
      memoryRecordMs,
      promptChars: engineResult.promptChars,
      outputChars: engineResult.outputChars,
      outputText: engineResult.text,
      recall: prepared.recall
    });

    return {
      agentId: this.config.id,
      durationMs: Date.now() - startedAt,
      text: engineResult.text
    };
  }
}

const agents = [
  new MixedEngineAgent({
    id: "navigator",
    name: "Navigator",
    engine: "codex",
    signalPrefix: "COD"
  }),
  new MixedEngineAgent({
    id: "cartographer",
    name: "Cartographer",
    engine: "grok",
    signalPrefix: "GRK"
  }),
  new MixedEngineAgent({
    id: "sentinel",
    name: "Sentinel",
    engine: "agy",
    signalPrefix: "AGY"
  })
];

const roomContext = {
  networkId: "mixed-engine-lab",
  roomId: "workbench",
  teamId: "mixed-engine-org",
  participants: agents.map((agent) => agent.config.id)
};

const assertIncludes = (label: string, actual: string, expected: string, event?: string): void => {
  const passed = actual.includes(expected);
  if (event) {
    observer.recordAssertion({
      detail: `${label} should include ${expected}`,
      event,
      kind: "recall",
      passed
    });
  }
  if (!passed) {
    throw new Error(`${label} did not include ${expected}.\nActual:\n${actual}`);
  }
};

const assertNoSignalLeak = (event: WakeEvent, signals: string[]): void => {
  let passed = true;
  for (const signal of signals) {
    if (event.text.includes(signal)) {
      passed = false;
      observer.recordAssertion({
        detail: `wake text must not contain ${signal}`,
        event: event.id,
        kind: "no-leak",
        passed
      });
      throw new Error(`wake ${event.id} leaked ${signal} in the current prompt`);
    }
  }
  observer.recordAssertion({
    detail: `wake text does not contain ${signals.length} known signal(s)`,
    event: event.id,
    kind: "no-leak",
    passed
  });
};

const transcriptTail = (transcript: string[]): string => {
  if (transcript.length === 0) {
    return "(empty)";
  }
  const tail = transcript.slice(-maxTranscriptLines);
  const prefix = transcript.length > tail.length
    ? `(${transcript.length - tail.length} earlier room line(s) omitted)\n`
    : "";
  return `${prefix}${tail.join("\n")}`;
};

const extractSignal = (agent: MixedEngineAgent, text: string): string => {
  const match = text.match(/SIGNAL\s*[:=]\s*`?([A-Z0-9_-]{6,80})`?/i);
  if (!match) {
    throw new Error(`Could not extract signal from ${agent.config.id} output:\n${text}`);
  }
  const signal = match[1].toUpperCase();
  if (!signal.startsWith(`${agent.config.signalPrefix}-`)) {
    throw new Error(`${agent.config.id} signal ${signal} does not start with ${agent.config.signalPrefix}-`);
  }
  return signal;
};

const seedSignals = async (): Promise<Map<string, string>> => {
  console.log("\n== Live seed phase ==");
  const signals = new Map<string, string>();
  const results = await Promise.all(agents.map(async (agent) => {
    const result = await agent.wake({
      id: `seed-${agent.config.id}`,
      kind: "manual",
      text: [
        "Invent a private signal token for yourself.",
        `The token must start with ${agent.config.signalPrefix}- and use only uppercase letters, numbers, and hyphens.`,
        "Do not use spaces inside the token.",
        "Do not copy examples. Do not mention any other agent.",
        "Reply in one line only: SIGNAL=<token> NOTE=<six words or fewer>"
      ].join("\n")
    });
    const signal = extractSignal(agent, result.text);
    return { agent, result, signal };
  }));
  for (const { agent, result, signal } of results) {
    signals.set(agent.config.id, signal);
    observer.recordSignal({
      agent: agent.config.id,
      engine: agent.config.engine,
      signal
    });
    console.log(`${agent.config.id} (${agent.config.engine}) -> ${result.text}`);
  }
  return signals;
};

const runRoom = async (signals: Map<string, string>): Promise<string[]> => {
  console.log("\n== Mixed-engine room ==");
  const transcript: string[] = [];
  const navigatorSignal = signals.get("navigator")!;
  const cartographerSignal = signals.get("cartographer")!;
  const sentinelSignal = signals.get("sentinel")!;

  const navigatorEvent: WakeEvent = {
    id: "room-navigator-1",
    kind: "manual",
    context: roomContext,
    text: [
      "Room transcript so far:",
      transcriptTail(transcript),
      "Recall your own private SIGNAL from Daimon memory.",
      "Reply in one line: @cartographer navigator=<your signal> asks cartographer to answer."
    ].join("\n")
  };
  assertNoSignalLeak(navigatorEvent, [...signals.values()]);
  const navigator = await agents[0].wake(navigatorEvent);
  assertIncludes("navigator reply", navigator.text, navigatorSignal, navigatorEvent.id);
  observer.recordConsultation({
    event: navigatorEvent.id,
    from: "navigator",
    outputText: navigator.text,
    to: "cartographer"
  });
  transcript.push(`navigator: ${navigator.text}`);
  console.log(transcript.at(-1));

  const cartographerEvent: WakeEvent = {
    id: "room-cartographer-1",
    kind: "manual",
    context: roomContext,
    text: [
      "Room transcript so far:",
      transcriptTail(transcript),
      "Recall your own private SIGNAL from Daimon memory.",
      "Reply in one line: @sentinel cartographer=<your signal> observed navigator=<navigator signal>."
    ].join("\n")
  };
  assertNoSignalLeak(cartographerEvent, [cartographerSignal, sentinelSignal]);
  const cartographer = await agents[1].wake(cartographerEvent);
  assertIncludes("cartographer reply", cartographer.text, navigatorSignal, cartographerEvent.id);
  assertIncludes("cartographer reply", cartographer.text, cartographerSignal, cartographerEvent.id);
  observer.recordConsultation({
    event: cartographerEvent.id,
    from: "cartographer",
    outputText: cartographer.text,
    to: "sentinel"
  });
  transcript.push(`cartographer: ${cartographer.text}`);
  console.log(transcript.at(-1));

  const sentinelEvent: WakeEvent = {
    id: "room-sentinel-1",
    kind: "manual",
    context: roomContext,
    text: [
      "Room transcript so far:",
      transcriptTail(transcript),
      "Recall your own private SIGNAL from Daimon memory.",
      "Reply in one line: sentinel=<your signal> observed navigator=<navigator signal> cartographer=<cartographer signal>."
    ].join("\n")
  };
  assertNoSignalLeak(sentinelEvent, [sentinelSignal]);
  const sentinel = await agents[2].wake(sentinelEvent);
  assertIncludes("sentinel reply", sentinel.text, navigatorSignal, sentinelEvent.id);
  assertIncludes("sentinel reply", sentinel.text, cartographerSignal, sentinelEvent.id);
  assertIncludes("sentinel reply", sentinel.text, sentinelSignal, sentinelEvent.id);
  transcript.push(`sentinel: ${sentinel.text}`);
  console.log(transcript.at(-1));

  return transcript;
};

const runFinalRecall = async (signals: Map<string, string>): Promise<void> => {
  console.log("\n== Fresh CLI final recall ==");
  const event: WakeEvent = {
    id: "room-sentinel-2",
    kind: "manual",
    context: roomContext,
    text: [
      "There is no room transcript in this wake.",
      "Use only Daimon memory recalled into this fresh CLI turn.",
      "Report all three remembered signals in one line:",
      "final navigator=<token> cartographer=<token> sentinel=<token>"
    ].join("\n")
  };
  assertNoSignalLeak(event, [...signals.values()]);
  const result = await agents[2].wake(event);
  for (const signal of signals.values()) {
    assertIncludes("final recall", result.text, signal, event.id);
  }
  console.log(`sentinel (${agents[2].config.engine}) -> ${result.text}`);
};

const printMemoryCounts = async (): Promise<void> => {
  console.log("\nMemory event counts:");
  for (const agent of agents) {
    const events = await new JsonlMemoryStore(agent.runtimeHomePath).read();
    const counts = events.reduce<Record<string, number>>((memo, event) => {
      memo[event.type] = (memo[event.type] ?? 0) + 1;
      return memo;
    }, {});
    console.log(`${agent.config.id}: ${JSON.stringify(counts)}`);
  }
};

const printBench = async (): Promise<void> => {
  console.log("\nBench rows:");
  console.table(observer.benchRows());
  const summary = observer.summary();
  console.log("Bench summary:");
  for (const [engine, row] of Object.entries(summary)) {
    console.log(`${engine}: avg_engine_ms=${Math.round(row.engineMs / row.count)} avg_total_ms=${Math.round(row.totalMs / row.count)} avg_prompt_chars=${Math.round(row.promptChars / row.count)}`);
  }
  await observer.write(runtimeRoot);
};

const run = async (): Promise<void> => {
  await rm(runtimeRoot, { recursive: true, force: true });
  await Promise.all(agents.map((agent) => agent.prepare()));
  await writeFile(
    path.join(runtimeRoot, "org.json"),
    JSON.stringify(agents.map((agent) => agent.config), null, 2)
  );

  const signals = await seedSignals();
  await runRoom(signals);
  await runFinalRecall(signals);
  await printMemoryCounts();
  await printBench();
  console.log("\ne2e:mixed-engine-org ok");
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
