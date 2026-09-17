import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { mcpContentText, type McpUpstreamResult, type RenderedMcpToolResult } from "./mcpToolResult.js";

/**
 * Cap one declared MCP tool result, and spill the rest of it to disk.
 *
 * ## Why
 *
 * Production agents make 3–37 tool calls per wake, and every tool result stays
 * in the transcript for every *subsequent* model request of that wake. Context
 * per request is flat at 23–32k tokens, so one oversized result is not paid
 * once — it is paid again on every request that follows it, at cache-read rates
 * for the ones that hit and at fresh rates for the one that does not. A 40 KiB
 * result returned on call three of thirty is re-billed twenty-seven times.
 *
 * Before this, Daimon applied no cap of its own to a declared MCP tool's answer.
 * `mcpToolResult.ts` bounded it at 61,440 bytes — the receipt bound, not a
 * context bound — and above that degraded it to a *head only*, with no way to
 * recover the rest.
 *
 * ## The reference pattern
 *
 * `references/oh-my-pi` wraps **every** tool, MCP included, with the same
 * centralized spill (`packages/coding-agent/src/tools/output-meta.ts:724-891`,
 * mounted in `sdk.ts:2862-2869`):
 *
 *   - a byte threshold (`tools.artifactSpillThreshold`, default 50 KiB);
 *   - **head + tail retention** with the middle elided, so the model keeps both
 *     ends of the output (`truncateMiddle`,
 *     `packages/coding-agent/src/session/streaming-output.ts`), defaults
 *     20 KiB head + 20 KiB tail — an even split at 80% of the threshold;
 *   - the **full output written to disk** and addressed by an id
 *     (`session/artifacts.ts`);
 *   - a notice naming the ranges shown and the re-fetch address:
 *     `Showing lines X-Y of Z … Read artifact://ID for full output`
 *     (`formatTruncationMetaNotice`, `formatFullOutputReference`);
 *   - and the rule that a **failed save still truncates** — the recovery link is
 *     attached only when the write actually succeeded, because re-exposing the
 *     full output on a disk error is the one outcome worse than truncating.
 *
 * All five are reproduced here. What differs is only the address: oh-my-pi's
 * `artifact://<id>` is resolved by its own `read` tool, and Daimon has no such
 * protocol — so the notice names the **absolute path**, which every Daimon agent
 * can already read with the mounted `bash` tool (`piHarness.ts`) or the engine's
 * own shell. The file lives under the agent's own runtime home, which is exactly
 * the tree that home is for and the one tree every sandbox profile leaves the
 * agent (`grokSandboxProtectedPaths` denies *peers'* homes, never its own).
 */

/**
 * The cap on one lowered MCP tool result, measured the way
 * `mcpToolResult.ts` measures: the serialized `{content, structuredContent}`
 * record, both channels included.
 *
 * **16 KiB, ≈4k tokens.** oh-my-pi's 50 KiB default is calibrated for an
 * interactive coding agent with a 200k+ context; Daimon's whole per-request
 * context is 23–32k tokens, so a 50 KiB result would be *half of it* and would
 * be replayed on every remaining request of the wake. 16 KiB keeps any single
 * result under roughly a sixth of a request while leaving a realistic answer
 * — a page of messages, a document, a query result — entirely untouched: it is
 * a ceiling on the pathological case, not a working budget.
 */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 16 * 1024;

export const TOOL_RESULT_MAX_BYTES_ENV = "DAIMON_TOOL_RESULT_MAX_BYTES" as const;

/**
 * Tools that must never be truncated, by mounted tool name
 * (`mcp_<server>_<tool>`), comma-separated.
 *
 * Empty by default. It exists because Daimon cannot know what an organization
 * declared: if a deployment has one MCP tool whose *whole* answer is load
 * bearing — a signature, a checksummed document, a payload the agent must
 * reproduce verbatim — head+tail is not a degradation there, it is a wrong
 * answer, and no re-fetch instruction fixes a model that did not notice. That
 * judgement belongs to whoever declared the tool, so it is configuration rather
 * than a Daimon-side guess. An exempt tool keeps exactly today's behaviour,
 * including `mcpToolResult.ts`'s 61,440-byte receipt bound.
 */
export const TOOL_RESULT_EXEMPT_ENV = "DAIMON_TOOL_RESULT_NO_TRUNCATE" as const;

/**
 * A result may never be capped below this. Below roughly a kilobyte the head and
 * tail stop being usable at all and the notice dominates the payload, so a
 * mistyped bound degrades into "every tool is blind" — worse than no cap.
 */
export const MIN_TOOL_RESULT_MAX_BYTES = 2_048;

/** Spilled files live here, under the agent's own runtime home. */
export const TOOL_OUTPUT_DIRECTORY_NAME = "tool-output" as const;

/** Newest-first retention for spilled files, mirroring `pruneReceipts`. */
export const TOOL_OUTPUT_RETAINED_FILES = 256;

export const resolveToolResultMaxBytes = (environment: NodeJS.ProcessEnv = process.env): number => {
  const raw = environment[TOOL_RESULT_MAX_BYTES_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_TOOL_RESULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TOOL_RESULT_MAX_BYTES) {
    throw new Error(`${TOOL_RESULT_MAX_BYTES_ENV} must be an integer of at least ${MIN_TOOL_RESULT_MAX_BYTES}`);
  }
  return parsed;
};

export const resolveExemptToolNames = (environment: NodeJS.ProcessEnv = process.env): ReadonlySet<string> =>
  new Set((environment[TOOL_RESULT_EXEMPT_ENV] ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0));

const safeStringify = (value: unknown): string => {
  try { return JSON.stringify(value) ?? ""; } catch { return "[daimon: the MCP server returned a value that is not JSON-serialisable]"; }
};

const measure = (content: readonly unknown[], details: Record<string, unknown>): number =>
  Buffer.byteLength(safeStringify({ content, structuredContent: details }), "utf8");

/** Cut on a code-point boundary, from the front. */
const headUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

/** Cut on a code-point boundary, from the back. */
const tailUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let start = Math.max(0, bytes.byteLength - maxBytes);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
};

/**
 * The complete payload, as the text that gets written to disk and sliced.
 *
 * A result that is nothing but text parts is spilled as that text, because a
 * human-readable log is what the agent will `grep` and `sed`. Anything else — a
 * structured result, an image part, a mixed result — is spilled as the
 * serialized upstream record, which is lossless and is the same serialization
 * `mcpToolResult.ts` already degrades to today.
 */
export const spillPayload = (result: McpUpstreamResult): { text: string; format: "text" | "json" } => {
  const content = Array.isArray(result.content) ? result.content : undefined;
  const textOnly = content !== undefined
    && content.length > 0
    && content.every((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
    && result.structuredContent === undefined;
  if (textOnly) return { text: mcpContentText(content), format: "text" };
  return {
    text: safeStringify({
      ...(result.content === undefined ? {} : { content: result.content }),
      ...(result.structuredContent === undefined ? {} : { structured_content: result.structuredContent })
    }),
    format: "json"
  };
};

const notice = (input: Readonly<{
  totalBytes: number;
  headBytes: number;
  tailBytes: number;
  boundBytes: number;
  format: "text" | "json";
  spillPath?: string;
}>): string => {
  const elided = Math.max(0, input.totalBytes - input.headBytes - input.tailBytes);
  const shape = input.format === "json" ? "the serialized result record" : "the result text";
  const head = [
    `\n\n[daimon: truncated — this tool result was ${input.totalBytes} bytes, above the ${input.boundBytes}-byte per-result bound.`,
    `Showing the first ${input.headBytes} and last ${input.tailBytes} bytes of ${shape}; ${elided} bytes were elided from the middle.`
  ].join(" ");
  if (input.spillPath === undefined) {
    return `${head} The complete result could NOT be written to disk, so the elided bytes are unrecoverable.`
      + " Repeating this call will truncate again — narrow the call's arguments instead, or ask for the missing part specifically.]";
  }
  return `${head} The complete result is saved at ${input.spillPath}.`
    + ` Read the elided middle from that file with the shell — for example \`sed -n '1,200p' ${input.spillPath}\``
    + ` or \`grep -n "<pattern>" ${input.spillPath}\` — and do NOT repeat this tool call to see it: an identical call returns this same truncation.]`;
};

/**
 * Spilled files are group-readable and never other-readable.
 *
 * A brokered Grok worker runs as its own uid and reads a spill with
 * `read_file`, so a 0600 file owned by the runtime (uid 2000) was unreadable to
 * the very agent the notice sends there. The group grant reaches exactly that
 * agent's worker only when the deployment provisions `tool-output` as
 * `<runtime uid>:<worker gid> 2750` (setgid, so each file inherits the worker
 * group; `GROK_ENGINE_BROKER.worker.home.spillDirectory`). A directory Daimon
 * creates itself stays 0700, so for every other engine nothing new is exposed.
 */
export const SPILL_FILE_MODE = 0o640;
export const SPILL_DIRECTORY_MAX_MODE = 0o2750;

/**
 * Write the full payload where the agent can read it, atomically.
 *
 * Staged to a sibling and renamed, so a half-written file is never addressable:
 * a truncation notice that points at a truncated file is worse than one that
 * admits the save failed.
 */
const writeSpill = async (directory: string, name: string, text: string): Promise<string> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pinned = await pinSpillDirectory(directory);
  const file = path.join(directory, name);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, SPILL_FILE_MODE);
    let written: Awaited<ReturnType<typeof handle.stat>>;
    // Explicit, so a restrictive umask cannot strip the group read an agent's sandboxed worker needs.
    try { await handle.chmod(SPILL_FILE_MODE); await handle.writeFile(text, "utf8"); await handle.sync(); written = await handle.stat(); } finally { await handle.close(); }
    if (!written.isFile() || written.nlink !== 1 || written.uid !== process.getuid?.()) throw new Error("spill file is not a private regular file");
    // Node has no openat: re-check that the directory entry still names the pinned inode before publishing into it.
    await assertSameDirectory(directory, pinned);
    // rename replaces a pre-existing destination entry (a symlink included) without following it.
    await rename(temporary, file);
    const published = await lstat(file);
    if (!published.isFile() || published.dev !== written.dev || published.ino !== written.ino) throw new Error("spill file was replaced");
    return file;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await pinned.handle.close();
  }
};

type PinnedDirectory = Readonly<{ handle: Awaited<ReturnType<typeof open>>; dev: number; ino: number }>;

/**
 * The spill directory must be a real directory owned by this runtime and no
 * wider than `2750`: either Daimon's own `0700`, or a deployment-provisioned
 * setgid directory whose group is not the runtime's own (a worker group). A
 * symlinked, foreign-owned, world-accessible, or group-open-without-setgid
 * directory is refused and nothing is written. Daimon cannot know *which*
 * worker gid belongs to this agent; that mapping is the deployment's
 * provisioning contract (`GROK_ENGINE_BROKER.worker.home.spillDirectory`).
 */
const pinSpillDirectory = async (directory: string): Promise<PinnedDirectory> => {
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error("spill directory is not a real directory");
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("spill directory was replaced");
    assertSpillDirectoryStat(opened, { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 });
    return { handle, dev: Number(opened.dev), ino: Number(opened.ino) };
  } catch (error) { await handle.close(); throw error; }
};

/** Pure so a foreign owner is testable without root. */
export const assertSpillDirectoryStat = (entry: Readonly<{ uid: number; gid: number; mode: number; isDirectory(): boolean }>, runtime: Readonly<{ uid: number; gid: number }>): void => {
  const mode = Number(entry.mode) & 0o7777;
  const groupOpen = (mode & 0o070) !== 0;
  if (!entry.isDirectory() || entry.uid !== runtime.uid || (mode & ~SPILL_DIRECTORY_MAX_MODE) !== 0
    || (groupOpen && ((mode & 0o2000) === 0 || entry.gid === runtime.gid))) {
    throw new Error("spill directory is not a private or provisioned worker-group directory");
  }
};

const assertSameDirectory = async (directory: string, pinned: PinnedDirectory): Promise<void> => {
  const [now, held] = await Promise.all([lstat(directory), pinned.handle.stat()]);
  if (now.isSymbolicLink() || Number(now.dev) !== pinned.dev || Number(now.ino) !== pinned.ino || Number(held.ino) !== pinned.ino) throw new Error("spill directory was replaced");
};

/** Newest-first retention, so a busy agent cannot fill its own runtime home. */
const pruneSpills = async (directory: string): Promise<void> => {
  const names = (await readdir(directory)).filter((name) => /\.log$/u.test(name));
  const entries = await Promise.all(names.map(async (name) => ({ name, info: await lstat(path.join(directory, name)) })));
  const files = entries.filter(({ info }) => info.isFile() && info.nlink === 1);
  for (const candidate of files.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs || right.name.localeCompare(left.name)).slice(TOOL_OUTPUT_RETAINED_FILES)) {
    await unlink(path.join(directory, candidate.name)).catch(() => undefined);
  }
};

/** `mcp_<server>_<tool>` is already `[A-Za-z0-9_]`, but the filename never trusts that. */
const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 64) || "tool";

export type CappedToolResult = RenderedMcpToolResult & {
  /** Absolute path of the spilled full result, when one was written. */
  readonly spillPath?: string;
};

/**
 * Return `rendered` untouched when it fits, or a head+tail view of the full
 * payload plus a notice naming the file that holds the rest.
 *
 * A result under the cap passes through **byte-identical**: the `mcp_*`
 * passthrough contract — both channels carrying the payload, an upstream
 * `structuredContent` forwarded verbatim — is unchanged for every result that
 * does not blow the bound, which is the overwhelming majority of them.
 */
export const capToolResult = async (input: Readonly<{
  toolName: string;
  rendered: RenderedMcpToolResult;
  result: McpUpstreamResult;
  maxBytes: number;
  exempt: ReadonlySet<string>;
  spillDirectory: string;
  spillId: string;
}>): Promise<CappedToolResult> => {
  if (input.exempt.has(input.toolName)) return input.rendered;
  if (measure(input.rendered.content, input.rendered.details) <= input.maxBytes) return input.rendered;

  const payload = spillPayload(input.result);
  const totalBytes = Buffer.byteLength(payload.text, "utf8");

  let spillPath: string | undefined;
  try {
    spillPath = await writeSpill(input.spillDirectory, `${safeName(input.spillId)}.${safeName(input.toolName)}.log`, payload.text);
  } catch {
    // oh-my-pi's rule, and the reason it is a rule: a save failure must never
    // convert a successful call into an error, and must never re-expose the
    // full output. Truncate anyway; only the recovery link is withheld.
    spillPath = undefined;
  }
  if (spillPath !== undefined) await pruneSpills(input.spillDirectory).catch(() => undefined);

  // The notice's own bytes are reserved first, priced with the widest numbers it
  // could print. Both channels then mirror each other (`mcpToolResult.ts` rule
  // 1) so the retained body is written twice and the budget is halved to pay for
  // it — the same arithmetic, and the same reason, as that file's `degrade`. The
  // fit is then *verified* rather than estimated, because JSON escaping of the
  // payload's own bytes (a newline costs two) is not predictable from its length.
  const reserve = Buffer.byteLength(notice({
    totalBytes, headBytes: totalBytes, tailBytes: totalBytes, boundBytes: input.maxBytes, format: payload.format, ...(spillPath === undefined ? {} : { spillPath })
  }), "utf8");
  const build = (budget: number): CappedToolResult => {
    const head = headUtf8(payload.text, Math.floor(budget / 2));
    const headBytes = Buffer.byteLength(head, "utf8");
    const tail = tailUtf8(payload.text, Math.max(0, budget - headBytes));
    const tailBytes = Buffer.byteLength(tail, "utf8");
    const elided = Math.max(0, totalBytes - headBytes - tailBytes);
    const shown = `${head}\n[… ${elided} bytes elided …]\n${tail}`;
    const text = `${shown}${notice({ totalBytes, headBytes, tailBytes, boundBytes: input.maxBytes, format: payload.format, ...(spillPath === undefined ? {} : { spillPath }) })}`;
    return {
      content: [{ type: "text", text }],
      details: {
        daimon_truncated: true,
        bound_bytes: input.maxBytes,
        result_bytes: totalBytes,
        shown_head_bytes: headBytes,
        shown_tail_bytes: tailBytes,
        elided_bytes: elided,
        payload_format: payload.format,
        ...(spillPath === undefined ? { full_output_saved: false } : { full_output_path: spillPath }),
        result_head_tail: shown
      },
      truncated: true,
      ...(spillPath === undefined ? {} : { spillPath })
    };
  };
  let budget = Math.max(0, Math.floor((input.maxBytes - reserve) / 2));
  let candidate = build(budget);
  for (let attempt = 0; attempt < 8 && budget > 0; attempt += 1) {
    const size = measure(candidate.content, candidate.details);
    if (size <= input.maxBytes) return candidate;
    budget = Math.max(0, budget - Math.ceil((size - input.maxBytes) / 2) - 16);
    candidate = build(budget);
  }
  return candidate;
};
