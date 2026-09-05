/**
 * What an extension-free Pi child can and cannot run on.
 *
 * These encode a measurement, not a belief. In an isolated agent directory holding one
 * `models.json` provider entry that mirrors the built-in Codex definition, plus the matching
 * **OAuth** credential under the same key:
 *
 *     pi -p --no-extensions --no-session --model openai-codex-account-4/gpt-5.6-sol …
 *     → exit 1: "No API key found for openai-codex-account-4."
 *
 * The same child pointed at the **built-in** `openai-codex` provider got past authentication.
 * Pi honours an OAuth credential only for a provider definition that declares the flow, and a
 * `models.json` entry declares none.
 *
 * That is the whole reason this module exists, and every case below is one row of it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChildUsability,
  defaultRouteWarning,
  describeChildUsability,
  type ChildUsability,
  type SlotChildFacts,
} from "../child-usability.ts";

const facts = (over: Partial<SlotChildFacts> = {}): SlotChildFacts => ({
  slotId: "openai-codex-account-4",
  credential: "oauth",
  builtin: false,
  ...over,
});

test("the measured failure: an alias slot with an OAuth credential is NOT child-usable", () => {
  const verdict = classifyChildUsability(facts());
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  // The reason must name the observable symptom, or nobody reading it will connect this verdict
  // to the error they actually saw.
  assert.match(verdict.reason, /No API key found/);
  assert.match(verdict.remedy, /loopback proxy|placeholder/i);
});

test("a built-in provider is usable whatever we publish — Pi owns its auth flow", () => {
  // Measured: the same bare child reached the network on built-in `openai-codex` + OAuth.
  const verdict = classifyChildUsability(facts({ slotId: "openai-codex", builtin: true }));
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "builtin");
});

test("the measured failure: built-in Anthropic on a subscription token is NOT child-usable", () => {
  // Measured 2026-08-30, the same bare child shape as above, on the account this session was
  // itself running on successfully:
  //   pi -p --no-extensions --no-session --model anthropic/claude-opus-5 …
  //   → 400 invalid_request_error "Third-party apps now draw from your extra usage, not your
  //     plan limits."
  // Being built-in is therefore not sufficient: Pi resolves the credential, and the vendor then
  // refuses the request because it does not carry the parent's identity headers.
  const verdict = classifyChildUsability(facts({ slotId: "anthropic", builtin: true }));
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /third-party/i);
  assert.match(verdict.remedy, /loopback|placeholder/i);
});

test("a published parent route rescues built-in Anthropic, which is the whole point of it", () => {
  const verdict = classifyChildUsability(
    facts({
      slotId: "anthropic",
      builtin: true,
      publishedApiKey: "pi-multi-account-proxy",
      publishedBaseUrl: "http://127.0.0.1:41977/anthropic",
    }),
  );
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "parent-proxy");
});

test("an API-key slot is usable: Pi resolves it through its own credential store", () => {
  const verdict = classifyChildUsability(facts({ slotId: "zai", credential: "api_key" }));
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "api-key");
});

test("a published cursor-proxy does not rescue Cursor OAuth: Pi still never consults it", () => {
  // Live 2026-08-30 after restart: parent on cursor/cursor-grok-4.6, models.json already had
  // apiKey cursor-proxy against 127.0.0.1:61070/v1, auth.json still held type oauth.
  //   pi -p --no-extensions --no-session --model cursor/cursor-grok-4.6
  //   → exit 1: "No API key found for cursor."
  const verdict = classifyChildUsability(
    facts({
      slotId: "cursor",
      credential: "oauth",
      publishedApiKey: "cursor-proxy",
      publishedBaseUrl: "http://127.0.0.1:61070/v1",
    }),
  );
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
});

test("the Cursor pattern is what makes an OAuth account reachable by a child", () => {
  // Pi consults a models.json apiKey only when the stored credential is itself an API key.
  // The parent therefore presents the placeholder as type api_key while it holds the OAuth blob
  // out of the child's files.
  const verdict = classifyChildUsability(
    facts({
      slotId: "cursor",
      credential: "api_key",
      publishedApiKey: "cursor-proxy",
      publishedBaseUrl: "http://127.0.0.1:57387/v1",
    }),
  );
  assert.equal(verdict.usable, true);
  if (!verdict.usable) return;
  assert.equal(verdict.via, "parent-proxy");
  assert.match(verdict.note, /never leaves the parent/);
});

test("a published placeholder does not rescue an OAuth blob: Pi never consults it", () => {
  // Measured against Pi's resolveProviderAuth: stored type oauth + a models.json-only provider
  // (no OAuth method) returns undefined, so the child dies with "No API key found" without
  // ever opening the loopback port. The empty-auth.json canary hid this because there was no
  // stored blob to win.
  const verdict = classifyChildUsability(
    facts({
      publishedApiKey: "pi-multi-account-proxy",
      publishedBaseUrl: "http://127.0.0.1:41977/openai-codex-account-4",
    }),
  );
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
});

test("a placeholder key pointing off this machine is not a child route, because OAuth still wins", () => {
  // A models.json placeholder is meaningless while auth.json still holds OAuth: Pi never sends it.
  const verdict = classifyChildUsability(
    facts({ publishedApiKey: "cursor-proxy", publishedBaseUrl: "https://api.anthropic.com" }),
  );
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No API key found/);
});

test("localhost and ::1 count as this machine; a lookalike hostname does not", () => {
  for (const baseUrl of ["http://localhost:1234/v1", "http://127.0.0.1:1/v1", "http://[::1]:9/v1"]) {
    const verdict = classifyChildUsability(
      facts({ credential: "api_key", publishedApiKey: "k", publishedBaseUrl: baseUrl }),
    );
    assert.equal(verdict.usable, true, baseUrl);
    if (!verdict.usable) continue;
    assert.equal(verdict.via, "parent-proxy", baseUrl);
  }
  // `127.0.0.1.evil.tld` and friends must not pass by prefix matching.
  for (const baseUrl of ["http://127.0.0.1.evil.tld/v1", "http://notlocalhost/v1", "gibberish"]) {
    const verdict = classifyChildUsability(
      facts({ credential: "api_key", publishedApiKey: "k", publishedBaseUrl: baseUrl }),
    );
    assert.equal(verdict.usable, true, baseUrl);
    if (!verdict.usable) continue;
    assert.equal(verdict.via, "api-key", baseUrl);
  }
});

test("no credential at all is reported as such, not as an auth-flow problem", () => {
  const verdict = classifyChildUsability(facts({ credential: "none" }));
  assert.equal(verdict.usable, false);
  if (verdict.usable) return;
  assert.match(verdict.reason, /No credential/i);
});

// ---------------------------------------------------------------------------
// The warning that connects this to the symptom people actually hit
// ---------------------------------------------------------------------------

test("an unusable saved global default warns only about bare unpinned children", () => {
  const warning = defaultRouteWarning("openai-codex-account-4", () =>
    classifyChildUsability(facts()),
  );
  assert.ok(warning, "an unusable saved default must produce a warning");
  assert.match(warning, /saved global default/);
  assert.match(warning, /without --model/);
  assert.match(warning, /first-available provider/);
  assert.match(warning, /broker\/subagent children are unaffected/);
});

test("a usable saved default produces no noise", () => {
  const warning = defaultRouteWarning("openai-codex", () =>
    classifyChildUsability(facts({ slotId: "openai-codex", builtin: true })),
  );
  assert.equal(warning, undefined);
});

test("no saved default, or an unknown one, is silence rather than a guess", () => {
  assert.equal(defaultRouteWarning(undefined, () => undefined), undefined);
  assert.equal(defaultRouteWarning("mystery", () => undefined), undefined);
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("the report puts unusable slots first and is otherwise stable", () => {
  const verdicts: ChildUsability[] = [
    classifyChildUsability(facts({ slotId: "zai", credential: "api_key" })),
    classifyChildUsability(facts({ slotId: "openai-codex-account-4" })),
    classifyChildUsability(facts({ slotId: "anthropic", builtin: true })),
    classifyChildUsability(facts({ slotId: "kimi-coding-account-2" })),
  ];
  const lines = describeChildUsability(verdicts);
  // Problems first, so the thing needing attention is not buried under healthy rows.
  assert.match(lines[0], /anthropic|kimi-coding-account-2|openai-codex-account-4/);
  assert.match(lines[0], /NOT usable/);
  assert.match(lines[1], /NOT usable/);
  assert.equal(lines.filter((l) => /NOT usable/.test(l)).length, 3);
  // Same input, same output — a report that reorders itself cannot be diffed between runs.
  assert.deepEqual(describeChildUsability(verdicts), lines);
  assert.deepEqual(describeChildUsability([...verdicts].reverse()), lines);
});
