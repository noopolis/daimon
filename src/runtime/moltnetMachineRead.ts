/**
 * Paging and error semantics for Moltnet's frozen `machine` read wire.
 *
 * The wire is a strict v1 with two caps that a naive read ignores, and both are
 * enforced *server side* by `projectRead` in the Moltnet CLI
 * (`moltnet/internal/machine/service.go`), which answers
 * `{"error":{"code":"transport"}}` rather than truncating:
 *
 *   - `MachineMaxOutputLineBytes` (16384) bounds the whole encoded response
 *     line. `MachineReadPage.Validate` measures it against a *worst case*
 *     envelope — a maximum-length correlation id and target id — so the
 *     effective payload budget is roughly 250 bytes tighter than the line an
 *     agent actually receives.
 *   - `MachineMaxReadPartTextBytes` (4096) bounds any single message part.
 *
 * An agent asking for `limit: 100` on a room of six ~2000-byte messages
 * therefore never got a page at all: seven such messages already overflow the
 * line. Reading in small pages and following the returned cursor is the only
 * way to get a busy room across this wire, so that behaviour lives here rather
 * than in the tool that happens to call it.
 */

/** `protocol.MachineMaxOutputLineBytes`, quoted for diagnostics only. */
export const MOLTNET_MACHINE_MAX_OUTPUT_LINE_BYTES = 16_384;
/** `protocol.MachineMaxReadPartTextBytes`, quoted for diagnostics only. */
export const MOLTNET_MACHINE_MAX_READ_PART_TEXT_BYTES = 4_096;
/**
 * Messages requested per wire page.
 *
 * Six ~2000-byte messages were the largest page observed to encode inside the
 * line cap against the real 0.1.17 binary, so five leaves headroom for a page
 * of unusually large messages before the adaptive halving below is needed.
 */
export const MOLTNET_READ_PAGE_LIMIT = 5;
/** Hard stop on wire round trips, so a misbehaving cursor cannot spin forever. */
export const MOLTNET_READ_MAX_PAGES = 64;

/**
 * A `machine` response that carried `error.code`.
 *
 * The code is the whole diagnosis — a `transport` is a cap overflow, a
 * `not_found` is an undeclared target, a `canceled` is a stdin race — and
 * collapsing all of them into one generic string is what hid a never-working
 * tool for as long as it did.
 */
export class MoltnetMachineError extends Error {
  public readonly code: string;

  public constructor(operation: string, code: string) {
    super(`Moltnet ${operation} failed: ${code}`);
    this.name = "MoltnetMachineError";
    this.code = code;
  }
}

/**
 * Unwrap one `machine` response, surfacing `error.code` as a thrown
 * {@link MoltnetMachineError} rather than an anonymous refusal.
 */
export function moltnetOperationResult(
  response: Record<string, unknown>,
  key: string,
  operation: string
): Record<string, unknown> | undefined {
  const error = response.error;
  if (error !== undefined && error !== null) {
    const code = typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "unknown";
    throw new MoltnetMachineError(operation, code);
  }
  const result = response[key];
  return typeof result === "object" && result !== null ? result as Record<string, unknown> : undefined;
}

export interface MoltnetReadWirePage {
  readonly messages: readonly unknown[];
  readonly hasMore: boolean;
  readonly nextBefore?: string;
  readonly nextAfter?: string;
  readonly target?: unknown;
}

export type MoltnetReadFetch = (
  request: { readonly limit: number; readonly before?: string; readonly after?: string }
) => Promise<MoltnetReadWirePage>;

export interface MoltnetReadTruncation {
  readonly reason: "message_exceeds_machine_wire_caps" | "result_bound" | "page_bound";
  readonly detail: string;
  readonly cursor?: string;
}

export interface MoltnetPagedRead {
  readonly target?: unknown;
  readonly messages: readonly unknown[];
  readonly hasMore: boolean;
  readonly nextBefore?: string;
  readonly nextAfter?: string;
  readonly pages: number;
  readonly truncated?: MoltnetReadTruncation;
}

export interface MoltnetPagedReadOptions {
  readonly requested: number;
  readonly before?: string;
  readonly after?: string;
  readonly maxBytes: number;
  readonly pageLimit?: number;
  readonly fetch: MoltnetReadFetch;
}

/**
 * Read `requested` messages by walking the wire in pages small enough to encode.
 *
 * Direction follows the caller's cursor: an `after` read walks forward through
 * `next_after`, everything else walks backward from the newest message through
 * `next_before`. Either way the returned messages are in one stable
 * chronological order, oldest first, matching the order a single page arrives
 * in.
 */
export async function readMoltnetPages(options: MoltnetPagedReadOptions): Promise<MoltnetPagedRead> {
  const forward = options.after !== undefined;
  const pageLimit = Math.max(1, options.pageLimit ?? MOLTNET_READ_PAGE_LIMIT);
  const collected: (readonly unknown[])[] = [];
  const visited = new Set<string>();
  let cursor = forward ? options.after : options.before;
  let target: unknown;
  let total = 0;
  let pages = 0;
  let bytes = 0;
  let hasMore = false;
  let nextCursor: string | undefined;
  let truncated: MoltnetReadTruncation | undefined;

  while (total < options.requested && pages < MOLTNET_READ_MAX_PAGES) {
    const wanted = Math.min(pageLimit, options.requested - total);
    const page = await fetchWithinCaps(options.fetch, wanted, forward, cursor);
    if (page instanceof MoltnetMachineError) {
      // A cursor the caller supplied that yields nothing is a bad cursor, not a
      // message too large to encode: the two are indistinguishable on this wire
      // (both are `transport`), and an empty truncated read hides the mistake
      // where the code names it.
      if (pages === 0 && (options.before !== undefined || options.after !== undefined)) throw page;
      truncated = oversizedMessage(cursor);
      hasMore = true;
      nextCursor = cursor;
      break;
    }
    const pageBytes = Buffer.byteLength(JSON.stringify(page.messages));
    if (pages > 0 && bytes + pageBytes > options.maxBytes) {
      truncated = {
        reason: "result_bound",
        detail: `the concatenated read reached the ${options.maxBytes} byte tool result bound`,
        ...(cursor === undefined ? {} : { cursor })
      };
      hasMore = true;
      nextCursor = cursor;
      break;
    }
    if (target === undefined) target = page.target;
    collected.push(page.messages);
    bytes += pageBytes;
    total += page.messages.length;
    pages += 1;
    const next = forward ? page.nextAfter : page.nextBefore;
    const resumable = page.hasMore && typeof next === "string" && next.length > 0;
    hasMore = resumable;
    nextCursor = resumable ? next : undefined;
    // A repeated cursor or an empty page means the wire stopped making
    // progress; continuing would spin without ever satisfying `requested`.
    if (!resumable || page.messages.length === 0 || visited.has(next!)) break;
    visited.add(next!);
    cursor = next;
  }

  if (hasMore && truncated === undefined && pages >= MOLTNET_READ_MAX_PAGES) {
    truncated = {
      reason: "page_bound",
      detail: `the read stopped after ${MOLTNET_READ_MAX_PAGES} wire pages`,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor })
    };
  }

  return {
    ...(target === undefined ? {} : { target }),
    messages: forward ? collected.flat() : collected.reverse().flat(),
    hasMore,
    ...(nextCursor === undefined ? {} : forward ? { nextAfter: nextCursor } : { nextBefore: nextCursor }),
    pages,
    ...(truncated === undefined ? {} : { truncated })
  };
}

/**
 * Fetch one page, halving the requested limit on every `transport` refusal.
 *
 * A returned {@link MoltnetMachineError} means even a single message could not
 * be projected onto the wire. The wire offers no way to name or skip that
 * message — a cursor only ever comes back inside a page that encoded — so the
 * caller decides between reporting the blockage and failing outright.
 */
async function fetchWithinCaps(
  fetch: MoltnetReadFetch,
  wanted: number,
  forward: boolean,
  cursor: string | undefined
): Promise<MoltnetReadWirePage | MoltnetMachineError> {
  let limit = wanted;
  for (;;) {
    try {
      return await fetch({
        limit,
        ...(cursor === undefined ? {} : forward ? { after: cursor } : { before: cursor })
      });
    } catch (error) {
      if (!(error instanceof MoltnetMachineError) || error.code !== "transport") throw error;
      if (limit <= 1) return error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
}

function oversizedMessage(cursor: string | undefined): MoltnetReadTruncation {
  return {
    reason: "message_exceeds_machine_wire_caps",
    detail: "one Moltnet message could not be encoded onto the machine read wire"
      + ` (part text limit ${MOLTNET_MACHINE_MAX_READ_PART_TEXT_BYTES} bytes,`
      + ` response line limit ${MOLTNET_MACHINE_MAX_OUTPUT_LINE_BYTES} bytes);`
      + " the read returned everything up to it rather than failing",
    ...(cursor === undefined ? {} : { cursor })
  };
}
