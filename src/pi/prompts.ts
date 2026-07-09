import {
  createExtensionRuntime,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent";
import {
  getMemorySkillTextForMode,
  type MemoryWakeMode
} from "@noopolis/mneme";

import type { AgentStartInput, WakeEvent } from "../core/types.js";

export const formatWakePrompt = (event: WakeEvent): string => `Wake event:
- id: ${event.id}
- kind: ${event.kind}
- from: ${event.from ?? "operator"}

${event.text}`;

export const createResourceLoader = (
  input: AgentStartInput,
  mode: MemoryWakeMode
): ResourceLoader => {
  const systemPrompt = [
    `You are ${input.name} (${input.id}).`,
    input.instructions,
    "You are running inside a harnessed workspace prepared by the caller.",
    "Use the available coding tools when asked to read, write, edit, or inspect files.",
    getMemorySkillTextForMode(mode),
    "Keep responses brief and report the exact files you created or modified."
  ].join("\n\n");

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
};
