import assert from "node:assert/strict";
import test from "node:test";

import { cliChildEnvironment, DAIMON_WAKE_ID_ENV } from "./cliEnvironment.js";

test("passes only an explicit local Linux Secret Service bus to AGY", () => {
  const previous = process.env.DBUS_SESSION_BUS_ADDRESS;
  try {
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/ambient/bus";
    const exact = "unix:path=/daimon/private/bus";
    assert.equal(cliChildEnvironment([], "/runtime", { engine: "agy", dbusSessionBusAddress: exact }).DBUS_SESSION_BUS_ADDRESS, exact);
    assert.equal(cliChildEnvironment([], "/runtime", { engine: "agy" }).DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(cliChildEnvironment([], "/runtime", { engine: "codex", dbusSessionBusAddress: exact }).DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(cliChildEnvironment([], "/runtime", { engine: "agy", dbusSessionBusAddress: "tcp:host=credential-canary" }).DBUS_SESSION_BUS_ADDRESS, undefined);
  } finally {
    if (previous === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = previous;
  }
});

test("adds only the explicitly bound current wake id", () => {
  const absent = cliChildEnvironment([], "/runtime", { engine: "codex" });
  const bound = cliChildEnvironment([], "/runtime", { engine: "codex", wakeId: "moltnet:msg_1" });
  assert.equal(absent[DAIMON_WAKE_ID_ENV], undefined);
  assert.equal(bound[DAIMON_WAKE_ID_ENV], "moltnet:msg_1");
});
