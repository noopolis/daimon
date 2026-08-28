const AUTH_REJECTION = /(?:Authentication rejected by server|Auth recovery exhausted|RefreshTokenRejected|Not signed in|Not logged in|NoRefresh|NoRecovery|PinnedTeamMismatch|ServerRejected)/iu;

/** Classifies a bounded streaming diagnostic without retaining provider output. */
export function classifyGrokAuthenticationDiagnostic(
  diagnostic: string
): GrokSubscriptionAuthenticationRejectedError | undefined {
  return AUTH_REJECTION.test(diagnostic)
    ? new GrokSubscriptionAuthenticationRejectedError()
    : undefined;
}

/** Fixed-message marker used to stale-fence a rotating Grok credential realm. */
export class GrokSubscriptionAuthenticationRejectedError extends Error {
  public constructor(cleanupFailure?: Error) {
    super(
      "Grok subscription authentication was rejected; operator re-enrollment is required",
      cleanupFailure === undefined ? undefined : { cause: cleanupFailure }
    );
    this.name = "GrokSubscriptionAuthenticationRejectedError";
  }
}

export function asGrokAuthenticationRejected(error: unknown): GrokSubscriptionAuthenticationRejectedError | undefined {
  if (error instanceof GrokSubscriptionAuthenticationRejectedError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return classifyGrokAuthenticationDiagnostic(message);
}
