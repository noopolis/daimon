import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryToolDescriptors, schemaForModelToolName } from "@noopolis/mneme";
import type { MemoryKernel } from "@noopolis/mneme";
import { canonicalToolFieldNames, MEMORY_TOOL_ARGUMENT_FIELDS, schemaFor } from "./memoryTools.js";

const MODEL_TOOL_NAMES = createMemoryToolDescriptors({} as MemoryKernel, { mode: "dream" })
  .map(({ modelName }) => modelName);

const sorted = (values: Iterable<string>): string[] => [...values].sort();

test("canonicalToolFieldNames accepts both mneme field representations", () => {
  assert.deepEqual(canonicalToolFieldNames("fabricated_zod", { shape: { a: {}, b: {} } }), ["a", "b"]);
  assert.deepEqual(canonicalToolFieldNames("fabricated_plain", { a: {}, b: {} }), ["a", "b"]);
});

test("canonicalToolFieldNames rejects unusable mneme field representations", () => {
  for (const representation of [undefined, null, {}, { shape: {} }]) {
    assert.throws(
      () => canonicalToolFieldNames("fabricated_invalid", representation),
      /@noopolis\/mneme.*fabricated_invalid/u
    );
  }
});

test("Daimon memory tool contracts exactly match mneme", () => {
  assert.ok(MODEL_TOOL_NAMES.length > 0);
  assert.equal(MODEL_TOOL_NAMES.length, 6);
  assert.ok(MODEL_TOOL_NAMES.includes("memory_forget"));
  assert.ok(MODEL_TOOL_NAMES.includes("memory_locate"));
  assert.ok(MODEL_TOOL_NAMES.includes("memory_promote"));
  assert.ok(MODEL_TOOL_NAMES.includes("memory_register"));
  assert.ok(MODEL_TOOL_NAMES.includes("memory_search"));
  assert.ok(MODEL_TOOL_NAMES.includes("memory_summarize"));
  assert.deepEqual(sorted(Object.keys(MEMORY_TOOL_ARGUMENT_FIELDS)), sorted(MODEL_TOOL_NAMES));

  const daimonSchemas = new Map(MODEL_TOOL_NAMES.map((name) => [name, schemaFor(name)]));
  for (const name of MODEL_TOOL_NAMES) {
    const canonical = schemaForModelToolName(name) as {
      shape: Record<string, { isOptional: () => boolean }>;
    };
    const daimon = daimonSchemas.get(name) as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    const canonicalKeys = Object.keys(canonical.shape);
    const daimonKeys = Object.keys(daimon.properties);

    assert.deepEqual(sorted(daimonKeys), sorted(canonicalKeys), `${name} keys`);
    assert.deepEqual(
      sorted(MEMORY_TOOL_ARGUMENT_FIELDS[name]),
      sorted(canonicalKeys),
      `${name} allowlist keys`
    );

    const canonicalRequired = Object.keys(canonical.shape)
      .filter((key) => !canonical.shape[key].isOptional());
    assert.deepEqual(sorted(daimon.required ?? []), sorted(canonicalRequired), `${name} required keys`);
  }

  assert.throws(() => schemaFor("memory_unknown"), /Unknown Pi memory tool/u);
  for (let left = 0; left < MODEL_TOOL_NAMES.length; left += 1) {
    for (let right = left + 1; right < MODEL_TOOL_NAMES.length; right += 1) {
      const leftName = MODEL_TOOL_NAMES[left];
      const rightName = MODEL_TOOL_NAMES[right];
      const leftCanonicalKeys = Object.keys(schemaForModelToolName(leftName).shape);
      const rightCanonicalKeys = Object.keys(schemaForModelToolName(rightName).shape);
      if (sorted(leftCanonicalKeys).join("\u0000") !== sorted(rightCanonicalKeys).join("\u0000")) {
        assert.notEqual(daimonSchemas.get(leftName), daimonSchemas.get(rightName));
        assert.notDeepEqual(
          sorted(Object.keys((daimonSchemas.get(leftName) as { properties: object }).properties)),
          sorted(Object.keys((daimonSchemas.get(rightName) as { properties: object }).properties))
        );
      }
    }
  }
});
