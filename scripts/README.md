# Daimon Scripts

Maintained scripts in this folder are TypeScript sources.

| Script | Caller | Purpose |
|---|---|---|
| `emitRuntimeContractManifest.ts` | `npm run build`, `npm run verify:contract-manifest`, `src/runtime/contractManifestArtifacts.test.ts` | Emits or checks packaged runtime contract manifest artifacts. |
| `src/runtime/native/verifyArtifacts.ts` | `npm run verify:native`, `npm run build` through `copyArtifact.ts` | Verifies checked-in native broker artifacts and provenance. |
| `verifyProductionClosure.ts` | `npm run verify:production-closure` | Checks built `dist/` for explicit-test runtime leakage. |
| `liveCodexSession.ts` | `npm run live:codex-session` | Manual live Codex tool-call probe. Spends provider quota. |
| `liveGrokBrokerSession.ts` | `npm run live:grok-broker` | Manual live Grok broker auth probe. Reads local Grok auth and spends provider quota. |

`emitRuntimeContractManifest.ts` and the live probes use `node --import tsx`
because they import the repository source graph. Builtin-only helpers can run
with native `node --experimental-strip-types`.
