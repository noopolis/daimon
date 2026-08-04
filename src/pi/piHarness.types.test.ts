import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import type { PiSessionLike } from "./piAgentHandle.js";
import type { PiRawTrainingCaptureOptions } from "./rawTrainingCapture.js";

const cliSession: PiSessionLike = {
  subscribe: () => () => undefined,
  prompt: async () => undefined,
  dispose: () => undefined
};
const sessionFactory: PiSessionFactory = async () => ({ session: cliSession });
const captureOptions = {
  enabled: true,
  retention: { maxTurns: 1 }
} satisfies PiRawTrainingCaptureOptions;

// @ts-expect-error A supplied CLI session cannot be combined with Pi-native raw capture.
new PiHarnessAdapter({
  authPath: "/tmp/auth.json",
  sessionFactory,
  rawTrainingCapture: captureOptions
});

new PiHarnessAdapter({
  authPath: "/tmp/auth.json",
  rawTrainingCapture: captureOptions
});
