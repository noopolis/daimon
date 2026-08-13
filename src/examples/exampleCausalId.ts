const LOCAL_CAUSAL_ID = /^[a-z0-9][a-z0-9._-]{0,255}$/u;

/** Namespaces caller-authored example wakes for the shared causal contract. */
export const exampleCausalId = (localId: string): string => {
  if (!LOCAL_CAUSAL_ID.test(localId)) {
    throw new Error("Daimon example causal id must be a bounded local id");
  }
  return `daimon:${localId}`;
};
