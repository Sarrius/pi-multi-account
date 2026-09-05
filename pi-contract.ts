/**
 * What this extension assumes about Pi, written down — and checked.
 *
 * ## Why a ledger, and why it distinguishes two kinds of assumption
 *
 * A Pi update has broken this extension before, and the two cases were not the same shape:
 *
 * - **A method disappeared.** `AuthStorage` dropped `set()` on pi 0.84.x, which is what this
 *   extension persisted a refreshed Anthropic token with. The file format never changed; the way
 *   to write it did. Symptom: a fresh `/login anthropic` roughly once a day.
 * - **A file schema was stricter than we wrote.** Slot catalogues were written into `models.json`
 *   as bare id strings where Pi requires each model to be an object. Pi then rejected the
 *   **entire file**, so every custom provider the user had disappeared at once.
 *
 * Both were silent from the outside and expensive to trace. The defence is not to guess better;
 * it is to state the dependency, mark whether Pi actually promised it, and notice when it stops
 * being true.
 *
 * ## Three rules this module exists to hold
 *
 * 1. **Read only the published files.** Pi hands the outside world exactly three:
 *    `auth.json`, `models.json`, `settings.json`. A bare `pi -p --no-extensions` child reads
 *    those and nothing else — verified by experiment on 2026-08-24. Anything we need from
 *    deeper inside Pi is a design smell, not a dependency to formalise.
 * 2. **Never write those files directly.** Writing goes through Pi, which owns locking,
 *    concurrent access and migrations. The `AuthStorage` incident is what happens when the
 *    write path is treated as ours.
 * 3. **Check the shape, because nothing else will.** `auth.json` and `models.json` carry **no
 *    schema version** (checked: neither has a version field; only `settings.json` records a Pi
 *    version, which is the app's, not the format's). So a format change cannot announce itself.
 *    The only way to notice is to look, and to say so out loud rather than fail later somewhere
 *    unrelated.
 *
 * Pure by construction: this module reads nothing and writes nothing. It is handed already-parsed
 * values and returns verdicts, so the whole ledger can be tested without a filesystem.
 */

/** Whether Pi actually promises a thing, or we merely observed it holding. */
export type AssumptionKind = "documented" | "observed";

export interface PiAssumption {
  id: string;
  /** The assumption, stated so it can be checked by a person after an update. */
  fact: string;
  kind: AssumptionKind;
  /** Where it is promised, or where it was observed. */
  surface: string;
  /** What stops working here when it stops being true. */
  breaks: string;
}

/**
 * Every load-bearing assumption this extension makes about Pi.
 *
 * The `observed` rows are the re-check list after each Pi upgrade: they are behaviour nobody
 * promised, and they can change without any note in a changelog.
 */
export const PI_ASSUMPTIONS: readonly PiAssumption[] = Object.freeze([
  Object.freeze({
    id: "auth-file",
    fact: "Credentials live in auth.json, one entry per provider id, each carrying a `type` of `oauth` or `api_key`.",
    kind: "documented" as const,
    surface: "docs/providers.md, docs/models.md",
    breaks: "Account discovery: the rotation is built from these entries.",
  }),
  Object.freeze({
    id: "models-file",
    fact: "models.json holds `providers`, and each provider's `models` is an array of OBJECTS; a bare id string invalidates the whole file.",
    kind: "documented" as const,
    surface: "docs/custom-provider.md, docs/models.md",
    breaks: "Every custom provider the user has, not only ours — Pi rejects the file wholesale.",
  }),
  Object.freeze({
    id: "settings-default-model-key",
    fact: "settings.json carries `defaultProvider` and `defaultModel`.",
    kind: "documented" as const,
    surface: "docs/settings.md",
    breaks: "Nothing directly; it is the key the next row writes to.",
  }),
  Object.freeze({
    id: "settings-default-model-versioned-persistence",
    fact: "Pi <=0.84.2 writes defaultProvider/defaultModel on every model switch; Pi >=0.84.3 keeps ordinary model selection session-scoped and writes the global default only for an explicit persistent selection.",
    kind: "documented" as const,
    surface: "Pi 0.84.3 changelog and AgentSession.setModel(model, { persist }): ordinary selection no longer rewrites the global default; Ctrl+S remains the explicit persistence action.",
    breaks: "A bare child launched without an explicit --model inherits only the saved global default, not pi-multi-account's live rotation slot. Explicitly model-pinned broker/subagent children are unaffected.",
  }),
  Object.freeze({
    id: "child-reads-published-files-only",
    fact: "A `pi -p --no-extensions` child resolves providers from models.json plus built-ins, and credentials from auth.json — it cannot see extension-registered providers.",
    kind: "documented" as const,
    surface: "docs/usage.md (--no-extensions); confirmed by experiment 2026-08-24",
    breaks: "Every claim about what a bare child can run on.",
  }),
  Object.freeze({
    id: "oauth-needs-provider-declared-flow",
    fact: "Pi honours an OAuth credential only for a provider definition that declares the flow; a models.json entry declares none, so an OAuth token under that key is never used.",
    kind: "observed" as const,
    surface: "Measured 2026-08-24: a published alias slot with an OAuth credential fails with \"No API key found\"; the built-in provider with the same credential authenticates.",
    breaks: "Publishing OAuth rotation slots for children — the reason a parent-owned proxy with a placeholder key is required rather than optional.",
  }),
  Object.freeze({
    id: "credential-writes-go-through-pi",
    fact: "Credential writes must use Pi's own locked storage API, never a direct file write.",
    kind: "documented" as const,
    surface: "AuthStorage; learned the hard way when pi 0.84.x dropped set() and a refreshed token was thrown away daily.",
    breaks: "Token refresh: a rotated credential that cannot be persisted is a burned credential.",
  }),
]);

/** The three files Pi publishes to the outside world. Nothing else is an interface. */
export const PUBLISHED_FILES = Object.freeze(["auth.json", "models.json", "settings.json"] as const);

export interface ShapeVerdict {
  file: string;
  ok: boolean;
  /** Populated when `ok` is false: what looked wrong, in terms a person can act on. */
  problems: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SESSION_SCOPED_MODEL_SELECTION_SINCE = Object.freeze([0, 84, 3] as const);

/**
 * Whether an ordinary Pi model switch is expected to rewrite the saved global default.
 *
 * Pi 0.84.3 deliberately made model/thinking selection session-scoped unless the caller passes
 * `{ persist: true }` (the TUI's explicit Ctrl+S action). Unknown/non-semver hosts are treated as
 * session-scoped: emitting a loud compatibility warning from an assumption we cannot establish is
 * worse than omitting an optional legacy diagnostic.
 */
export function piAutoPersistsSelectedModel(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number) as [number, number, number];
  for (let index = 0; index < SESSION_SCOPED_MODEL_SELECTION_SINCE.length; index++) {
    const delta = actual[index] - SESSION_SCOPED_MODEL_SELECTION_SINCE[index];
    if (delta !== 0) return delta < 0;
  }
  return false;
}

/**
 * `auth.json`: a flat map of provider id → credential record carrying a `type`.
 *
 * Deliberately shallow. This must never touch, log or return a secret — it reports the shape of
 * the container and nothing about what is inside it.
 */
export function checkAuthShape(raw: unknown): ShapeVerdict {
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    return { file: "auth.json", ok: false, problems: ["not a JSON object"] };
  }
  for (const [provider, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) {
      problems.push(`${provider}: entry is not an object`);
      continue;
    }
    const type = entry.type;
    if (type !== "oauth" && type !== "api_key") {
      // A new credential kind is not necessarily a break — but it is exactly the kind of quiet
      // change that makes account discovery skip an account without saying why.
      problems.push(`${provider}: unfamiliar credential type ${JSON.stringify(type)}`);
    }
  }
  return { file: "auth.json", ok: problems.length === 0, problems };
}

/**
 * `models.json`: `providers` → each with a `models` ARRAY OF OBJECTS.
 *
 * The array-of-objects rule is the one that has already cost a user every custom provider they
 * had: Pi validates the whole file and rejects all of it when one entry is a bare string.
 */
export function checkModelsShape(raw: unknown): ShapeVerdict {
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    return { file: "models.json", ok: false, problems: ["not a JSON object"] };
  }
  const providers = raw.providers;
  if (providers === undefined) {
    // An absent registry is legitimate — the user may have no custom providers at all.
    return { file: "models.json", ok: true, problems: [] };
  }
  if (!isPlainObject(providers)) {
    return { file: "models.json", ok: false, problems: ["`providers` is not an object"] };
  }
  for (const [provider, definition] of Object.entries(providers)) {
    if (!isPlainObject(definition)) {
      problems.push(`${provider}: definition is not an object`);
      continue;
    }
    const models = definition.models;
    if (models === undefined) continue;
    if (!Array.isArray(models)) {
      problems.push(`${provider}: \`models\` is not an array`);
      continue;
    }
    const stringEntries = models.filter((model) => typeof model === "string").length;
    if (stringEntries > 0) {
      problems.push(
        `${provider}: ${stringEntries} model entr${stringEntries === 1 ? "y is" : "ies are"} a bare string; Pi requires objects and rejects the ENTIRE file, taking every other custom provider with it`,
      );
    }
  }
  return { file: "models.json", ok: problems.length === 0, problems };
}

/**
 * `settings.json`: the saved default keys are optional, but must be strings when present.
 *
 * Since Pi 0.84.3 their absence is ordinary: a live model selection is session-scoped unless the
 * user explicitly persists it. Whether a saved value must track the live model is therefore a
 * versioned behavioural check, not part of the file's shape.
 */
export function checkSettingsShape(raw: unknown): ShapeVerdict {
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    return { file: "settings.json", ok: false, problems: ["not a JSON object"] };
  }
  const provider = raw.defaultProvider;
  const model = raw.defaultModel;
  if (provider !== undefined && typeof provider !== "string") problems.push("`defaultProvider` is not a string");
  if (model !== undefined && typeof model !== "string") problems.push("`defaultModel` is not a string");
  if ((provider === undefined) !== (model === undefined)) {
    problems.push("`defaultProvider` and `defaultModel` must either both be strings or both be absent");
  }
  return { file: "settings.json", ok: problems.length === 0, problems };
}

/**
 * One message for the user when a published file no longer looks the way we depend on it looking.
 * Returns `undefined` when everything matches, so a healthy install stays silent.
 */
export function describeContractDrift(verdicts: readonly ShapeVerdict[]): string | undefined {
  const broken = verdicts.filter((verdict) => !verdict.ok);
  if (broken.length === 0) return undefined;
  const lines = broken.flatMap((verdict) => [
    `  ${verdict.file}:`,
    ...verdict.problems.map((problem) => `    - ${problem}`),
  ]);
  return [
    "pi-multi-account: a file Pi publishes no longer matches what this extension depends on.",
    "This is usually a Pi upgrade changing a format that carries no version, so nothing announced it.",
    ...lines,
    "Rotation may behave oddly until this is resolved; run /multi-account status for the current view.",
  ].join("\n");
}

/**
 * Legacy-only behavioural check: on Pi <=0.84.2, does `settings.json` name the model running now?
 *
 * Pi >=0.84.3 intentionally separates the live session selection from the saved global default,
 * so callers MUST gate this check with `piAutoPersistsSelectedModel()`. A bare child without an
 * explicit `--model` then inherits the saved default by design; a broker/subagent child with an
 * explicit provider/model remains isolated from that global value.
 */
export function checkSettingsTracksActive(
  raw: unknown,
  active: { provider: string; id: string },
): ShapeVerdict {
  const base = checkSettingsShape(raw);
  if (!base.ok) return base;
  const settings = raw as Record<string, unknown>;
  const problems: string[] = [];
  const recorded = `${settings.defaultProvider ?? "(unset)"}/${settings.defaultModel ?? "(unset)"}`;
  const live = `${active.provider}/${active.id}`;
  if (recorded !== live) {
    problems.push(
      `records ${recorded} while the session is running ${live}; Pi <=0.84.2 is expected to rewrite both keys on every model switch, while a bare extension-free child without --model reads the saved value — so that child would run on ${recorded}, not on the account the rotation selected`,
    );
  }
  return { file: "settings.json", ok: problems.length === 0, problems };
}

/** The assumptions to re-check after a Pi upgrade — the ones nobody promised. */
export function observedAssumptions(): readonly PiAssumption[] {
  return PI_ASSUMPTIONS.filter((assumption) => assumption.kind === "observed");
}
