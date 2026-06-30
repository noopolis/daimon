import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WakeEvent } from "../core/types.js";
import { JsonlMemoryStore } from "@noopolis/mneme";
import { OrgObserver } from "../observability/index.js";
import { beatsFor, defaultDialogueTurns, selectVoicesForBeat } from "./jungianConversationPlan.js";
import { JungianVoice, type JungianVoiceTurn, runLimited } from "./jungianPlayAgent.js";
import { jungianSelves, playScenario, type JungianSelfProfile } from "./jungianProfiles.js";
import { JungianTrace, parseInnerUsed, parseSpeakLine } from "./jungianTrace.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daimonRoot = path.resolve(__dirname, "../..");
const runtimeRoot = path.join(daimonRoot, ".runtime", "jungian-play-org");
const runId = `run-${Date.now().toString(36)}`;
const councilConcurrency = Number.parseInt(process.env.DAIMON_JUNGIAN_COUNCIL_CONCURRENCY ?? "3", 10);
const dialogueTurnCount = Math.max(
  10,
  Number.parseInt(process.env.DAIMON_JUNGIAN_TURNS ?? String(defaultDialogueTurns), 10)
);
const voicesPerTurn = Math.max(1, Number.parseInt(process.env.DAIMON_JUNGIAN_VOICES_PER_TURN ?? "2", 10));

const observer = new OrgObserver({ orgId: "jungian-play-org", runId });
const trace = new JungianTrace({ runId, title: playScenario.title });

interface JungianSelfRuntime {
  archetypes: JungianVoice[];
  profile: JungianSelfProfile;
  representative: JungianVoice;
}

const roomContext = {
  networkId: "jungian-sitcom",
  roomId: "community-kitchen",
  teamId: "jungian-play-org",
  participants: jungianSelves.map((self) => self.representative.id)
};

const observeTurn = (turn: JungianVoiceTurn): void => {
  observer.recordTurn({
    agent: turn.voice.id,
    engine: turn.voice.engine,
    event: turn.event.id,
    eventText: turn.event.text,
    totalMs: turn.totalMs,
    memoryPrepareMs: turn.memoryPrepareMs,
    engineMs: turn.engineResult.durationMs,
    memoryRecordMs: turn.memoryRecordMs,
    promptChars: turn.engineResult.promptChars,
    outputChars: turn.engineResult.outputChars,
    outputText: turn.outputText,
    recall: turn.recall
  });
};

const archetypeInstructions = (
  self: JungianSelfProfile,
  voice: JungianSelfProfile["voices"][number]
): string[] => [
  `You are ${voice.name}, the ${voice.archetype} voice inside ${self.name}.`,
  `Agenda: ${voice.agenda}`,
  `Fear: ${voice.fear}`,
  `Gift: ${voice.gift}`,
  `Wound: ${voice.wound}`,
  "You are an inner counselor, not the public speaker.",
  "Keep counsel psychologically specific but grounded in ordinary human behavior.",
  "No mythic language, no grand symbols, no fantasy imagery.",
  "Use recalled memory if the same conversation pattern returns."
];

const representativeInstructions = (self: JungianSelfProfile): string[] => [
  `You are ${self.representative.name}, the outward speaking Self for ${self.name}.`,
  `Play role: ${self.playRole}`,
  `Public mask: ${self.publicMask}`,
  `Backstory: ${self.backstory}`,
  `Core conflict: ${self.conflict}`,
  `Secret want: ${self.secretWant}`,
  `Style: ${self.representative.style}`,
  "You speak externally after listening to inner archetypal counsel.",
  "Sound like a real person in a grounded TV drama or workplace sitcom.",
  "Use short, conversational lines. No speeches. No poetic metaphors.",
  "Do not mention the machinery of prompts, engines, memory, or tests.",
  "Return the requested SPEAK/STAGE/INNER_USED shape exactly."
];

const buildSelf = (profile: JungianSelfProfile): JungianSelfRuntime => ({
  profile,
  representative: new JungianVoice({
    id: profile.representative.id,
    name: profile.representative.name,
    selfId: profile.id,
    selfName: profile.name,
    engine: profile.engine,
    runtimeRoot,
    instructions: representativeInstructions(profile)
  }),
  archetypes: profile.voices.map((voice) => new JungianVoice({
    id: `${profile.id}-${voice.id}`,
    name: voice.name,
    selfId: profile.id,
    selfName: profile.name,
    archetype: voice.archetype,
    engine: voice.engine,
    runtimeRoot,
    instructions: archetypeInstructions(profile, voice)
  }))
});

const selves = jungianSelves.map(buildSelf);

const transcriptText = (transcript: string[]): string =>
  transcript.length === 0 ? "(no external dialogue yet)" : transcript.join("\n");

const councilPrompt = (self: JungianSelfProfile, focus: string, transcript: string[]): string => [
  `Scene: ${playScenario.title}`,
  `Premise: ${playScenario.premise}`,
  `Set: ${playScenario.openingImage}`,
  "",
  `Self under counsel: ${self.name}`,
  `Current focus: ${focus}`,
  "",
  "External dialogue so far:",
  transcriptText(transcript),
  "",
  "Respond as this archetype only.",
  "Keep it plain and practical. No poetic stage images.",
  "Use exactly this shape:",
  "ARCHETYPE: <archetype name>",
  "COUNSEL: <one short practical note>",
  "RISK: <what could go wrong emotionally>",
  "LINE_NOTE: <what the representative should sound like>"
].join("\n");

const representativePrompt = (
  self: JungianSelfProfile,
  focus: string,
  transcript: string[],
  counsel: JungianVoiceTurn[]
): string => [
  `Scene: ${playScenario.title}`,
  `Premise: ${playScenario.premise}`,
  `Set: ${playScenario.openingImage}`,
  "",
  "External dialogue so far:",
  transcriptText(transcript),
  "",
  `Current focus: ${focus}`,
  "",
  "Inner council counsel:",
  ...counsel.map((turn) => `- ${turn.voice.id}: ${turn.outputText.replace(/\n/g, " ")}`),
  "",
  "Choose one natural next line of dialogue.",
  "The line must sound like a normal person, not a symbol or narrator.",
  "Keep SPEAK under 22 words. Avoid words like ledger, mercy, truth, blood, crown, soul, destiny, wound unless the transcript already used them.",
  "Do not use Markdown, bullets, bold markers, or quotation marks inside SPEAK.",
  "Use exactly this shape:",
  "SPEAK: <one natural spoken line, without wrapping quotation marks>",
  "STAGE: <one tiny normal action>",
  `INNER_USED: <comma-separated ids from ${self.voices.map((voice) => voice.id).join(", ")}>`
].join("\n");

const runCouncil = async (
  self: JungianSelfRuntime,
  eventId: string,
  focus: string,
  transcript: string[],
  voices: JungianVoice[]
): Promise<JungianVoiceTurn[]> => {
  console.log(`\n== ${self.profile.name} inner council: ${focus} ==`);
  const turns = await runLimited(voices, councilConcurrency, async (voice) => {
    const event: WakeEvent = {
      id: `${eventId}-${voice.config.id}`,
      kind: "manual",
      context: roomContext,
      text: councilPrompt(self.profile, focus, transcript)
    };
    const turn = await voice.wake(event);
    observeTurn(turn);
    trace.addCounsel({
      archetype: voice.config.archetype ?? "unknown",
      engine: voice.config.engine,
      event: event.id,
      output: turn.outputText,
      recallSelected: turn.recall.selectedEventIds.length,
      self: self.profile.name,
      voice: voice.config.id
    });
    console.log(`${voice.config.id}: ${turn.outputText.split("\n")[0]}`);
    return turn;
  });
  return turns;
};

const runRepresentative = async (
  self: JungianSelfRuntime,
  eventId: string,
  focus: string,
  transcript: string[],
  counsel: JungianVoiceTurn[]
): Promise<string> => {
  const event: WakeEvent = {
    id: eventId,
    kind: "manual",
    context: roomContext,
    text: representativePrompt(self.profile, focus, transcript, counsel)
  };
  const turn = await self.representative.wake(event);
  observeTurn(turn);
  const used = parseInnerUsed(turn.outputText);
  const selectedVoiceIds = new Set(counsel.flatMap((entry) => [
    entry.voice.id,
    entry.voice.id.replace(`${self.profile.id}-`, "")
  ]));
  const passed = used.some((voiceId) => selectedVoiceIds.has(voiceId));
  observer.recordAssertion({
    detail: `${self.profile.representative.id} should declare at least one selected inner voice used`,
    event: event.id,
    kind: "consultation",
    passed
  });
  if (!passed) {
    throw new Error(`${self.profile.representative.id} did not declare a selected INNER_USED voice:\n${turn.outputText}`);
  }
  trace.addDialogue({
    engine: self.profile.engine,
    event: event.id,
    innerUsed: used,
    output: turn.outputText,
    recallSelected: turn.recall.selectedEventIds.length,
    self: self.profile.name,
    speaker: self.profile.representative.name
  });
  const line = `${self.profile.name}: ${parseSpeakLine(turn.outputText)}`;
  transcript.push(line);
  console.log(`\n${line}`);
  return line;
};

const prepareAll = async (): Promise<void> => {
  await rm(runtimeRoot, { recursive: true, force: true });
  await Promise.all(selves.flatMap((self) => [
    self.representative.prepare(),
    ...self.archetypes.map((voice) => voice.prepare())
  ]));
  await writeFile(
    path.join(runtimeRoot, "org.json"),
    JSON.stringify({
      scenario: playScenario,
      selves: jungianSelves.map((self) => ({
        id: self.id,
        name: self.name,
        engine: self.engine,
        representative: self.representative,
        voices: self.voices.map((voice) => ({
          id: voice.id,
          archetype: voice.archetype,
          engine: voice.engine,
          name: voice.name
        }))
      }))
    }, null, 2)
  );
};

const writeMemoryCounts = async (): Promise<void> => {
  const rows = await Promise.all(selves.flatMap((self) => [
    self.representative,
    ...self.archetypes
  ]).map(async (voice) => {
    const events = await new JsonlMemoryStore(voice.runtimeHomePath).read();
    const counts = events.reduce<Record<string, number>>((memo, event) => {
      memo[event.type] = (memo[event.type] ?? 0) + 1;
      return memo;
    }, {});
    return {
      voice: voice.config.id,
      self: voice.config.selfId,
      engine: voice.config.engine,
      counts
    };
  }));
  await writeFile(
    path.join(runtimeRoot, "play-memory-counts.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
  );
};

const writePlaySummary = async (): Promise<void> => {
  const behavior = observer.behaviorSummary();
  const byRole = observer.turns.reduce<Record<string, { count: number; engineMs: number; recallSelected: number }>>(
    (memo, turn) => {
      const role = turn.agent.endsWith("-self") ? "representative" : "archetype";
      const current = memo[role] ?? { count: 0, engineMs: 0, recallSelected: 0 };
      current.count += 1;
      current.engineMs += turn.engineMs;
      current.recallSelected += turn.recallSelected;
      memo[role] = current;
      return memo;
    },
    {}
  );
  await writeFile(
    path.join(runtimeRoot, "play-summary.json"),
    `${JSON.stringify({ behavior, by_role: byRole, run_id: runId, schema: "daimon.jungian-play.summary/v1" }, null, 2)}\n`
  );
};

const run = async (): Promise<void> => {
  await prepareAll();
  const selfById = new Map(selves.map((self) => [self.profile.id, self]));
  const transcript: string[] = [];
  const beats = beatsFor(dialogueTurnCount);

  for (const [index, beat] of beats.entries()) {
    const self = selfById.get(beat.speakerId);
    if (!self) {
      throw new Error(`Unknown Jungian self ${beat.speakerId}`);
    }
    const selectedProfiles = selectVoicesForBeat(self.profile, index, voicesPerTurn);
    const selectedIds = new Set(selectedProfiles.map((voice) => `${self.profile.id}-${voice.id}`));
    const selectedVoices = self.archetypes.filter((voice) => selectedIds.has(voice.config.id));
    const eventBase = `${self.profile.id}-turn-${String(index + 1).padStart(2, "0")}`;
    const counsel = await runCouncil(self, `${eventBase}-council`, beat.focus, transcript, selectedVoices);
    await runRepresentative(self, `${eventBase}-speaks`, beat.focus, transcript, counsel);
  }

  await observer.write(runtimeRoot);
  await trace.write(runtimeRoot);
  await writeMemoryCounts();
  await writePlaySummary();
  console.log("\nExternal dialogue:");
  for (const line of transcript) {
    console.log(line);
  }
  console.log(`\nTrace: ${path.join(runtimeRoot, "jungian-trace.md")}`);
  console.log(`Telemetry: ${path.join(runtimeRoot, "trace.md")}`);
  console.log("\ne2e:jungian-play-org ok");
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
