import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryRecallAudit } from "@noopolis/mneme";

export interface WakeBenchRow {
  agent: string;
  engine: string;
  event: string;
  totalMs: number;
  memoryPrepareMs: number;
  engineMs: number;
  memoryRecordMs: number;
  promptChars: number;
  outputChars: number;
  recallCandidates: number;
  recallSelected: number;
}

export interface TurnObservation extends WakeBenchRow {
  mentions: string[];
  outputText: string;
  recall: Array<{
    decision: string;
    eventId: string;
    representation: string;
    scope: string;
  }>;
  signalsMentioned: string[];
  signalsInWakeText: string[];
}

export interface SignalObservation {
  agent: string;
  engine: string;
  signal: string;
}

export interface ConsultationObservation {
  event: string;
  from: string;
  observed: boolean;
  outputText: string;
  to: string;
}

export interface BehaviorAssertion {
  detail: string;
  event: string;
  kind: "consultation" | "no-leak" | "recall";
  passed: boolean;
}

export interface OrgObserverOptions {
  orgId: string;
  runId: string;
}

const maxExcerptChars = 280;

const excerpt = (text: string): string =>
  text.length <= maxExcerptChars ? text : `${text.slice(0, maxExcerptChars).trim()}...`;

export const mentionsFrom = (text: string): string[] =>
  [...new Set([...text.matchAll(/@([a-z0-9-]+)/gi)].map((match) => match[1].toLowerCase()))];

export class OrgObserver {
  readonly assertions: BehaviorAssertion[] = [];
  readonly consultations: ConsultationObservation[] = [];
  readonly signals: SignalObservation[] = [];
  readonly turns: TurnObservation[] = [];

  constructor(readonly options: OrgObserverOptions) {}

  knownSignals(): string[] {
    return this.signals.map((signal) => signal.signal);
  }

  recordAssertion(assertion: BehaviorAssertion): void {
    this.assertions.push(assertion);
  }

  recordSignal(input: SignalObservation): void {
    this.signals.push(input);
  }

  recordTurn(input: {
    agent: string;
    engine: string;
    engineMs: number;
    event: string;
    eventText: string;
    memoryPrepareMs: number;
    memoryRecordMs: number;
    outputChars: number;
    outputText: string;
    promptChars: number;
    recall: MemoryRecallAudit;
    totalMs: number;
  }): void {
    this.turns.push({
      agent: input.agent,
      engine: input.engine,
      event: input.event,
      totalMs: input.totalMs,
      memoryPrepareMs: input.memoryPrepareMs,
      engineMs: input.engineMs,
      memoryRecordMs: input.memoryRecordMs,
      promptChars: input.promptChars,
      outputChars: input.outputChars,
      recallCandidates: input.recall.totalCandidates,
      recallSelected: input.recall.selectedEventIds.length,
      mentions: mentionsFrom(input.outputText),
      outputText: input.outputText,
      recall: (input.recall.selected ?? []).map((selected) => ({
        decision: selected.decision,
        eventId: selected.eventId,
        representation: excerpt(selected.representation),
        scope: selected.scope
      })),
      signalsMentioned: this.knownSignals().filter((signal) => input.outputText.includes(signal)),
      signalsInWakeText: this.knownSignals().filter((signal) => input.eventText.includes(signal))
    });
  }

  recordConsultation(input: {
    event: string;
    from: string;
    outputText: string;
    to: string;
  }): ConsultationObservation {
    const observed = mentionsFrom(input.outputText).includes(input.to);
    const edge = { ...input, observed };
    this.consultations.push(edge);
    this.recordAssertion({
      detail: `${input.from} should mention @${input.to}`,
      event: input.event,
      kind: "consultation",
      passed: observed
    });
    return edge;
  }

  benchRows(): WakeBenchRow[] {
    return this.turns.map((turn) => ({
      agent: turn.agent,
      engine: turn.engine,
      event: turn.event,
      totalMs: turn.totalMs,
      memoryPrepareMs: turn.memoryPrepareMs,
      engineMs: turn.engineMs,
      memoryRecordMs: turn.memoryRecordMs,
      promptChars: turn.promptChars,
      outputChars: turn.outputChars,
      recallCandidates: turn.recallCandidates,
      recallSelected: turn.recallSelected
    }));
  }

  summary(): Record<string, { count: number; engineMs: number; promptChars: number; totalMs: number }> {
    return this.turns.reduce<Record<string, { count: number; engineMs: number; promptChars: number; totalMs: number }>>(
      (memo, turn) => {
        const value = memo[turn.engine] ?? { count: 0, engineMs: 0, promptChars: 0, totalMs: 0 };
        value.count += 1;
        value.engineMs += turn.engineMs;
        value.promptChars += turn.promptChars;
        value.totalMs += turn.totalMs;
        memo[turn.engine] = value;
        return memo;
      },
      {}
    );
  }

  behaviorSummary(): {
    assertionPassRate: number;
    consultationObservedRate: number;
    signalsGenerated: number;
    totalRecallSelected: number;
    totalTurns: number;
  } {
    const passedAssertions = this.assertions.filter((assertion) => assertion.passed).length;
    const observedConsultations = this.consultations.filter((edge) => edge.observed).length;
    const rate = (part: number, total: number): number => total === 0 ? 1 : part / total;
    return {
      assertionPassRate: rate(passedAssertions, this.assertions.length),
      consultationObservedRate: rate(observedConsultations, this.consultations.length),
      signalsGenerated: this.signals.length,
      totalRecallSelected: this.turns.reduce((total, turn) => total + turn.recallSelected, 0),
      totalTurns: this.turns.length
    };
  }

  tracePayload(): object {
    return {
      assertions: this.assertions,
      behavior: this.behaviorSummary(),
      consultations: this.consultations,
      org_id: this.options.orgId,
      run_id: this.options.runId,
      schema: "daimon.org.telemetry/v1",
      signals: this.signals,
      summary: this.summary(),
      turns: this.turns
    };
  }

  async write(runtimeRoot: string): Promise<void> {
    const telemetryDir = path.join(runtimeRoot, "telemetry");
    await mkdir(telemetryDir, { recursive: true });
    const summaryRecord = {
      assertions: this.assertions,
      behavior: this.behaviorSummary(),
      kind: "org.turn_summary",
      org_id: this.options.orgId,
      run_id: this.options.runId,
      schema: "daimon.org.telemetry/v1",
      summary: this.summary()
    };
    const turnRecords = this.turns.map((turn) => ({
      kind: "org.turn",
      org_id: this.options.orgId,
      run_id: this.options.runId,
      schema: "daimon.org.telemetry/v1",
      turn
    }));
    const ndjson = [...turnRecords, summaryRecord]
      .map((record) => JSON.stringify(record))
      .join("\n");
    await writeFile(path.join(runtimeRoot, "trace.json"), `${JSON.stringify(this.tracePayload(), null, 2)}\n`);
    await writeFile(path.join(runtimeRoot, "trace.md"), this.toMarkdown());
    await writeFile(
      path.join(runtimeRoot, "bench.json"),
      `${JSON.stringify({ rows: this.benchRows(), summary: this.summary() }, null, 2)}\n`
    );
    await writeFile(path.join(telemetryDir, "events.ndjson"), `${ndjson}\n`);
    await writeFile(path.join(telemetryDir, "summary.json"), `${JSON.stringify(summaryRecord, null, 2)}\n`);
  }

  toMarkdown(): string {
    const lines = [
      "# Mixed Engine Org Trace",
      "",
      `- org: ${this.options.orgId}`,
      `- run: ${this.options.runId}`,
      "",
      "## Behavior",
      "",
      `- assertion_pass_rate: ${this.behaviorSummary().assertionPassRate}`,
      `- consultation_observed_rate: ${this.behaviorSummary().consultationObservedRate}`,
      `- total_recall_selected: ${this.behaviorSummary().totalRecallSelected}`,
      "",
      "## Signals",
      "",
      "| Agent | Engine | Signal |",
      "| --- | --- | --- |",
      ...this.signals.map((signal) => `| ${signal.agent} | ${signal.engine} | ${signal.signal} |`),
      "",
      "## Consultations",
      "",
      "| Event | Edge | Observed |",
      "| --- | --- | --- |",
      ...this.consultations.map((edge) => `| ${edge.event} | ${edge.from} -> ${edge.to} | ${edge.observed ? "yes" : "no"} |`),
      "",
      "## Turns",
      ""
    ];

    for (const turn of this.turns) {
      lines.push(
        `### ${turn.event}`,
        "",
        `- agent: ${turn.agent}`,
        `- engine: ${turn.engine}`,
        `- total_ms: ${turn.totalMs}`,
        `- engine_ms: ${turn.engineMs}`,
        `- memory_prepare_ms: ${turn.memoryPrepareMs}`,
        `- memory_record_ms: ${turn.memoryRecordMs}`,
        `- prompt_chars: ${turn.promptChars}`,
        `- recall: ${turn.recallSelected}/${turn.recallCandidates}`,
        `- mentions: ${turn.mentions.join(", ") || "(none)"}`,
        `- signals_mentioned: ${turn.signalsMentioned.join(", ") || "(none)"}`,
        "",
        "Output:",
        "",
        `> ${turn.outputText}`,
        ""
      );
      if (turn.recall.length > 0) {
        lines.push("Recalled memory:", "");
        for (const recall of turn.recall) {
          lines.push(`- ${recall.eventId} [${recall.decision}] ${recall.representation}`);
        }
        lines.push("");
      }
    }

    lines.push(
      "## Assertions",
      "",
      "| Event | Kind | Passed | Detail |",
      "| --- | --- | --- | --- |",
      ...this.assertions.map((assertion) => `| ${assertion.event} | ${assertion.kind} | ${assertion.passed ? "yes" : "no"} | ${assertion.detail} |`),
      ""
    );
    return lines.join("\n");
  }
}
