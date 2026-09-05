/**
 * The assumptions this extension makes about Pi, and the shape checks that notice when one stops
 * holding.
 *
 * Two Pi changes have already broken this extension, and neither announced itself:
 *  - `AuthStorage` dropped `set()` on 0.84.x — the file format was fine, the write path was not;
 *    the user re-logged into Anthropic roughly daily until it was found.
 *  - Slot catalogues were written into `models.json` as bare id strings where Pi requires
 *    objects; Pi rejected the WHOLE file and every custom provider vanished at once.
 *
 * Neither `auth.json` nor `models.json` carries a schema version, so a format change cannot be
 * detected by comparing versions. Looking at the shape is the only option available.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PI_ASSUMPTIONS,
  PUBLISHED_FILES,
  checkAuthShape,
  checkModelsShape,
  checkSettingsShape,
  checkSettingsTracksActive,
  describeContractDrift,
  observedAssumptions,
  piAutoPersistsSelectedModel,
} from "../pi-contract.ts";

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("the interface is exactly the three files Pi publishes", () => {
  // A bare child reads these and nothing else — anything deeper is a design smell, not a
  // dependency to formalise.
  assert.deepEqual([...PUBLISHED_FILES], ["auth.json", "models.json", "settings.json"]);
});

test("every assumption says whether Pi promised it, where, and what breaks", () => {
  assert.ok(PI_ASSUMPTIONS.length > 0);
  for (const assumption of PI_ASSUMPTIONS) {
    assert.ok(assumption.id && assumption.fact, `${assumption.id}: fact required`);
    assert.ok(["documented", "observed"].includes(assumption.kind), assumption.id);
    // "Where" and "what breaks" are what make the row actionable after an upgrade. A row without
    // them is a note, not a check.
    assert.ok(assumption.surface.length > 10, `${assumption.id}: needs a surface`);
    assert.ok(assumption.breaks.length > 10, `${assumption.id}: needs a consequence`);
  }
  const ids = PI_ASSUMPTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
});

test("only genuinely unpromised assumptions remain on the manual re-check list", () => {
  const observed = observedAssumptions().map((a) => a.id);
  assert.deepEqual(observed, ["oauth-needs-provider-declared-flow"]);
  assert.equal(
    PI_ASSUMPTIONS.find((assumption) => assumption.id === "settings-default-model-versioned-persistence")?.kind,
    "documented",
  );
});

test("model-default persistence is gated at Pi 0.84.3", () => {
  assert.equal(piAutoPersistsSelectedModel("0.84.0"), true);
  assert.equal(piAutoPersistsSelectedModel("v0.84.2"), true);
  assert.equal(piAutoPersistsSelectedModel("0.84.3"), false);
  assert.equal(piAutoPersistsSelectedModel("0.84.4"), false);
  assert.equal(piAutoPersistsSelectedModel("0.85.0"), false);
  assert.equal(piAutoPersistsSelectedModel("1.0.0"), false);
  assert.equal(piAutoPersistsSelectedModel("unknown"), false);
});

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

test("auth.json: the ordinary shape passes", () => {
  const verdict = checkAuthShape({
    anthropic: { type: "oauth", access: "x", refresh: "y" },
    zai: { type: "api_key", key: "k" },
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test("auth.json: an unfamiliar credential kind is reported, not silently skipped", () => {
  // Silently skipping is how an account disappears from the rotation with no explanation.
  const verdict = checkAuthShape({ future: { type: "passkey" } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /future.*passkey/);
});

test("auth.json: the check never carries a secret in its output", () => {
  const verdict = checkAuthShape({
    anthropic: { type: "nonsense", access: "SUPER-SECRET-TOKEN", refresh: "ALSO-SECRET" },
  });
  const rendered = JSON.stringify(verdict);
  assert.equal(rendered.includes("SUPER-SECRET-TOKEN"), false, "a diagnostic must not leak a token");
  assert.equal(rendered.includes("ALSO-SECRET"), false);
});

// ---------------------------------------------------------------------------
// models.json — the schema that already cost a user every custom provider
// ---------------------------------------------------------------------------

test("models.json: a bare model id string is caught, and the message says how bad it is", () => {
  const verdict = checkModelsShape({
    providers: { "kimi-coding-account-2": { api: "anthropic-messages", models: ["k3", "k3-256k"] } },
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /2 model entries are a bare string/);
  // Pi rejects the whole file, so the blast radius is every other provider too — the message has
  // to say that or it reads like a local problem.
  assert.match(verdict.problems[0], /ENTIRE file/);
});

test("models.json: model objects pass, and an absent registry is not a fault", () => {
  assert.equal(
    checkModelsShape({ providers: { zai: { models: [{ id: "glm-5.2" }] } } }).ok,
    true,
  );
  // A user with no custom providers at all is a normal install, not drift.
  assert.equal(checkModelsShape({}).ok, true);
});

test("models.json: structural nonsense is reported rather than thrown", () => {
  assert.equal(checkModelsShape("not json").ok, false);
  assert.equal(checkModelsShape({ providers: [] }).ok, false);
  assert.equal(checkModelsShape({ providers: { a: { models: "k3" } } }).ok, false);
});

// ---------------------------------------------------------------------------
// settings.json — where the one unpromised assumption becomes observable
// ---------------------------------------------------------------------------

test("settings.json: both keys present is the healthy case", () => {
  const verdict = checkSettingsShape({ defaultProvider: "openai-codex-account-4", defaultModel: "gpt-5.6-sol" });
  assert.equal(verdict.ok, true);
});

test("settings.json: both saved-default keys may be absent on session-scoped Pi", () => {
  const verdict = checkSettingsShape({ theme: "dark" });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.problems, []);
});

test("settings.json: a half-written saved default is invalid", () => {
  const verdict = checkSettingsShape({ defaultProvider: "anthropic" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /both be strings or both be absent/);
});

test("settings.json: a wrong type is caught even when the key exists", () => {
  assert.equal(checkSettingsShape({ defaultProvider: 42, defaultModel: "m" }).ok, false);
});

// ---------------------------------------------------------------------------
// settings.json tracking the LIVE model — legacy Pi <=0.84.2 only
// ---------------------------------------------------------------------------

const active = { provider: "openai-codex-account-4", id: "gpt-5.6-sol" };

test("settings.json naming the running model is the whole point, and passes", () => {
  const verdict = checkSettingsTracksActive(
    { defaultProvider: "openai-codex-account-4", defaultModel: "gpt-5.6-sol" },
    active,
  );
  assert.equal(verdict.ok, true);
});

test("a stale default is caught, and the message names both models", () => {
  // This is the exact live failure that started all of this: the rotation was on Codex, the file
  // said something else, and a bare child ended up on Anthropic and got billed-refused.
  const verdict = checkSettingsTracksActive(
    { defaultProvider: "anthropic", defaultModel: "claude-opus-5" },
    active,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /anthropic\/claude-opus-5/);
  assert.match(verdict.problems[0], /openai-codex-account-4\/gpt-5\.6-sol/);
  // Without the consequence spelled out this reads as cosmetic drift rather than "your children
  // are running on the wrong account".
  assert.match(verdict.problems[0], /child/);
});

test("the model alone differing is still a mismatch", () => {
  const verdict = checkSettingsTracksActive(
    { defaultProvider: "openai-codex-account-4", defaultModel: "gpt-5.6-mini" },
    active,
  );
  assert.equal(verdict.ok, false);
});

test("missing saved defaults are a legacy mismatch only when this gated check is requested", () => {
  const verdict = checkSettingsTracksActive({ theme: "dark" }, active);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems[0], /\(unset\)\/\(unset\)/);
  assert.match(verdict.problems[0], /Pi <=0\.84\.2/);
});

test("a broken settings file reports the shape problem rather than a bogus mismatch", () => {
  // Reporting "records (unset)/(unset)" for a file that is not even an object would send someone
  // hunting for a rotation bug instead of a corrupt file.
  const verdict = checkSettingsTracksActive("nonsense", active);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems, ["not a JSON object"]);
});

// ---------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------

test("a healthy install says nothing at all", () => {
  const verdicts = [
    checkAuthShape({ zai: { type: "api_key" } }),
    checkModelsShape({}),
    checkSettingsShape({ defaultProvider: "p", defaultModel: "m" }),
  ];
  assert.equal(describeContractDrift(verdicts), undefined);
});

test("drift names the file, the problem, and why nothing warned us", () => {
  const message = describeContractDrift([
    checkModelsShape({ providers: { a: { models: ["x"] } } }),
    checkSettingsShape({ defaultProvider: "p", defaultModel: "m" }),
  ]);
  assert.ok(message);
  assert.match(message, /models\.json/);
  assert.match(message, /bare string/);
  // The reason matters: without it this reads as our bug rather than an unversioned format
  // changing underneath us.
  assert.match(message, /carries no version|no version/);
  assert.equal(/settings\.json/.test(message), false, "a healthy file must not appear in the report");
});
