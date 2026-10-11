import assert from "node:assert/strict";
import test from "node:test";
import { modelQualityBand } from "../index.ts";

for (const id of ["grok-4.6", "grok-4.7", "cursor-grok-4.7", "xai/grok-4.7"]) {
  test(`issue 91: known Grok flagship ${id} is frontier`, () => {
    assert.equal(modelQualityBand(id, id.startsWith("cursor-") ? "cursor" : "xai"), "frontier");
  });
}
for (const id of ["grok-4.7-fast", "grok-4.7-non-reasoning", "grok-4.6-fast", "grok-4.8", "grok-4.99"]) {
  test(`issue 91: no invented frontier equivalence for ${id}`, () => {
    assert.notEqual(modelQualityBand(id, "xai"), "frontier");
  });
}
