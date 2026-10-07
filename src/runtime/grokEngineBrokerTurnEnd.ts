import { readdir, readFile } from "node:fs/promises";

import type { EngineBrokerMcpActivity } from "./engineBrokerMcpCallLog.js";
import type { GrokBrokerTurnMeter } from "./grokBrokerTurnMeter.js";

/**
 * When a brokered turn is over, decided by the broker rather than by the
 * worker's exit.
 *
 * Grok 1.0.34 answers, logs `handle_prompt.done ok:true`, ends its session
 * `turn_ended completed` — and then does not exit. Production measured it: 61
 * of 128 turns over two days sat 8–27 minutes after their last model request
 * until the wall-clock limit killed them, and each was then sealed
 * `failed/timeout` with its work already done. Every one still had its MCP GET
 * tunnel open, but that is a symptom: against the real 1.0.34 binary the tunnel
 * held open, closed, refused (405) or absent all exit ~55 ms after `result`,
 * and Grok reopens a closed tunnel within milliseconds, so closing it cannot
 * end a worker. The launcher only publishes a worker's output when the worker
 * exits, so waiting for the exit made the deadline the only way a turn could
 * end.
 *
 * The proxy sees every model answer, so the broker knows when the model has
 * given its final reply: a successful response that called no tool and
 * stopped. From that point:
 *
 * 1. `onFinalReply` runs once — the broker notes the worker it will end while
 *    that worker is certainly still alive.
 * 2. After {@link GROK_BROKER_TURN_END}`.finalGraceMs` with no new model request
 *    and no tool call in flight, `onEnd("final_reply")` runs: the broker ends
 *    the worker and seals the turn completed with that reply.
 *
 * A new model request clears the final reply (the meter forgets it on admit),
 * so a model that keeps going is never cut off. Independently, a turn with no
 * model request and no tool call in flight and no activity of either kind for
 * `idleMs` ends as `onEnd("idle")` — the backstop for a worker that stalls
 * without ever answering. Shell tools Grok runs itself are invisible here, so
 * the idle bound is minutes, not seconds.
 */
export type GrokBrokerTurnEndTiming = Readonly<{ finalGraceMs: number; idleMs: number; pollMs: number }>;
export const GROK_BROKER_TURN_END: GrokBrokerTurnEndTiming = Object.freeze({ finalGraceMs: 15_000, idleMs: 10 * 60_000, pollMs: 1_000 });
export type GrokBrokerTurnEndReason = "final_reply" | "idle";

export function watchGrokBrokerTurnEnd(input: Readonly<{
  meter: Pick<GrokBrokerTurnMeter, "finalReply" | "busy" | "lastActivityAt">;
  activity: () => EngineBrokerMcpActivity | undefined;
  onFinalReply: () => void;
  onEnd: (reason: GrokBrokerTurnEndReason) => void;
  timing?: GrokBrokerTurnEndTiming;
  now?: () => number;
}>): Readonly<{ stop(): void }> {
  const timing = input.timing ?? GROK_BROKER_TURN_END, now = input.now ?? Date.now;
  let notified: number | undefined, done = false;
  const check = (): void => {
    if (done) return;
    const final = input.meter.finalReply();
    if (final !== undefined && notified !== final.index) {
      notified = final.index;
      try { input.onFinalReply(); } catch { /* closing streams is best effort; the grace below still ends the turn */ }
    }
    let activity: EngineBrokerMcpActivity | undefined;
    try { activity = input.activity(); } catch { activity = undefined; }
    if (input.meter.busy() || (activity?.inFlight ?? 0) > 0) return;
    const quietSince = Math.max(input.meter.lastActivityAt(), activity?.lastActivityAt ?? 0);
    const reason: GrokBrokerTurnEndReason | undefined = final !== undefined && now() - Math.max(final.at, quietSince) >= timing.finalGraceMs ? "final_reply"
      : now() - quietSince >= timing.idleMs ? "idle" : undefined;
    if (reason === undefined) return;
    stop();
    input.onEnd(reason);
  };
  const timer = setInterval(check, timing.pollMs); timer.unref?.();
  const stop = (): void => { done = true; clearInterval(timer); };
  return { stop };
}

/** The launcher-forked root of a worker identity's process tree: its pid and `/proc/<pid>/stat` start time, as the launcher itself reports them. */
export type GrokWorkerProcess = Readonly<{ pid: number; startTicks: string }>;

/**
 * Finds the worker the launcher started for `uid`, read-only from `/proc`.
 *
 * A turn the broker ends early never receives the launcher's result frame (a
 * cancelled client is not written to), yet a completed response must name the
 * worker it came from. One identity carries at most one turn at a time
 * (`native/AGENTS.md`), so a process owned by `uid` whose parent is *not* owned
 * by `uid` is a worker the launcher forked. A previous turn's worker can still
 * be alive beside it — a hung worker is exactly what this module exists for, and
 * its kill is the launcher's — so the newest such root (the latest start time)
 * is this turn's: turns of one identity are sequential.
 */
export async function findGrokWorkerProcess(uid: number, procRoot = "/proc"): Promise<GrokWorkerProcess | undefined> {
  let entries: string[];
  try { entries = await readdir(procRoot); } catch { return undefined; }
  const owned = new Map<number, { parent: number; startTicks: string }>();
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const status = await readFile(`${procRoot}/${entry}/status`, "utf8");
      const real = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
      if (real === undefined || Number(real) !== uid) continue;
      const stat = await readFile(`${procRoot}/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
      // After the command: state(0) ppid(1) … starttime is field 22 of stat, index 19 here.
      const parent = Number(fields[1]), startTicks = fields[19];
      if (fields[0] === "Z" || !Number.isSafeInteger(parent) || startTicks === undefined || !/^[1-9][0-9]*$/u.test(startTicks)) continue;
      owned.set(Number(entry), { parent, startTicks });
    } catch { /* a process exiting mid-scan is not part of the answer */ }
  }
  const roots = [...owned].filter(([, value]) => !owned.has(value.parent)).sort(([, left], [, right]) => BigInt(right.startTicks) > BigInt(left.startTicks) ? 1 : BigInt(right.startTicks) < BigInt(left.startTicks) ? -1 : 0);
  const newest = roots[0];
  return newest === undefined ? undefined : { pid: newest[0], startTicks: newest[1].startTicks };
}
