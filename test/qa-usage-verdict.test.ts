import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexUsageBody } from "../usage.ts";

const fetchedAt = Date.UTC(2026, 9, 10);
const primary_window = { used_percent: 0, reset_at: fetchedAt / 1000 + 18000 };

for (const flags of [
  { allowed: false, limit_reached: false },
  { allowed: true, limit_reached: true },
]) {
  test(`quota QA: either explicit negative Codex flag wins: ${JSON.stringify(flags)}`, () => {
    assert.equal(parseCodexUsageBody("openai-codex", { rate_limit: { ...flags, primary_window } }, fetchedAt)?.serviceable, false);
  });
}
for (const serviceable of [true, false]) {
  test(`quota QA: an explicit availability flag survives missing window metadata (${serviceable})`, () => {
    const result = parseCodexUsageBody("openai-codex", { rate_limit: { allowed: serviceable } }, fetchedAt);
    assert.equal(result?.serviceable, serviceable);
    assert.equal(result?.primary, undefined);
    assert.equal(result?.fetchedAt, fetchedAt);
  });
}

test("quota QA: missing both verdict and windows remains unknown", () => {
  assert.equal(parseCodexUsageBody("openai-codex", { rate_limit: {} }, fetchedAt), undefined);
});
