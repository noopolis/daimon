/**
 * The in-flight MCP tool calls of one brokered turn.
 *
 * Daimon writes a tool receipt only when a call *completes*, so a call that
 * started and never returned is byte-identical, in every artifact, to a call
 * that was never made. A live Grok turn stopped acting after its eighth
 * provider response and was killed by the trial deadline seven minutes later
 * with the proxy's per-request ledger reporting `open: 0` — every provider
 * request closed — which leaves exactly one unlit path: a tool call the worker
 * issued and the facade never answered.
 *
 * This is that light, and it follows the per-request ledger's rules rather
 * than inventing its own:
 *
 * - **names and timings only.** The tool name off the JSON-RPC envelope and
 *   two clocks. Never arguments, never a result, never a session id, never a
 *   capability or bearer. A name that is not a plain short identifier is
 *   recorded as {@link ENGINE_BROKER_MCP_CALL_INVALID} rather than passed
 *   through, and the list is bounded at
 *   {@link ENGINE_BROKER_MCP_OUTSTANDING_MAX} with
 *   {@link ENGINE_BROKER_MCP_CALL_TRUNCATED} as its last entry.
 * - **absence stays absence.** A turn the log never opened observes as
 *   `undefined`; a turn that made no call observes `started: 0`, which is not
 *   the same statement as an answered call. A POST whose body the facade could
 *   not read counts in `undecoded` and never as a call with a name, because a
 *   fabricated name is byte-identical to a measured one — and because "zero
 *   calls started" is exactly the reading this instrument exists to make
 *   trustworthy.
 * - **it cannot fail a turn.** Every operation here is arithmetic over a map,
 *   the one parse is wrapped, and the facade treats a missing handle as a
 *   no-op.
 *
 * The same map carries the facade's *other* channel, and for the same reason.
 * A `tools/call` is a POST that answers; the standalone `GET` SSE tunnel the
 * Streamable HTTP transport opens once per session is the route a server
 * notification or progress frame takes, and it stays open for the whole
 * session by design. A worker parked reading that tunnel is, in every artifact
 * the broker writes, indistinguishable from a worker doing nothing at all:
 * every provider request closed, every tool call answered, and the turn idle
 * until its deadline. {@link EngineBrokerMcpCallLog.openTunnel} records the
 * lifecycle — how many the facade relayed, how many ended, and for the ones
 * still open at seal time how long each has been open and whether the mount
 * ever pushed a single byte through it. A tunnel held open having delivered
 * nothing is a different fact from one actively carrying frames, and it is the
 * difference that decides whether the tunnel is the blocker.
 *
 * Observing is all it does. The facade's behaviour is unchanged: nothing here
 * closes, times out or refuses a tunnel, because an instrument that tore down
 * the stream would destroy the evidence it exists to gather.
 *
 * "Answered" means the facade wrote a complete response back to the worker —
 * the relay reached its own `end()`. A relay that was torn down (the worker
 * died, the tunnel broke, the turn aborted) did *not* answer, so its calls stay
 * outstanding with the elapsed time they had reached. That is the whole point:
 * the turn's death must not retroactively mark the call it was blocked on as
 * finished.
 */
export const ENGINE_BROKER_MCP_OUTSTANDING_MAX = 16;
export const ENGINE_BROKER_MCP_CALL_INVALID = "<invalid>";
export const ENGINE_BROKER_MCP_CALL_TRUNCATED = "<truncated>";
/** A plain short identifier, or one of the two sentinels above. */
export const ENGINE_BROKER_MCP_CALL_NAME = /^(?:<invalid>|<truncated>|[A-Za-z0-9_.-]{1,64})$/u;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;

/** Open GET tunnels reported: a session opens one, so more than a handful is already the anomaly. */
export const ENGINE_BROKER_MCP_TUNNEL_MAX = 8;

export type EngineBrokerOutstandingMcpCall = Readonly<{ name: string; outstandingMs: number }>;
/** One GET SSE tunnel still open at observation: how long it has been open, and whether the mount ever pushed through it. */
export type EngineBrokerOpenMcpTunnel = Readonly<{ openMs: number; delivered: boolean }>;
/**
 * What the facade saw of one turn's standalone GET SSE tunnels: how many it
 * relayed, how many ended, how many ever carried a byte from the mount, and
 * the ones still open with the age of each.
 */
export type EngineBrokerMcpTunnelObservation = Readonly<{ opened: number; closed: number; delivered: number; open: readonly EngineBrokerOpenMcpTunnel[] }>;
/**
 * What the facade saw of one turn's tool calls: how many started, how many the
 * facade answered, how many POST bodies it could not read, and the ones still
 * unanswered with the time each has been outstanding.
 */
export type EngineBrokerMcpCallObservation = Readonly<{ started: number; answered: number; undecoded: number; outstanding: readonly EngineBrokerOutstandingMcpCall[]; tunnels?: EngineBrokerMcpTunnelObservation }>;

/** One relayed POST's calls. `answer` marks a complete relay; `close` ends it unanswered. Both are idempotent. */
export interface EngineBrokerMcpCallHandle { answer(): void; close(): void }
const INERT: EngineBrokerMcpCallHandle = { answer: () => undefined, close: () => undefined };
/** One relayed GET tunnel. `deliver` marks the first byte the mount pushed; `close` ends it. Both are idempotent. */
export interface EngineBrokerMcpTunnelHandle { deliver(): void; close(): void }
const INERT_TUNNEL: EngineBrokerMcpTunnelHandle = { deliver: () => undefined, close: () => undefined };

type CallRecord = { readonly name: string; readonly startedAt: number; endedAt?: number };
type TunnelRecord = { readonly openedAt: number; delivered: boolean };
type TurnLog = {
  started: number; answered: number; undecoded: number; readonly live: Set<CallRecord>; readonly ended: CallRecord[];
  tunnelsOpened: number; tunnelsClosed: number; tunnelsDelivered: number; readonly openTunnels: Set<TunnelRecord>;
};

export class EngineBrokerMcpCallLog {
  private readonly turns = new Map<string, TurnLog>();
  constructor(private readonly now: () => number = Date.now) {}

  /** A turn the facade registered. Re-opening an id resets it: a turn id is unique per turn. */
  open(turnId: string): void { this.turns.set(turnId, { started: 0, answered: 0, undecoded: 0, live: new Set(), ended: [], tunnelsOpened: 0, tunnelsClosed: 0, tunnelsDelivered: 0, openTunnels: new Set() }); }
  close(turnId: string): void { this.turns.delete(turnId); }

  /** A POST body the facade is about to relay. Anything that is not a `tools/call` records nothing. */
  begin(turnId: string, body: Uint8Array | undefined): EngineBrokerMcpCallHandle {
    const log = this.turns.get(turnId);
    if (log === undefined || body === undefined || body.byteLength === 0) return INERT;
    const names = toolCallNames(body);
    if (names === undefined) { log.undecoded += 1; return INERT; }
    if (names.length === 0) return INERT;
    const startedAt = this.now();
    const records = names.map((name): CallRecord => ({ name, startedAt }));
    log.started += records.length;
    for (const record of records) log.live.add(record);
    let settled = false;
    return {
      answer: (): void => {
        if (settled) return; settled = true;
        log.answered += records.length;
        for (const record of records) log.live.delete(record);
      },
      close: (): void => {
        if (settled) return; settled = true;
        const endedAt = this.now();
        for (const record of records) {
          log.live.delete(record); record.endedAt = endedAt;
          // Retain only as many as can be reported; the earliest are the ones
          // a hang is about, so a later flood cannot displace them.
          if (log.ended.length < ENGINE_BROKER_MCP_OUTSTANDING_MAX) log.ended.push(record);
        }
      }
    };
  }

  /**
   * A GET SSE tunnel the facade is about to relay. Counted when it opens, not
   * when it succeeds: a tunnel the mount refused still ends, so `opened` and
   * `closed` stay a pair and an open one is exactly `opened - closed`.
   */
  openTunnel(turnId: string): EngineBrokerMcpTunnelHandle {
    const log = this.turns.get(turnId);
    if (log === undefined) return INERT_TUNNEL;
    const record: TunnelRecord = { openedAt: this.now(), delivered: false };
    log.tunnelsOpened += 1;
    log.openTunnels.add(record);
    let ended = false;
    return {
      deliver: (): void => { if (record.delivered) return; record.delivered = true; log.tunnelsDelivered += 1; },
      close: (): void => { if (ended) return; ended = true; log.tunnelsClosed += 1; log.openTunnels.delete(record); }
    };
  }

  /** A POST whose body the facade refused to read (over its own bound), which is a call it cannot name. */
  undecodable(turnId: string): void { const log = this.turns.get(turnId); if (log !== undefined) log.undecoded += 1; }

  observe(turnId: string): EngineBrokerMcpCallObservation | undefined {
    const log = this.turns.get(turnId);
    if (log === undefined) return undefined;
    const at = this.now();
    const pending = [...log.live, ...log.ended].sort((left, right) => left.startedAt - right.startedAt);
    const outstanding = pending.map((record): EngineBrokerOutstandingMcpCall => ({ name: record.name, outstandingMs: Math.max(0, (record.endedAt ?? at) - record.startedAt) }));
    const open = [...log.openTunnels]
      .sort((left, right) => left.openedAt - right.openedAt)
      .slice(0, ENGINE_BROKER_MCP_TUNNEL_MAX)
      .map((record): EngineBrokerOpenMcpTunnel => ({ openMs: Math.max(0, at - record.openedAt), delivered: record.delivered }));
    return {
      started: log.started, answered: log.answered, undecoded: log.undecoded,
      tunnels: { opened: log.tunnelsOpened, closed: log.tunnelsClosed, delivered: log.tunnelsDelivered, open },
      outstanding: outstanding.length > ENGINE_BROKER_MCP_OUTSTANDING_MAX
        ? [...outstanding.slice(0, ENGINE_BROKER_MCP_OUTSTANDING_MAX - 1), { name: ENGINE_BROKER_MCP_CALL_TRUNCATED, outstandingMs: 0 }]
        : outstanding
    };
  }
}

/**
 * The tool names one JSON-RPC POST asks for: `undefined` when the body did not
 * decode at all (which is a fact of its own, not zero calls), `[]` when it
 * decoded and asked for no tool. A batch names each of its calls.
 */
function toolCallNames(body: Uint8Array): readonly string[] | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")); } catch { return undefined; }
  const entries: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.method !== "tools/call") continue;
    const name = isRecord(entry.params) ? entry.params.name : undefined;
    names.push(typeof name === "string" && TOOL_NAME.test(name) ? name : ENGINE_BROKER_MCP_CALL_INVALID);
  }
  return names;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
