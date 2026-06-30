import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface JungianCounselRecord {
  archetype: string;
  engine: string;
  event: string;
  output: string;
  recallSelected: number;
  self: string;
  voice: string;
}

export interface JungianDialogueRecord {
  engine: string;
  event: string;
  innerUsed: string[];
  output: string;
  recallSelected: number;
  self: string;
  speaker: string;
}

export interface JungianTracePayload {
  counsel: JungianCounselRecord[];
  dialogue: JungianDialogueRecord[];
  run_id: string;
  schema: "daimon.jungian-play.trace/v1";
  title: string;
}

const excerpt = (text: string, maxChars = 600): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;

const innerUsedFrom = (text: string): string[] => {
  const match = text.match(/INNER_USED\s*[:=]\s*(.+)$/im);
  if (!match) {
    return [];
  }
  return [...new Set(match[1]
    .split(/[,; ]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => part.replace(/[^a-z0-9-]/g, "")))];
};

const speakFrom = (text: string): string => {
  const match = text.match(/SPEAK\s*[:=]\s*(.+)$/im);
  const value = match?.[1]?.trim() ?? text.trim();
  return value
    .replace(/^["'](.+)["']$/s, "$1")
    .replace(/^\*+\s*/, "")
    .replace(/\s*\*+$/, "")
    .trim();
};

const dialogueEventFromCounselEvent = (event: string): string =>
  event.replace(/-council-.+$/, "-speaks");

const counselOutput = (text: string): string =>
  excerpt(text, 1400).replace(/\n/g, "\n> ");

export class JungianTrace {
  readonly counsel: JungianCounselRecord[] = [];
  readonly dialogue: JungianDialogueRecord[] = [];

  constructor(readonly options: { runId: string; title: string }) {}

  addCounsel(record: JungianCounselRecord): void {
    this.counsel.push(record);
  }

  addDialogue(record: Omit<JungianDialogueRecord, "innerUsed"> & { innerUsed?: string[] }): void {
    this.dialogue.push({
      ...record,
      innerUsed: record.innerUsed ?? innerUsedFrom(record.output)
    });
  }

  payload(): JungianTracePayload {
    return {
      counsel: this.counsel,
      dialogue: this.dialogue,
      run_id: this.options.runId,
      schema: "daimon.jungian-play.trace/v1",
      title: this.options.title
    };
  }

  async write(runtimeRoot: string): Promise<void> {
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "jungian-trace.json"),
      `${JSON.stringify(this.payload(), null, 2)}\n`
    );
    await writeFile(path.join(runtimeRoot, "jungian-trace.md"), this.toMarkdown());
  }

  toMarkdown(): string {
    const matchedCounsel = new Set<JungianCounselRecord>();
    const counselByDialogue = new Map<string, JungianCounselRecord[]>();
    for (const record of this.counsel) {
      const key = dialogueEventFromCounselEvent(record.event);
      const records = counselByDialogue.get(key) ?? [];
      records.push(record);
      counselByDialogue.set(key, records);
    }

    const lines = [
      `# ${this.options.title}`,
      "",
      `- run: ${this.options.runId}`,
      `- counsel_turns: ${this.counsel.length}`,
      `- dialogue_turns: ${this.dialogue.length}`,
      "",
      "## Interleaved Conversation",
      ""
    ];

    for (const [index, turn] of this.dialogue.entries()) {
      const counsel = counselByDialogue.get(turn.event) ?? [];
      lines.push(
        `### ${index + 1}. ${turn.speaker} (${turn.self})`,
        "",
        `- engine: ${turn.engine}`,
        `- event: ${turn.event}`,
        `- recall_selected: ${turn.recallSelected}`,
        `- inner_used: ${turn.innerUsed.join(", ") || "(not declared)"}`,
        ""
      );

      if (counsel.length > 0) {
        lines.push("**Inner voices**", "");
        for (const record of counsel) {
          matchedCounsel.add(record);
          lines.push(
            `#### ${record.archetype} · ${record.voice}`,
            "",
            `- engine: ${record.engine}`,
            `- recall_selected: ${record.recallSelected}`,
            "",
            `> ${counselOutput(record.output)}`,
            ""
          );
        }
      } else {
        lines.push("**Inner voices**", "", "_No matching counsel records found for this line._", "");
      }

      lines.push(
        "**Public line**",
        "",
        `> ${speakFrom(turn.output)}`,
        ""
      );
    }

    const unmatched = this.counsel.filter((record) => !matchedCounsel.has(record));
    if (unmatched.length > 0) {
      lines.push("## Unmatched Inner Counsel", "");
      for (const record of unmatched) {
        lines.push(
          `### ${record.self} / ${record.archetype}`,
          "",
          `- voice: ${record.voice}`,
          `- engine: ${record.engine}`,
          `- event: ${record.event}`,
          `- recall_selected: ${record.recallSelected}`,
          "",
          `> ${counselOutput(record.output)}`,
          ""
        );
      }
    }
    return lines.join("\n");
  }
}

export const parseInnerUsed = innerUsedFrom;
export const parseSpeakLine = speakFrom;
