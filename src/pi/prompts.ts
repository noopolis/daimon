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
- from: ${event.from === undefined ? "[no attribution supplied] (absence)" : event.from}

${event.text}`;

export const createResourceLoader = (
  input: AgentStartInput,
  mode: MemoryWakeMode,
  capabilities: Readonly<{ memory: boolean; world: boolean }>
): ResourceLoader => {
  const systemPrompt = [
    `You are ${input.name} (${input.id}).`,
    input.instructions,
    "You are running inside a harnessed workspace prepared by the caller.",
    ...(input.tools === undefined || input.tools.length > 0
      ? [
        "Use the available coding tools when asked to read, write, edit, or inspect files.",
        "Keep responses brief and report the exact files you created or modified."
      ]
      : []),
    ...(capabilities.memory ? [getMemorySkillTextForMode(mode)] : []),
    ...(capabilities.world
      ? [
        "Use only the authenticated world tools and standing instructions to perceive and act. "
        + "The harness binds wake authority and request identity; choose only the sense, affordance, target, and typed action input exposed by tool schemas."
      ]
      : [])
  ].filter((section) => section.length > 0).join("\n\n");

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
