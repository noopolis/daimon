import { randomBytes } from "node:crypto";
import path from "node:path";

import type { MemoryWakeMode, WakeMemoryContext } from "@noopolis/mneme";

import type { WakeEvent } from "../core/types.js";

export const wakeModeForEvent = (event: WakeEvent): MemoryWakeMode =>
  event.kind === "dream" ? "dream" : "awake";

export const createAwakeThreadId = (memoryContext: WakeMemoryContext, agentId: string): string =>
  `${memoryContext.networkId ?? "local"}:${memoryContext.roomId ?? memoryContext.from ?? agentId}`;

export const createDreamSessionKey = (event: WakeEvent): string =>
  `${safeSessionPart(event.id)}-${randomBytes(4).toString("hex")}`;

export const createDreamThreadId = (sessionKey: string): string => `dream:${sessionKey}`;

export const createDreamSessionDirectory = (runtimeHomePath: string, sessionKey: string): string =>
  path.join(runtimeHomePath, "sessions", "dream", sessionKey);

export const formatDreamPrompt = (promptText: string, threadId: string): string => [
  "## Dream Mode",
  "",
  "This is a one-off memory consolidation session. Use Mneme tools to audit, summarize, promote, or retire memories with explicit evidence. Do not treat this as a normal chat reply.",
  `dream_thread: ${threadId}`,
  "",
  promptText
].join("\n");

const safeSessionPart = (value: string): string => {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return (normalized || "wake").slice(0, 80);
};
