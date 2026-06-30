import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WakeEvent } from "../core/types.js";
import { JsonlMemoryStore } from "@noopolis/mneme";
import { OrgObserver } from "../observability/index.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";
import { JungianPiRepresentative, seedPiCodexAuth, type PiRepresentativeTurn } from "./jungianPiRepresentative.js";
import { JungianVoice, type JungianVoiceTurn, runLimited } from "./jungianPlayAgent.js";
import { JungianTrace, parseInnerUsed, parseSpeakLine } from "./jungianTrace.js";
import { triadScenario, triadSelves, type TriadSelfProfile } from "./jungianTriadProfiles.js";
import type { EngineKind } from "./mixedEngineCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daimonRoot = path.resolve(__dirname, "../..");
const runtimeRoot = path.join(daimonRoot, ".runtime", "jungian-triad-org");
const runId = `run-${Date.now().toString(36)}`;
const dialogueTurnCount = Math.max(12, Number.parseInt(process.env.DAIMON_JUNGIAN_TRIAD_TURNS ?? "12", 10));
const voicesPerTurn = Math.max(1, Number.parseInt(process.env.DAIMON_JUNGIAN_VOICES_PER_TURN ?? "2", 10));
const observer = new OrgObserver({ orgId: "jungian-triad-org", runId });
const trace = new JungianTrace({ runId, title: triadScenario.title });

type Representative = JungianVoice | JungianPiRepresentative;
type RepresentativeTurn = JungianVoiceTurn | PiRepresentativeTurn;

interface TriadSelfRuntime {
  archetypes: JungianVoice[];
  profile: TriadSelfProfile;
  representative: Representative;
}

interface DialogueBeat {
  focus: string;
  speakerId: string;
}

const beats: DialogueBeat[] = [
  { speakerId: "maya", focus: "Open on the missing chairs. Be annoyed, funny, and specific." },
  { speakerId: "leo", focus: "Admit the mistake and say what you are checking first." },
  { speakerId: "priya", focus: "Enter with the label maker and notice the real tension without taking over." },
  { speakerId: "maya", focus: "Tell Priya the help is welcome, but Maya does not want another manager." },
  { speakerId: "priya", focus: "Offer one system that gives Maya less work, not more." },
  { speakerId: "leo", focus: "Commit to the chair hunt with a time and place." },
  { speakerId: "maya", focus: "Name that she is tired of being the backup plan." },
  { speakerId: "priya", focus: "Reflect both sides plainly and assign one small role to herself." },
  { speakerId: "leo", focus: "Own the morning update without more self-deprecation." },
  { speakerId: "maya", focus: "Delegate one task each and let the mood soften." },
  { speakerId: "priya", focus: "Confirm her task and keep it friendly." },
  { speakerId: "leo", focus: "Close with a normal hopeful line and a concrete next step." }
];

const roomContext = {
  networkId: "jungian-triad",
  roomId: "community-kitchen",
  teamId: "jungian-triad-org",
  participants: triadSelves.map((self) => self.representative.id)
};

const representativeInstructions = (self: TriadSelfProfile): string[] => [
  `You are ${self.representative.name}, the outward speaking Self for ${self.name}.`,
  `Role: ${self.playRole}`,
  `Mask: ${self.publicMask}`,
  `Backstory: ${self.backstory}`,
  `Conflict: ${self.conflict}`,
  `Secret want: ${self.secretWant}`,
  `Style: ${self.representative.style}`,
  "Speak like a real person in a grounded workplace sitcom/drama.",
  "Use short conversational dialogue, not analysis.",
  "Return only SPEAK, STAGE, and INNER_USED."
];

const archetypeInstructions = (
  self: TriadSelfProfile,
  voice: TriadSelfProfile["voices"][number]
): string[] => [
  `You are ${voice.name}, the ${voice.archetype} voice inside ${self.name}.`,
  `Agenda: ${voice.agenda}`,
  `Fear: ${voice.fear}`,
  `Gift: ${voice.gift}`,
  `Wound: ${voice.wound}`,
  "Counsel the representative in plain human terms.",
  "No mythic language. No speeches. Keep it useful."
];

const transcriptText = (transcript: string[]): string =>
  transcript.length === 0 ? "(empty)" : transcript.join("\n");

const councilPrompt = (self: TriadSelfProfile, focus: string, transcript: string[]): string => [
  `Scene: ${triadScenario.title}`,
  `Premise: ${triadScenario.premise}`,
  `Set: ${triadScenario.openingImage}`,
  "",
  `Self: ${self.name}`,
  `Focus: ${focus}`,
  "",
  "External dialogue so far:",
  transcriptText(transcript),
  "",
  "Use exactly this shape:",
  "ARCHETYPE: <name>",
  "COUNSEL: <one short practical note>",
  "RISK: <what could go wrong emotionally>",
  "LINE_NOTE: <how the representative should sound>"
].join("\n");

const representativePrompt = (
  self: TriadSelfProfile,
  focus: string,
  transcript: string[],
  counsel: JungianVoiceTurn[]
): string => [
  `Scene: ${triadScenario.title}`,
  `Premise: ${triadScenario.premise}`,
  "",
  "External dialogue so far:",
  transcriptText(transcript),
  "",
  `Focus: ${focus}`,
  "",
  "Inner counsel:",
  ...counsel.map((turn) => `- ${turn.voice.id}: ${turn.outputText.replace(/\n/g, " ")}`),
  "",
  "Write one natural next line. Keep SPEAK under 22 words.",
  "Do not use Markdown, bullets, quotation marks, or narrator language inside SPEAK.",
  "Use exactly this shape:",
  "SPEAK: <one natural spoken line>",
  "STAGE: <one tiny normal action>",
  `INNER_USED: <comma-separated ids from ${self.voices.map((voice) => voice.id).join(", ")}>`
].join("\n");

const selectVoices = (self: TriadSelfRuntime, selfTurnIndex: number): JungianVoice[] =>
  Array.from({ length: Math.min(voicesPerTurn, self.archetypes.length) }, (_, offset) =>
    self.archetypes[(selfTurnIndex * voicesPerTurn + offset) % self.archetypes.length]
  );

const observeRepresentative = (turn: RepresentativeTurn): void => {
  const engineMs = "engineResult" in turn ? turn.engineResult.durationMs : turn.durationMs;
  const promptChars = "engineResult" in turn ? turn.engineResult.promptChars : turn.promptChars;
  const outputChars = "engineResult" in turn ? turn.engineResult.outputChars : turn.outputChars;
  observer.recordTurn({
    agent: turn.voice.id,
    engine: turn.voice.engine,
    event: turn.event.id,
    eventText: turn.event.text,
    totalMs: turn.totalMs,
    memoryPrepareMs: turn.memoryPrepareMs,
    engineMs,
    memoryRecordMs: turn.memoryRecordMs,
    promptChars,
    outputChars,
    outputText: turn.outputText,
    recall: turn.recall
  });
};

const observeCounsel = (turn: JungianVoiceTurn): void => {
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

const runCouncil = async (
  self: TriadSelfRuntime,
  eventBase: string,
  focus: string,
  transcript: string[],
  voices: JungianVoice[]
): Promise<JungianVoiceTurn[]> => {
  console.log(`\n== ${self.profile.name} inner counsel ==`);
  return runLimited(voices, 2, async (voice) => {
    const event: WakeEvent = {
      id: `${eventBase}-council-${voice.config.id}`,
      kind: "manual",
      context: roomContext,
      text: councilPrompt(self.profile, focus, transcript)
    };
    const turn = await voice.wake(event);
    observeCounsel(turn);
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
};

const assertUsedCounsel = (self: TriadSelfProfile, eventId: string, output: string, counsel: JungianVoiceTurn[]): string[] => {
  const used = parseInnerUsed(output);
  const allowed = new Set(counsel.flatMap((turn) => [turn.voice.id, turn.voice.id.replace(`${self.id}-`, "")]));
  const passed = used.some((id) => allowed.has(id));
  observer.recordAssertion({
    detail: `${self.representative.id} should cite at least one consulted inner voice`,
    event: eventId,
    kind: "consultation",
    passed
  });
  if (!passed) {
    throw new Error(`${self.representative.id} did not cite consulted inner counsel:\n${output}`);
  }
  return used;
};

const runRepresentative = async (
  self: TriadSelfRuntime,
  eventBase: string,
  focus: string,
  transcript: string[],
  counsel: JungianVoiceTurn[]
): Promise<void> => {
  const event: WakeEvent = {
    id: `${eventBase}-speaks`,
    kind: "manual",
    context: roomContext,
    text: representativePrompt(self.profile, focus, transcript, counsel)
  };
  const turn = await self.representative.wake(event);
  observeRepresentative(turn);
  const innerUsed = assertUsedCounsel(self.profile, event.id, turn.outputText, counsel);
  trace.addDialogue({
    engine: self.profile.engine,
    event: event.id,
    innerUsed,
    output: turn.outputText,
    recallSelected: turn.recall.selectedEventIds.length,
    self: self.profile.name,
    speaker: self.profile.representative.name
  });
  const line = `${self.profile.name}: ${parseSpeakLine(turn.outputText)}`;
  transcript.push(line);
  console.log(`\n${line}`);
};

const buildSelf = (
  profile: TriadSelfProfile,
  piAdapter: PiHarnessAdapter
): TriadSelfRuntime => ({
  profile,
  representative: profile.engine === "pi"
    ? new JungianPiRepresentative(profile, piAdapter, runtimeRoot, representativeInstructions(profile))
    : new JungianVoice({
        id: profile.representative.id,
        name: profile.representative.name,
        selfId: profile.id,
        selfName: profile.name,
        engine: profile.engine as EngineKind,
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

const writeArtifacts = async (selves: TriadSelfRuntime[]): Promise<void> => {
  await observer.write(runtimeRoot);
  await trace.write(runtimeRoot);
  const voices = selves.flatMap((self) => [self.representative, ...self.archetypes]);
  const counts = await Promise.all(voices.map(async (voice) => {
    const events = await new JsonlMemoryStore(voice.runtimeHomePath).read();
    return {
      voice: "config" in voice ? voice.config.id : voice.profile.representative.id,
      counts: events.reduce<Record<string, number>>((memo, event) => {
        memo[event.type] = (memo[event.type] ?? 0) + 1;
        return memo;
      }, {})
    };
  }));
  await writeFile(path.join(runtimeRoot, "triad-memory-counts.json"), `${JSON.stringify(counts, null, 2)}\n`);
};

const run = async (): Promise<void> => {
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  const piAuthPath = await seedPiCodexAuth(runtimeRoot);
  const piAdapter = new PiHarnessAdapter({
    authPath: piAuthPath,
    model: { provider: "openai-codex", name: process.env.HARNESS_PI_MODEL ?? "gpt-5.3-codex-spark" },
    memory: { source: "daimon/jungian-triad/pi", tokenBudget: 2600 }
  });
  const selves = triadSelves.map((profile) => buildSelf(profile, piAdapter));
  await Promise.all(selves.flatMap((self) => [
    self.representative.prepare(),
    ...self.archetypes.map((voice) => voice.prepare())
  ]));
  await writeFile(path.join(runtimeRoot, "org.json"), `${JSON.stringify({ scenario: triadScenario, selves: triadSelves }, null, 2)}\n`);

  const selfById = new Map(selves.map((self) => [self.profile.id, self]));
  const selfTurns = new Map<string, number>();
  const transcript: string[] = [];
  try {
    for (const [index, beat] of beats.slice(0, dialogueTurnCount).entries()) {
      const self = selfById.get(beat.speakerId);
      if (!self) {
        throw new Error(`Unknown self ${beat.speakerId}`);
      }
      const turnIndex = selfTurns.get(self.profile.id) ?? 0;
      selfTurns.set(self.profile.id, turnIndex + 1);
      const eventBase = `${self.profile.id}-turn-${String(index + 1).padStart(2, "0")}`;
      const counsel = await runCouncil(self, eventBase, beat.focus, transcript, selectVoices(self, turnIndex));
      await runRepresentative(self, eventBase, beat.focus, transcript, counsel);
    }
  } finally {
    await Promise.all(selves.map((self) => self.representative.stop()));
  }

  await writeArtifacts(selves);
  console.log("\nExternal dialogue:");
  for (const line of transcript) {
    console.log(line);
  }
  console.log(`\nTrace: ${path.join(runtimeRoot, "jungian-trace.md")}`);
  console.log("\ne2e:jungian-triad-org ok");
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
