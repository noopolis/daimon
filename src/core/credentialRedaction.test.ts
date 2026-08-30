import assert from "node:assert/strict";
import test from "node:test";

import { redactCredentialText } from "./credentialRedaction.js";

test("redacts Grok key, refresh/access values, exact rotations, and bounds UTF-8", () => {
  const oldSecret = "raw-old-access-secret-123456789";
  const rotatedSecret = "raw-rotated-refresh-secret-987654321";
  const result = redactCredentialText(JSON.stringify({
    key: oldSecret,
    refresh_token: rotatedSecret,
    note: `also ${oldSecret}`
  }), [oldSecret, rotatedSecret], 256);
  assert.doesNotMatch(result, /raw-old|raw-rotated/u);
  assert.match(result, /\[REDACTED\]/u);
  assert.ok(Buffer.byteLength(redactCredentialText("😀".repeat(100), [], 13), "utf8") <= 13);
});
