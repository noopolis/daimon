import { AGY_MAX_TOOL_TURNS, createCliSessionFactory, type CliEngineKind, type CliEngineOptions } from "./cliSession.js";

export interface EngineRunResult {
  readonly durationMs: number;
  readonly outputChars: number;
  readonly promptChars: number;
  readonly text: string;
}

export const runEngineDetailed = async (
  engine: CliEngineKind,
  prompt: string,
  paths: { readonly workspacePath: string; readonly runtimeHomePath?: string }
): Promise<EngineRunResult> => {
  const startedAt = Date.now();
  const options: CliEngineOptions = engine === "agy"
    ? { engine, maxToolTurns: AGY_MAX_TOOL_TURNS, timeoutMs: 180_000 }
    : { engine };
  const { session } = await createCliSessionFactory(options)({
    cwd: paths.workspacePath,
    runtimeHomePath: paths.runtimeHomePath
  });
  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end") return;
    if (!("content" in event.message)) return;
    text = Array.isArray(event.message.content)
      ? event.message.content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("")
      : event.message.content;
  });
  await session.prompt(prompt);
  unsubscribe();
  session.dispose();
  await session.disposeAsync?.();
  return { durationMs: Date.now() - startedAt, outputChars: text.length, promptChars: prompt.length, text };
};

export const runEngine = async (
  engine: CliEngineKind,
  prompt: string,
  paths: { readonly workspacePath: string; readonly runtimeHomePath?: string }
): Promise<string> => (await runEngineDetailed(engine, prompt, paths)).text;
