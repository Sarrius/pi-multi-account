import assert from "node:assert/strict";
import test from "node:test";
import { refreshAndPersistWithStorageLock } from "../index.ts";

const credential = (tag: string) => ({ type: "oauth", access: `synthetic-${tag}-access`,
  refresh: `synthetic-${tag}-refresh`, expires: 4102444800000, accountId: tag });
for (const verdict of ["invalid_grant", "refresh_token_reused"]) {
  test(`issue 90: ${verdict} adopts a real newer login without spending the winner`, async () => {
    const original = credential("original"), winner = credential("new-login");
    let stored = original, exchanges = 0, writes = 0;
    const result = await refreshAndPersistWithStorageLock({
      provider: "openai-codex", credentials: original, readLatest: () => stored,
      authStorage: { modify: async (_: string, fn: (current: any) => Promise<any>) => {
        const next = await fn(stored); if (next !== undefined) { writes++; stored = next; }
      } },
      refresh: async () => { exchanges++; stored = winner; throw new Error(verdict); },
    });
    assert.equal(exchanges, 1); assert.equal(writes, 0);
    assert.deepEqual(result, winner); assert.deepEqual(stored, winner);
  });
}
test("issue 90: successful exchange also adopts a complete newer login without stale publication", async () => {
  const original = credential("original"), winner = credential("winner");
  let stored = original, writes = 0;
  const result = await refreshAndPersistWithStorageLock({
    provider: "anthropic", credentials: original, readLatest: () => stored,
    authStorage: { modify: async (_: string, fn: (current: any) => Promise<any>) => {
      const next = await fn(stored); if (next !== undefined) { writes++; stored = next; }
    } },
    refresh: async () => { stored = winner; return credential("stale-result"); },
  });
  assert.equal(writes, 0); assert.deepEqual(result, winner); assert.deepEqual(stored, winner);
});

for (const message of ["invalid_grant", "refresh_token_reused", "HTTP 503 temporary outage", "synthetic timeout"]) {
  test(`issue 90: ${message} never becomes a blind retry/write without a valid winner`, async () => {
    const original = credential("original"); let exchanges = 0, writes = 0;
    await assert.rejects(refreshAndPersistWithStorageLock({
      provider: "anthropic", credentials: original, readLatest: () => original,
      authStorage: { modify: async (_: string, fn: (current: any) => Promise<any>) => {
        const next = await fn(original); if (next !== undefined) writes++;
      } },
      refresh: async () => { exchanges++; throw new Error(message); },
    }), error => (error as Error).message === message);
    assert.equal(exchanges, 1); assert.equal(writes, 0);
  });
}
