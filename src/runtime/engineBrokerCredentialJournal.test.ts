import assert from "node:assert/strict";
import test from "node:test";
import { parseBrokerCredentialJournal, recoverBrokerCredentialJournal } from "./engineBrokerCredentialJournal.js";
const a = "a".repeat(64); const b = "b".repeat(64);
test("credential crash recovery distinguishes pre and post replacement", () => {
  const refreshing = parseBrokerCredentialJournal({ version: "noopolis.daimon.broker-credential-journal.v1", state: "refreshing", generation: 3, sourceDigest: a });
  assert.equal(recoverBrokerCredentialJournal(refreshing, a), "ready"); assert.equal(recoverBrokerCredentialJournal(refreshing, b), "stale");
  const promoted = parseBrokerCredentialJournal({ ...refreshing, state: "promoted", promotedDigest: b });
  assert.equal(recoverBrokerCredentialJournal(promoted, b), "ready"); assert.equal(recoverBrokerCredentialJournal(promoted, a), "stale");
});
