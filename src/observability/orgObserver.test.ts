import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OrgObserver } from "./orgObserver.js";

describe("OrgObserver", () => {
  it("records consultations, recall provenance, leaks, and markdown summaries", () => {
    const observer = new OrgObserver({
      orgId: "mixed-engine-org",
      runId: "run-test"
    });
    observer.recordSignal({
      agent: "navigator",
      engine: "codex",
      signal: "COD-ALPHA"
    });
    observer.recordTurn({
      agent: "navigator",
      engine: "codex",
      engineMs: 10,
      event: "room-navigator-1",
      eventText: "Recall your signal",
      memoryPrepareMs: 1,
      memoryRecordMs: 1,
      outputChars: 42,
      outputText: "@cartographer navigator=COD-ALPHA",
      promptChars: 100,
      recall: {
        decisions: [],
        redactionCount: 0,
        selected: [{
          decision: "allow_raw",
          eventId: "evt_seed",
          representation: "Wake request seed: COD-ALPHA",
          scope: "agent:navigator/scope:global"
        }],
        selectedEventIds: ["evt_seed"],
        tokenBudgetUsed: 8,
        totalCandidates: 1
      },
      totalMs: 12
    });
    const edge = observer.recordConsultation({
      event: "room-navigator-1",
      from: "navigator",
      outputText: "@cartographer navigator=COD-ALPHA",
      to: "cartographer"
    });

    assert.equal(edge.observed, true);
    assert.equal(observer.benchRows()[0].recallSelected, 1);
    assert.deepEqual(observer.turns[0].signalsMentioned, ["COD-ALPHA"]);
    assert.deepEqual(observer.turns[0].mentions, ["cartographer"]);
    assert.match(observer.toMarkdown(), /navigator -> cartographer/);
    assert.match(observer.toMarkdown(), /evt_seed/);
    assert.deepEqual(observer.summary().codex, {
      count: 1,
      engineMs: 10,
      promptChars: 100,
      totalMs: 12
    });
  });
});
