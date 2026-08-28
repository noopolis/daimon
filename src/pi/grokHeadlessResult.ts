const PUBLISHABLE_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResult = (detail: string): Error =>
  new Error(`Grok CLI returned no publishable terminal response: ${detail}`);

type TerminalAssistant = Readonly<{ sessionId: string; stopReason: string; text: string }>;

const decodeTerminalAssistant = (event: JsonRecord): TerminalAssistant | undefined => {
  if (event.type !== "assistant" || event.parent_tool_use_id !== null) return undefined;
  if (typeof event.session_id !== "string" || !isRecord(event.message)) throw invalidResult("invalid assistant event");
  const message = event.message;
  if (message.role !== "assistant" || typeof message.stop_reason !== "string" || !Array.isArray(message.content)) {
    throw invalidResult("invalid assistant event");
  }
  if (!PUBLISHABLE_STOP_REASONS.has(message.stop_reason)) return { sessionId: event.session_id, stopReason: message.stop_reason, text: "" };
  let text = "";
  let textBlocks = 0;
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== "string") throw invalidResult("invalid assistant content");
    if (block.type === "thinking") continue;
    if (block.type !== "text" || typeof block.text !== "string") throw invalidResult("invalid terminal content");
    text += block.text;
    textBlocks += 1;
  }
  if (textBlocks === 0 || text.trim().length === 0) throw invalidResult("empty response");
  return { sessionId: event.session_id, stopReason: message.stop_reason, text };
};

/** Decode Grok's terminal message stream without treating progress messages as a reply. */
export const decodeGrokHeadlessResult = (output: string): string => {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw invalidResult("empty stream");
  let finalAssistant: TerminalAssistant | undefined;
  let result: JsonRecord | undefined;
  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw invalidResult("invalid JSON"); }
    if (!isRecord(event) || typeof event.type !== "string") throw invalidResult("invalid event");
    if (event.type === "error") {
      const rejection = asGrokAuthenticationRejected(JSON.stringify(event));
      if (rejection !== undefined) throw rejection;
      throw invalidResult("engine error");
    }
    const assistant = decodeTerminalAssistant(event);
    if (assistant !== undefined) finalAssistant = assistant;
    if (event.type === "result") {
      if (index !== lines.length - 1) throw invalidResult("non-terminal result");
      result = event;
    }
  }
  if (result === undefined || result.subtype !== "success" || result.is_error !== false) throw invalidResult("unsuccessful result");
  if (typeof result.stop_reason !== "string" || !PUBLISHABLE_STOP_REASONS.has(result.stop_reason)) throw invalidResult("non-terminal stop");
  if ("errors" in result && (!Array.isArray(result.errors) || result.errors.length > 0)) throw invalidResult("engine error");
  if (typeof result.result !== "string" || result.result.trim().length === 0) throw invalidResult("empty response");
  if (finalAssistant === undefined || finalAssistant.stopReason !== result.stop_reason ||
      finalAssistant.sessionId !== result.session_id || finalAssistant.text !== result.result) {
    throw invalidResult("terminal result mismatch");
  }
  return result.result.trim();
};
import { asGrokAuthenticationRejected } from "../runtime/grokAuthenticationError.js";
