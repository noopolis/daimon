export type PortableCredentialKind = "codex" | "grok";

/** Validates only the bounded provider-native shape needed for refresh. */
export function hasRefreshablePortableCredential(
  engine: PortableCredentialKind,
  bytes: Uint8Array
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  } catch {
    return false;
  }
  const pair = engine === "grok" ? grokTokenPair(value) : tokenPair(value);
  if (pair.access === undefined || pair.refresh === undefined) return false;
  if (engine !== "grok") return true;
  const candidate = firstString(grokTokenEntry(value), ["expires_at"]);
  return candidate !== undefined && Number.isFinite(Date.parse(candidate));
}

/** Returns only the provider-native bearer values for exact in-process redaction. */
export function portableCredentialSecretValues(
  engine: PortableCredentialKind,
  bytes: Uint8Array
): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
  } catch {
    return [];
  }
  const pair = engine === "grok" ? grokTokenPair(value) : tokenPair(value);
  return [...new Set([pair.access, pair.refresh].filter((entry): entry is string => entry !== undefined))];
}

function tokenPair(value: unknown): { access?: string; refresh?: string } {
  const source = object(value);
  const nested = object(source?.tokens) ?? source;
  return {
    access: firstNonBlankString(nested, ["access_token", "accessToken", "token"]),
    refresh: firstNonBlankString(nested, ["refresh_token", "refreshToken"])
  };
}

function grokTokenEntry(value: unknown): Record<string, unknown> | undefined {
  const source = object(value);
  if (source === undefined) return undefined;
  for (const [key, entry] of Object.entries(source)) {
    if (/^https:\/\/auth\.x\.ai::/u.test(key)) return object(entry);
  }
  return undefined;
}

function grokTokenPair(value: unknown): { access?: string; refresh?: string } {
  const entry = grokTokenEntry(value);
  return {
    access: firstNonBlankString(entry, ["key"]),
    refresh: firstNonBlankString(entry, ["refresh_token"])
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(
  value: Record<string, unknown> | undefined,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    if (typeof value?.[name] === "string" && value[name]!.length > 0) return value[name] as string;
  }
  return undefined;
}

function firstNonBlankString(
  value: Record<string, unknown> | undefined,
  names: readonly string[]
): string | undefined {
  const candidate = firstString(value, names);
  return candidate !== undefined && candidate.trim().length > 0 ? candidate : undefined;
}
