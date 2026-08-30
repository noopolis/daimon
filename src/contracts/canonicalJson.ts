const invalid = (detail: string): never => {
  throw new TypeError(`value is not canonical JSON data: ${detail}`);
};

const assertUnicodeScalarString = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("unpaired surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid("unpaired surrogate");
    }
  }
};

/** Deterministically serializes JSON data and rejects non-JSON or ambiguous values. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalid("non-finite or negative-zero number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalid("sparse array");
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") return invalid(typeof value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid("non-plain object");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) invalid("symbol key");
  const keys = (ownKeys as string[]).sort();
  return `{${keys.map((key) => {
    assertUnicodeScalarString(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return invalid("non-data property");
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`;
  }).join(",")}}`;
};
