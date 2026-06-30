import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type EngineKind = "agy" | "codex" | "grok";

export interface EngineRunResult {
  durationMs: number;
  outputChars: number;
  promptChars: number;
  text: string;
}

interface EnginePaths {
  runtimeHomePath: string;
  workspacePath: string;
}

const maxCapturedOutputBytes = 1024 * 256;
const outputOptions = {
  maxBuffer: 1024 * 1024 * 8,
  timeout: 180_000
};

const stripAnsi = (value: string): string =>
  value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "").trim();

const pushCapped = (chunks: Buffer[], chunk: Buffer, state: { bytes: number }): void => {
  if (state.bytes >= maxCapturedOutputBytes) {
    return;
  }
  const remaining = maxCapturedOutputBytes - state.bytes;
  const next = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(next);
  state.bytes += next.length;
};

const readBounded = async (filePath: string): Promise<string> => {
  const stats = await stat(filePath);
  if (stats.size <= maxCapturedOutputBytes) {
    return readFile(filePath, "utf8");
  }
  const content = await readFile(filePath);
  const head = content.subarray(0, maxCapturedOutputBytes).toString("utf8");
  return `${head}\n[truncated ${stats.size - maxCapturedOutputBytes} bytes]`;
};

const spawnWithInput = (
  command: string,
  args: string[],
  input: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${outputOptions.timeout}ms`));
    }, outputOptions.timeout);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    child.stdout.on("data", (chunk: Buffer) => pushCapped(stdout, chunk, stdoutState));
    child.stderr.on("data", (chunk: Buffer) => pushCapped(stderr, chunk, stderrState));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(`${command} exited ${code ?? signal}: ${output.stderr || output.stdout}`));
    });
    child.stdin.end(input);
  });

const spawnToFiles = (
  command: string,
  args: string[],
  input: { cwd: string; stderrPath: string; stdoutPath: string }
): Promise<void> =>
  new Promise((resolve, reject) => {
    const stdoutFd = openSync(input.stdoutPath, "w");
    const stderrFd = openSync(input.stderrPath, "w");
    const closeFiles = (): void => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    };
    const child = spawn(command, args, { cwd: input.cwd, stdio: ["ignore", stdoutFd, stderrFd] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      closeFiles();
      reject(new Error(`${command} timed out after ${outputOptions.timeout}ms; stderr=${input.stderrPath}`));
    }, outputOptions.timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      closeFiles();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      closeFiles();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited ${code ?? signal}; stderr=${input.stderrPath}; stdout=${input.stdoutPath}`));
    });
  });

const runCodex = async (prompt: string, paths: EnginePaths): Promise<string> => {
  const outputPath = `${paths.runtimeHomePath}/codex-${Date.now()}.txt`;
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--color",
    "never",
    "-C",
    paths.workspacePath,
    "--output-last-message",
    outputPath
  ];
  args.push("-m", process.env.DAIMON_CODEX_MODEL ?? "gpt-5.4-mini");
  args.push("-");
  const { stdout, stderr } = await spawnWithInput("codex", args, prompt, paths.workspacePath);
  try {
    return stripAnsi(await readFile(outputPath, "utf8"));
  } catch {
    return stripAnsi([stdout, stderr].filter(Boolean).join("\n"));
  }
};

const runGrok = async (prompt: string, paths: EnginePaths): Promise<string> => {
  const { stdout } = await execFileAsync("grok", [
    "--single",
    prompt,
    "--max-turns",
    process.env.DAIMON_GROK_MAX_TURNS ?? "2",
    "--no-memory",
    "--disable-web-search",
    "--cwd",
    paths.workspacePath,
    "--output-format",
    "plain"
  ], { ...outputOptions, cwd: paths.workspacePath });
  return stripAnsi(stdout);
};

const runAgy = async (prompt: string, paths: EnginePaths): Promise<string> => {
  const outputPath = path.resolve(paths.runtimeHomePath, `agy-output-${Date.now()}.txt`);
  const errorPath = path.resolve(paths.runtimeHomePath, `agy-error-${Date.now()}.txt`);
  await spawnToFiles("agy", [
    "--print",
    prompt,
    "--print-timeout",
    process.env.DAIMON_AGY_TIMEOUT ?? "300s",
    "--model",
    process.env.DAIMON_AGY_MODEL ?? "Gemini 3.5 Flash (Low)",
    "--new-project",
    "--add-dir",
    paths.workspacePath
  ], {
    cwd: paths.workspacePath,
    stderrPath: errorPath,
    stdoutPath: outputPath
  });
  const text = stripAnsi(await readBounded(outputPath));
  await Promise.all([unlink(outputPath), unlink(errorPath)].map((promise) => promise.catch(() => undefined)));
  return text;
};

export const runEngine = async (
  engine: EngineKind,
  prompt: string,
  paths: EnginePaths
): Promise<string> => {
  const result = await runEngineDetailed(engine, prompt, paths);
  return result.text;
};

export const runEngineDetailed = async (
  engine: EngineKind,
  prompt: string,
  paths: EnginePaths
): Promise<EngineRunResult> => {
  const startedAt = Date.now();
  let text: string;
  if (engine === "codex") {
    text = await runCodex(prompt, paths);
  } else if (engine === "grok") {
    text = await runGrok(prompt, paths);
  } else {
    text = await runAgy(prompt, paths);
  }
  return {
    durationMs: Date.now() - startedAt,
    outputChars: text.length,
    promptChars: prompt.length,
    text
  };
};
