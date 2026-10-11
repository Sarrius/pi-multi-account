/**
 * Where work goes once the account it was on cannot take it.
 *
 * ## What was actually happening
 *
 * Rotation already gets the first step right: of 602 automatic failovers in this machine's black
 * box, 588 stayed inside the same provider family — the same subscription, the same model, just
 * another account. That is the behaviour to protect, and nothing here weakens it.
 *
 * The other 14 are the problem. Those are the hops taken once every account of the current family
 * was spent, and they went nowhere in particular:
 *
 *     kimi-coding → openai-codex   3      cursor       → openai-codex  1
 *     openai-codex → anthropic     3      anthropic    → cursor        1
 *     kimi-coding → anthropic      2      ollama       → kimi-coding   2
 *     kimi-coding → cursor         2
 *
 * There was no ladder being followed, because nothing expressed one. The comparator ordered
 * cross-family candidates by liveness telemetry — measured-free first, then predicted-free, then
 * whoever refused longest ago — and only fell through to the configured family order as a last
 * tiebreak, by which point it almost never spoke. So the answer to "the whole family is spent,
 * where now?" was whatever the telemetry happened to say that second.
 *
 * The second half of the same gap: `providerOrder` could only ever name the six specially-managed
 * families. Accounts outside them — openrouter, zai, minimax, opencode-go-api, openai — could not
 * be placed in the order at all, so they sat permanently last by construction. In 602 automatic
 * failovers not one ever reached them. That is right as a default (they bill per token, while the
 * managed families are flat-rate subscriptions), but it should be a stated policy the user can
 * change, not an accident of the type system.
 *
 * ## The ladder
 *
 * A flat, ordered list of provider GROUPS. A group is a managed family (`anthropic`,
 * `openai-codex`, native subscription `openai`, `kimi-coding`, `cursor`, `qwen`, `ollama`) or the base id of anything else the
 * user is logged in to (`openrouter`, `zai`, `minimax`, …) — numbered rotation slots of the same
 * account (`openai-codex-account-3`) all collapse to one group, because preferring one slot over
 * its sibling is rotation's job, not the ladder's.
 *
 * Three rules, and they are deliberately narrow:
 *
 * 1. **The ladder never overrides same-family.** Staying on the family preserves the model the
 *    user picked, and it is the step that already works. The ladder only decides what happens
 *    after that step has run out.
 * 2. **The ladder never overrides availability.** An account on a real cooldown is not chosen
 *    while a free one exists, whatever the ladder says. The ladder reorders candidates that are
 *    all selectable right now; it does not resurrect spent ones.
 * 3. **A group nobody ranked sorts after every group somebody did**, keeping its existing order
 *    among its unranked peers. Silence is not a preference, so it must not act like one.
 *
 * Within those bounds the ladder outranks the liveness heuristics (`confirmed`, `predictedBusy`),
 * and that is the point. Those heuristics answer "did the provider recently tell us it is free?",
 * whose honest answer for an unmeasurable provider is always "no" — absence of measurement, not
 * evidence of exhaustion. A stated preference is better evidence than a missing measurement. The
 * cost when the ladder is wrong is bounded and self-correcting: one request, one refusal, a
 * cooldown, and the account drops out of the candidate list on its own.
 */

/** Managed routing groups; not all have verified quota telemetry. OpenAI billing modes stay distinct. */
export const MANAGED_GROUPS = [
  "anthropic",
  "openai-codex",
  "openai",
  "kimi-coding",
  "cursor",
  "qwen",
  "ollama",
] as const;

/**
 * The ladder shipped by default.
 *
 * Subscription groups first, strongest coding models earliest (new OpenAI quota is unknown);
 * then the cheap/local tier; then — by omission — everything else, which is where per-token
 * billing lands. It is the same sequence rotation already used as its final tiebreak, promoted
 * to a stated policy so the cross-family hop stops being decided by whatever the telemetry
 * happened to say at that moment.
 */
export const DEFAULT_PROVIDER_PRIORITY: string[] = [
  "anthropic",
  "openai-codex",
  "openai",
  "kimi-coding",
  "cursor",
  "qwen",
  "ollama",
];

/** What people actually type. Kept small and obvious rather than clever. */
const ALIASES: Record<string, string> = {
  claude: "anthropic",
  opus: "anthropic",
  sonnet: "anthropic",
  codex: "openai-codex",
  chatgpt: "openai-codex",
  gpt: "openai-codex",
  openaicodex: "openai-codex",
  chatgptdirect: "openai",
  kimi: "kimi-coding",
  k3: "kimi-coding",
  moonshot: "kimi-coding",
  qwen: "qwen",
  alibaba: "qwen",
  dashscope: "qwen",
  glm: "zai",
  zhipu: "zai",
  router: "openrouter",
};

/**
 * Reduce anything the user or the runtime might say to one group name.
 *
 * Handles a bare family, a numbered rotation slot (`kimi-coding-account-2`), a provider/model
 * pair (`openai-codex/gpt-5.6-sol`), and the common nicknames above. Unknown names pass through
 * normalised rather than being rejected: a provider this build has never heard of is exactly the
 * case the old `ProviderFamily[]` type made unrankable, and it must be rankable now.
 */
export function normalizeGroup(raw: string): string {
  const first = String(raw ?? "")
    .trim()
    .split("/")[0]
    .trim()
    .toLowerCase();
  if (!first) return "";
  const base = first.replace(/-account-\d+$/, "");
  if ((MANAGED_GROUPS as readonly string[]).includes(base)) return base;
  const alias = ALIASES[base.replace(/[^a-z0-9]/g, "")];
  return alias ?? base;
}

/**
 * Clean a user-supplied ladder: normalise each entry, drop blanks, drop repeats (first mention
 * wins, because that is what the person meant by putting it there).
 */
export function normalizePriority(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const group = normalizeGroup(item);
    if (!group || out.includes(group)) continue;
    out.push(group);
  }
  return out;
}

/**
 * Position of a group on the ladder. `Number.MAX_SAFE_INTEGER` for anything unranked, so an
 * unranked group sorts after every ranked one without needing a second comparison.
 */
export function priorityRank(group: string, ladder: readonly string[]): number {
  const normalized = normalizeGroup(group);
  const index = ladder.indexOf(normalized);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Comparator contribution for two candidates.
 *
 * Returns 0 — "no opinion, let the next tiebreak decide" — whenever neither side is ranked, and
 * also when both sit at the same position. Only an actual difference in stated preference moves
 * anything, which is what keeps rule 3 honest: an unranked pair is left exactly as it was.
 */
export function comparePriority(
  groupA: string,
  groupB: string,
  ladder: readonly string[],
): number {
  if (ladder.length === 0) return 0;
  const a = priorityRank(groupA, ladder);
  const b = priorityRank(groupB, ladder);
  if (a === b) return 0;
  return a - b;
}

/** One line per rung, for `/multi-account priority` and the status panel. */
export function describePriority(
  ladder: readonly string[],
  present: readonly string[] = [],
): string[] {
  const seen = new Set(present.map(normalizeGroup));
  const lines = ladder.map((group, index) => {
    const mark = seen.size === 0 ? "" : seen.has(group) ? "" : "  (not logged in)";
    return `  ${index + 1}. ${group}${mark}`;
  });
  const rest = [...seen].filter((group) => !ladder.includes(group)).sort();
  if (rest.length > 0) {
    lines.push(`  ${ladder.length + 1}. everything else — ${rest.join(", ")}`);
  } else {
    lines.push(`  ${ladder.length + 1}. everything else`);
  }
  return lines;
}
