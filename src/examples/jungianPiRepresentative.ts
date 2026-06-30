import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentHandle, WakeEvent } from "../core/types.js";
import type { MemoryRecallAudit } from "@noopolis/mneme";
import { seedPiOpenAICodexAuthFromCodex } from "../pi/auth.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";
import type { TriadSelfProfile } from "./jungianTriadProfiles.js";

export interface PiRepresentativeTurn {
  durationMs: number;
  engine: "pi";
  event: WakeEvent;
  memoryPrepareMs: number;
  memoryRecordMs: number;
  outputChars: number;
  outputText: string;
  promptChars: number;
  recall: MemoryRecallAudit;
  totalMs: number;
  voice: {
    engine: "pi";
    id: string;
    selfId: string;
  };
}

const emptyRecall = (): MemoryRecallAudit => ({
  decisions: [],
  redactionCount: 0,
  selected: [],
  selectedEventIds: [],
  tokenBudgetUsed: 0,
  totalCandidates: 0
});

export const seedPiCodexAuth = async (runtimeRoot: string): Promise<string> => {
  const codexAuthPath = path.join(process.env.HOME ?? "", ".codex", "auth.json");
  await access(codexAuthPath);
  const piAuthPath = path.join(runtimeRoot, "auth", "pi-codex-auth.json");
  await seedPiOpenAICodexAuthFromCodex({ codexAuthPath, piAuthPath });
  return piAuthPath;
};

export class JungianPiRepresentative {
  private handle: AgentHandle | undefined;
  readonly runtimeHomePath: string;
  readonly workspacePath: string;

  constructor(
    readonly profile: TriadSelfProfile,
    private readonly adapter: PiHarnessAdapter,
    private readonly runtimeRoot: string,
    private readonly instructions: string[]
  ) {
    this.workspacePath = path.join(runtimeRoot, "selves", profile.id, "voices", profile.representative.id, "workspace");
    this.runtimeHomePath = path.join(runtimeRoot, "selves", profile.id, "voices", profile.representative.id, "runtime");
  }

  async prepare(): Promise<void> {
    await mkdir(this.workspacePath, { recursive: true });
    await mkdir(this.runtimeHomePath, { recursive: true });
    await writeFile(
      path.join(this.workspacePath, "AGENTS.md"),
      [
        `# ${this.profile.representative.name}`,
        "",
        `Self: ${this.profile.name}`,
        "Runtime: Pi with OpenAI Codex subscription auth",
        "",
        "Speak only through the requested SPEAK/STAGE/INNER_USED shape."
      ].join("\n")
    );
    this.handle = await this.adapter.startAgent({
      id: this.profile.representative.id,
      name: this.profile.representative.name,
      instructions: this.instructions.join("\n"),
      runtimeHomePath: this.runtimeHomePath,
      workspacePath: this.workspacePath,
      tools: []
    });
  }

  async stop(): Promise<void> {
    await this.handle?.stop();
  }

  async wake(event: WakeEvent): Promise<PiRepresentativeTurn> {
    if (!this.handle) {
      throw new Error(`${this.profile.representative.id} was not prepared`);
    }
    const result = await this.handle.wake(event);
    return {
      durationMs: result.durationMs,
      engine: "pi",
      event,
      memoryPrepareMs: 0,
      memoryRecordMs: 0,
      outputChars: result.text.length,
      outputText: result.text,
      promptChars: event.text.length,
      recall: emptyRecall(),
      totalMs: result.durationMs,
      voice: {
        engine: "pi",
        id: this.profile.representative.id,
        selfId: this.profile.id
      }
    };
  }
}
