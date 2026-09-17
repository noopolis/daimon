/**
 * Fixed operating contract every broker-launched Grok worker receives through
 * `--system-prompt-override`.
 *
 * The override replaces Grok's ~12k-token coding-agent system prompt and stops
 * cwd `AGENTS.md` injection; the agent's identity and instructions still arrive
 * in the prompt file. It is compiled into the native launcher byte-for-byte
 * (`DBL_GROK_SYSTEM_PROMPT`), pinned by sha256 in the runtime contract
 * manifest, and must stay ASCII without quotes or backslashes so the C literal
 * needs no escaping.
 *
 * Daimon's per-wake tools reach Grok as deferred MCP tools named
 * `daimon__<tool>` (server `[mcp_servers.daimon]`). Naming them lets `use_tool`
 * run directly and saves one `search_tool` round trip per tool (P0: 3 → 2
 * requests).
 */

/**
 * The atoms of that route, and its single definition.
 *
 * Both texts a Grok worker receives are rendered from them: the pinned system
 * prompt below, and the caller's identity envelope
 * ({@link grokMountedToolNamingRule}, used by `src/runtime/engineDispatcher.ts`).
 * They were worded independently once - the envelope told the model to call the
 * tools by their bare names - and a live turn produced zero tool calls with
 * every tool correctly mounted: two authoritative naming rules, the wrong one
 * last. One definition is what keeps them from diverging again.
 */
export const DAIMON_GROK_MCP_SERVER = "daimon" as const;
/** Grok's own name for an MCP tool of that server: exactly what `tool_name` must carry. */
export const DAIMON_GROK_TOOL_PREFIX = `${DAIMON_GROK_MCP_SERVER}__` as const;
export const grokDaimonToolName = (tool: string): string => `${DAIMON_GROK_TOOL_PREFIX}${tool}`;
/** Grok's two MCP meta-tools, and the argument that names a tool for the first. */
export const GROK_MCP_INVOKE_TOOL = "use_tool" as const;
export const GROK_MCP_SEARCH_TOOL = "search_tool" as const;
export const GROK_MCP_TOOL_NAME_ARGUMENT = "tool_name" as const;
/** Illustrative Daimon tools for the system prompt, which cannot know a wake's real mount. */
const DAIMON_GROK_EXAMPLE_TOOLS = Object.freeze(["moltnet_read", "moltnet_send", "memory_search", "memory_register"] as const);

export const DAIMON_GROK_SYSTEM_PROMPT = [
  "You are a headless Daimon agent; no human is present.",
  "Your identity, instructions and wake event are in the user prompt.",
  `Daimon tools are MCP tools on server ${DAIMON_GROK_MCP_SERVER}: call a known one directly with ${GROK_MCP_INVOKE_TOOL} (${GROK_MCP_TOOL_NAME_ARGUMENT} ${DAIMON_GROK_EXAMPLE_TOOLS.map(grokDaimonToolName).join(", ")}, or another ${DAIMON_GROK_TOOL_PREFIX} name you were given); use ${GROK_MCP_SEARCH_TOOL} only for a name you do not know.`,
  "If a tool result says output was saved to a file, read that path with read_file.",
  "If a tool fails, do not retry it in a loop: stop and report the failure.",
  "Your final answer is a private note to the runtime: one line, or empty."
].join(" ");

/**
 * The same route, stated once for the caller's identity envelope, where a
 * wake's real mounted tools are known.
 *
 * It asserts rather than corrects: it names the bare tool set once, states the
 * `use_tool` prefix rule once with one example drawn from that set, and says
 * plainly that a bare name is not callable here. It never claims the agent's
 * own instructions spell a tool wrongly, never offers a shell or CLI route, and
 * never repeats the tool list a second time in prefixed form.
 */
export const grokMountedToolNamingRule = (mountedToolNames: readonly string[]): string => {
  const example = grokDaimonToolName(mountedToolNames[0] ?? DAIMON_GROK_EXAMPLE_TOOLS[0]);
  return `Your mounted tools are exactly: ${mountedToolNames.join(", ")}. `
    + `On this engine each is an MCP tool on server ${DAIMON_GROK_MCP_SERVER}: invoke it with ${GROK_MCP_INVOKE_TOOL}, `
    + `${GROK_MCP_TOOL_NAME_ARGUMENT} = ${DAIMON_GROK_TOOL_PREFIX}<name> (for example ${example}). `
    + "None appears in your direct tool list and none is callable by its bare name; "
    + `${GROK_MCP_SEARCH_TOOL} lists them if a name is unknown.`;
};

/** Closed declared-model vocabulary; defaults are `grok-4.6` at `low`. */
export const GROK_BROKER_MODELS = Object.freeze(["grok-4.6", "grok-4.5", "grok-build"] as const);
export const GROK_BROKER_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"] as const);

/** `--tools` input ids. These are NOT the model-visible names (see below). */
export const GROK_WORKER_TOOL_IDS = Object.freeze(["run_terminal_cmd", "read_file", "grep", "list_dir", "search_tool", "use_tool"] as const);

/**
 * The exact tool names a lean worker request body must carry.
 *
 * Grok 1.0.34 fails open on an unmappable `--tools` entry and ships all 19
 * tools, so the proxy compares every upstream body against this set.
 */
export const GROK_WORKER_VISIBLE_TOOLS = Object.freeze(["grep", "list_dir", "read_file", "run_terminal_command", "search_tool", "use_tool"] as const);

/** `--max-turns` backstop compiled into the launcher; per-wake ceilings belong to the broker. */
export const GROK_WORKER_MAX_TURNS = 48 as const;
