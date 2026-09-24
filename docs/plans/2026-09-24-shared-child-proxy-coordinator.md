# Shared Child Proxy Coordinator Implementation Plan

**Goal:** Keep numbered OAuth child-facing auth/models and the canonical loopback listener alive until the final in-process root closes, while preserving failover for independent roots and same-session rehydration.

**Architecture:** A process-scoped coordinator keyed by canonical proxy port manages live root memberships and a single canonical listener/publication. Session-local failover remains session-local. Rehydration supersedes same-session failover ownership without counting the old instance twice. Proxy requests use the current active member's route/refresh context; root shutdown only releases the shared publication after the last member leaves. Foreign-process listeners remain non-publishers; child processes cannot join. Avoid chained per-instance `releaseProxy` callbacks and leaking real OAuth to child-facing auth during handoff.

**Tech Stack:** TypeScript, Node HTTP server, `node:test`, Pi extension API. See `index.ts` (activation near 3930, provisioning near 6300, proxy near 10635, lifecycle near 11240); `test/failover.test.ts` (fixture near 370 and proxy tests near 11440); `test/session-ownership.test.ts`; #72/#73 review context. Follow code-security race-condition/secrets and TDD skills. Never print credentials; assert only auth `type` and route URL.

---

### Task 1: Baseline and regression tests

**Files:** Modify `test/failover.test.ts`; optionally `test/session-ownership.test.ts`.

1. Preserve the published auth fixture across `setup()` calls (`reuseSlotProxyPort: true`); use a real shared canonical port per test, and simulate pi-web/independent roots plus a stable `getSessionId()`.
2. Add two shutdown-order tests: A starts and publishes, B starts, A closes first then child-facing alias remains `api_key`, canonical models route unchanged, no-auth proxy request returns 401; B closes then auth restores and canonical listener closes. Reverse order B then A must retain publication until A's final close.
3. Add same-ID rehydrate A -> replacement B, A is superseded (no automatic failover), A.shutdown does not interrupt B's canonical 401; B.shutdown restores auth. Add `PI_SUBAGENT_CHILD=1` under both host switches to ensure child never joins or extends publication.
4. Run targeted test with `node --test --experimental-strip-types --test-name-pattern='...specific names...' test/failover.test.ts` (check package.json for the project's actual test runner first). Record a RED assertion for A-first and rehydrate cases; do not touch production first.

### Task 2: Coordinated transport and publication

**Files:** Modify `index.ts`; add a focused module only if simpler than retaining safe typings locally.

1. Introduce a process-scoped coordinator keyed by canonical port; track live root identities (distinct IDs) and at most one failover owner per stable session ID. Explicit child marker wins regardless of host flags. A shared canonical listener persists after its creating root exits, and request dispatch reads the newest valid member's routes/context for refresh rather than stale closed context.
2. At `session_start`, reconcile activation ownership; join the coordinator before proxy startup. Rehydrated old root becomes passive and cannot republish or shut down the listener. Independent siblings may switch but cannot publish contradictory shared routes or restore OAuth while another member is live.
3. `startSlotProxy` for a same-process sibling returns the shared canonical listener/port, not a throwaway ephemeral port; external-port owner stays foreign/non-publishing and must not mutate auth/models. Serialize listener setup and revalidate ownership after async waits.
4. On shutdown, unregister once; if other roots exist, update active handler and leave child publication untouched. Only the final member closes listener, unprovisions owned routes, restores child-facing auth; authorization must not depend on a superseded instance's `subagentChild` flag. Keep numbered Codex with proxy enabled pointed at loopback at every stage; fail closed on missing listener.
5. Run focused tests until GREEN; then `npm run check`, `npm test`, and `npm run pack:check`. No live daemon restart or real credential inspection.

### Task 3: Documentation, review, integration

**Files:** Modify `README.md`, `CHANGELOG.md` only as needed; tests from Task 1; `index.ts`.

1. Rebase #73 on current upstream/main after securing the worktree and handling conflicts; ensure #72's same-session rehydration behavior is included and its separate PR is coordinated, not merged as an independent partial patch.
2. Inspect git diff for secrets, credential boundary errors, publication races, route mismatches, stale owners and unprovisioning. Run fresh read-only review; resolve blockers and rerun all gates.
3. Post results to Sarrius, push to the fork only when aligned on the lifecycle contract and all checks pass. Keep local installed release pin until a safe revision is confirmed; do not restart pi-web daemon.
