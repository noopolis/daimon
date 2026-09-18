import { createHash } from "node:crypto";
import path from "node:path";

import { assertGrokWorkerDenyPathShape } from "./grokWorkerDenyPlacement.js";

export const GROK_WORKER_SANDBOX_PROFILE = "daimon-strict" as const;
export const GROK_WORKER_SANDBOX_EVENTS_RELATIVE_PATH = "sessions/sandbox-events.jsonl" as const;

/**
 * The only source of `daimon-strict` sandbox profile bytes.
 *
 * Grok 1.0.34 runs every Landlock profile inside bubblewrap, and there a
 * non-empty `deny` list works: each entry is bind-masked for both the shell
 * tool and in-process `read_file` (P0: `/run/paideia` denied, controls intact).
 * The strict base still reads all of `/run`, `/var`, `/tmp` and `/etc`, so the
 * deny list — not Landlock's allowlist — is what keeps evaluator and host-bind
 * paths away from the worker. Which paths to deny is a registration input
 * supplied by the deployment; Daimon only renders, pins, and attests them.
 *
 * Entries are sorted and deduplicated so equal sets render equal bytes (and the
 * same `profileSha256`). A path that is not absolute and canonical, or that
 * carries a character TOML or Grok would reinterpret, is refused — and so is
 * one that equals or contains a base-profile grant, the first half of the
 * deny-placement policy (`grokWorkerDenyPlacement.ts`). The other half —
 * the entry exists and every ancestor is searchable by the worker uid — needs
 * a filesystem, so it is asserted by whoever provisions the paths and, on the
 * direct path, before every turn.
 */
export function renderGrokWorkerSandboxProfile(denyPaths: readonly string[] = []): string {
  const denied = [...new Set(denyPaths)].sort();
  for (const entry of denied) {
    if (!path.posix.isAbsolute(entry) || path.posix.normalize(entry) !== entry || entry === "/" || entry.endsWith("/") || /["\\\u0000-\u001f\u007f*?[\]]/u.test(entry)) {
      throw new TypeError("invalid Grok worker sandbox deny path");
    }
    assertGrokWorkerDenyPathShape(entry);
  }
  return [
    `[profiles.${GROK_WORKER_SANDBOX_PROFILE}]`,
    'extends = "strict"',
    "restrict_network = true",
    `deny = [${denied.map((entry) => JSON.stringify(entry)).join(", ")}]`,
    ""
  ].join("\n");
}

export const grokWorkerSandboxProfileSha256 = (denyPaths: readonly string[] = []): string =>
  createHash("sha256").update(renderGrokWorkerSandboxProfile(denyPaths)).digest("hex");

/** `$GROK_HOME` is the profile's directory; 1.0.34 logs sandbox events under `sessions/`. */
export const grokWorkerEventsPathFor = (profilePath: string): string =>
  path.posix.join(path.posix.dirname(profilePath), GROK_WORKER_SANDBOX_EVENTS_RELATIVE_PATH);
