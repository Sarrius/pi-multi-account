import assert from "node:assert/strict";
import test from "node:test";
import { compactionAccessFailure } from "../compaction-summary.ts";

test("observed compaction policy and Daybreak-verification failures are separate from account auth/quota", () => {
  assert.equal(compactionAccessFailure(new Error("Turn prefix summarization failed: Codex error: This content was flagged for possible cybersecurity risk.")), "policy");
  assert.equal(compactionAccessFailure('{"detail":"Unable to verify Daybreak Blue access. Please try again."}'), "access_verification");
  assert.equal(compactionAccessFailure("Unable to verify Daybreak access"), "access_verification");
  for (const error of ["503 Service unavailable", "OAuth token expired", "429 rate limit", "context length exceeded", "Request was aborted", "terminated", null, {}]) {
    assert.equal(compactionAccessFailure(error), undefined);
  }
});
