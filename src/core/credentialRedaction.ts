const DEFAULT_MAX_BYTES = 16_384;

const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  while (result.endsWith("\uFFFD")) result = result.slice(0, -1);
  return result;
};

/** Redacts provider credentials before text crosses any reply or diagnostic boundary. */
export function redactCredentialText(
  value: unknown,
  exactSecrets: readonly string[] = [],
  maxBytes: number = DEFAULT_MAX_BYTES
): string {
  let result = String(value);
  for (const secret of [...new Set(exactSecrets.filter((entry) => entry.length > 0))]
    .sort((left, right) => right.length - left.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  result = result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]")
    .replace(/\bmagt_v1_[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .replace(/\b(?:sk|sk-proj|xai)-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(
      /("(?:api[_-]?key|authorization|client[_-]?secret|credential|key|password|secret|(?:access|refresh|id)[_-]?token|token)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/giu,
      "$1[REDACTED]$3"
    )
    .replace(
      /\b(api[_-]?key|authorization|client[_-]?secret|credential|password|secret|(?:access|refresh|id)[_-]?token|token)\b(\s*[:=]\s*)(["']?)[^\s"',&]{8,}\3/giu,
      "$1$2[REDACTED]"
    );
  return truncateUtf8(result, maxBytes);
}

export function redactCredentialError(
  error: unknown,
  exactSecrets: readonly string[] = [],
  maxBytes: number = DEFAULT_MAX_BYTES
): Error {
  return new Error(redactCredentialText(error instanceof Error ? error.message : error, exactSecrets, maxBytes));
}
