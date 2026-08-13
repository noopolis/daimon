import { PiAgentHandle, type PiSessionLike, type PiSessionCreator } from "./piAgentHandle.js";

const session: PiSessionLike = {
  subscribe: () => () => undefined,
  prompt: async () => undefined,
  dispose: () => undefined
};
const createSession: PiSessionCreator = async () => session;

process.env.NOOPOLIS_RUN_ID = "run-test-agent-handle-types";

// @ts-expect-error Raw Pi capture requires a concrete Pi AgentSession, not a CLI session.
const invalidCaptureHandle: PiAgentHandle = new PiAgentHandle(
  "agent",
  session,
  createSession,
  "/tmp/runtime",
  { authMethod: "none", model: "test", provider: "test" },
  undefined,
  undefined,
  {},
  undefined,
  {},
  { enabled: true, retention: { maxTurns: 1 } }
);

void invalidCaptureHandle;

delete process.env.NOOPOLIS_RUN_ID;
