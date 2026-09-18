import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

type Grant = Readonly<{ agentId: string; turnId: string; digest: Buffer; expiresAt: number; maxRequests: number }>;

export class EngineBrokerCapabilities {
  private readonly grants = new Map<string, Grant & { requests: number }>();
  issue(agentId: string, turnId: string, ttlMs = 15 * 60_000, maxRequests = 64): string {
    if (ttlMs < 1 || maxRequests < 1) throw new TypeError("invalid broker capability policy");
    const token = randomBytes(32).toString("base64url");
    this.grants.set(turnId, { agentId, turnId, digest: hash(token), expiresAt: Date.now() + ttlMs, maxRequests, requests: 0 });
    return token;
  }
  authorize(agentId: string, turnId: string, token: string): boolean {
    const grant = this.grants.get(turnId); const candidate = hash(token);
    if (grant === undefined || grant.agentId !== agentId || grant.expiresAt <= Date.now() || grant.requests >= grant.maxRequests || !timingSafeEqual(grant.digest, candidate)) return false;
    grant.requests += 1; return true;
  }
  authorizeToken(token: string): Readonly<{ agentId: string; turnId: string }> | undefined {
    const candidate = hash(token);
    for (const grant of this.grants.values()) {
      if (grant.expiresAt <= Date.now() || grant.requests >= grant.maxRequests || !timingSafeEqual(grant.digest, candidate)) continue;
      grant.requests += 1; return { agentId: grant.agentId, turnId: grant.turnId };
    }
    return undefined;
  }
  /**
   * Which grant a token names and why it would be refused, *without* spending
   * it.
   *
   * The facade needs this on its refusal path alone. A 403 it cannot attribute
   * to a turn is a 403 that seals as nothing at all, and a turn whose every
   * request was refused then reads exactly like a healthy one — the silence
   * `engineBrokerMcpCallLog.ts` exists to end. A token no grant matches names
   * no turn and stays unattributed; nothing here returns the token, the grant
   * or the agent's capability, only the turn id and a closed reason.
   */
  classifyToken(token: string): Readonly<{ turnId: string; state: "live" | "expired" | "exhausted" }> | undefined {
    const candidate = hash(token);
    for (const grant of this.grants.values()) {
      if (!timingSafeEqual(grant.digest, candidate)) continue;
      // Budget before expiry: the TTL outlives every declared turn limit, so an
      // exhausted grant is the reachable refusal and the actionable answer.
      if (grant.requests >= grant.maxRequests) return { turnId: grant.turnId, state: "exhausted" };
      return { turnId: grant.turnId, state: grant.expiresAt <= Date.now() ? "expired" : "live" };
    }
    return undefined;
  }
  inspectToken(token:string):Readonly<{agentId:string;turnId:string}>|undefined{const candidate=hash(token);for(const grant of this.grants.values()){if(grant.expiresAt>Date.now()&&grant.requests<grant.maxRequests&&timingSafeEqual(grant.digest,candidate))return{agentId:grant.agentId,turnId:grant.turnId};}return undefined;}
  revoke(turnId: string): void { const grant = this.grants.get(turnId); grant?.digest.fill(0); this.grants.delete(turnId); }
}
const hash = (value: string): Buffer => createHash("sha256").update(value).digest();
