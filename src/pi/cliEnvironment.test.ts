import assert from "node:assert/strict";
import test from "node:test";

import { cliChildEnvironment } from "./cliEnvironment.js";

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
