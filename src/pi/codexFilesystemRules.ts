import path from "node:path";

type Permission = "read" | "write" | "deny";

/** Codex mounts deny roots read-only; a second deny below one cannot create parents. */
export function codexFilesystemRules(
  protectedPaths: readonly string[], readablePaths: readonly string[], workspacePath?: string
): Record<string, "read" | "deny"> {
  const explicit = new Map<string, "read" | "deny">();
  // Agent roots are canonical, but shared acceptance paths may contain `..`
  // or trailing separators. Compare the same absolute locations Codex uses.
  for (const readablePath of readablePaths) explicit.set(path.resolve(readablePath), "read");
  for (const protectedPath of protectedPaths) explicit.set(path.resolve(protectedPath), "deny");
  const effective = new Map<string, Permission>([
    ...(workspacePath === undefined ? [] : [[path.resolve(workspacePath), "write"] as const]),
    ...explicit
  ]);
  return Object.fromEntries([...explicit].filter(([target, permission]) => {
    if (permission !== "deny") return true;
    let ancestor = path.dirname(target);
    while (ancestor !== target) {
      const inherited = effective.get(ancestor);
      if (inherited !== undefined) return inherited !== "deny";
      target = ancestor;
      ancestor = path.dirname(target);
    }
    return true;
  }));
}
