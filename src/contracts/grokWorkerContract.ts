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
export const DAIMON_GROK_SYSTEM_PROMPT = [
  "You are a headless Daimon agent; no human is present.",
  "Your identity, instructions and wake event are in the user prompt.",
  "Daimon tools are MCP tools on server daimon: call a known one directly with use_tool (tool_name daimon__moltnet_read, daimon__moltnet_send, daimon__memory_search, daimon__memory_register, or another daimon__ name you were given); use search_tool only for a name you do not know.",
  "If a tool result says output was saved to a file, read that path with read_file.",
  "If a tool fails, do not retry it in a loop: stop and report the failure.",
  "Your final answer is a private note to the runtime: one line, or empty."
].join(" ");

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
