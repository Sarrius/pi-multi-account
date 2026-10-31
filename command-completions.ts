export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

export interface CompletionContext {
	rotation: readonly string[];
}

interface Choice {
	value: string;
	description: string;
}

interface Subcommand {
	name: string;
	description: string;
	takesArgument?: boolean;
	choices?: (context: CompletionContext) => Choice[];
}

const ACCOUNT_FAMILIES = ["anthropic", "openai", "codex", "kimi", "cursor", "ollama", "qwen"];

const accounts = (context: CompletionContext): Choice[] =>
	context.rotation.map(value => ({ value, description: "Account in the rotation" }));

const families = (): Choice[] => ACCOUNT_FAMILIES.map(value => ({ value, description: "Account family" }));

const toggle = (): Choice[] => [
	{ value: "on", description: "Turn on" },
	{ value: "off", description: "Turn off" },
];

const refresh = (): Choice[] => [{ value: "refresh", description: "Bypass the cache and fetch fresh data" }];

const SUBCOMMANDS: readonly Subcommand[] = [
	{ name: "status", description: "Show rotation, current account, cooldowns and invalidations" },
	{ name: "limits", description: "Show the active account's usage limits", takesArgument: true, choices: refresh },
	{ name: "accounts", description: "List every account with plan, quota and routing status", takesArgument: true, choices: refresh },
	{ name: "best", description: "Switch to an account that can work right now" },
	{ name: "next", description: "Step to the next fallback account" },
	{ name: "switch", description: "Switch to a specific account, e.g. anthropic-account-2", takesArgument: true, choices: accounts },
	{
		name: "priority",
		description: "Show or set the failover order between providers",
		takesArgument: true,
		choices: () => [
			{ value: "reset", description: "Restore the default order" },
			{ value: "none", description: "No preference, decide by live availability" },
		],
	},
	{ name: "models", description: "Show the model order tried on each account" },
	{ name: "pick", description: "Pick a model for the current account only" },
	{ name: "pin", description: "Pin a preferred model for a provider group", takesArgument: true },
	{ name: "unpin", description: "Remove a model pin", takesArgument: true },
	{ name: "pins", description: "List model pins" },
	{ name: "save-default", description: "Save the current model and thinking level as the startup default" },
	{ name: "add", description: "Print the next free login slot for a provider", takesArgument: true, choices: families },
	{
		name: "remove",
		description: "Log an account out by deleting its credential",
		takesArgument: true,
		choices: context => [...families(), ...accounts(context)],
	},
	{ name: "exclude", description: "Leave an account or model out of the rotation", takesArgument: true, choices: accounts },
	{ name: "include", description: "Put an excluded account or model back", takesArgument: true, choices: accounts },
	{
		name: "revive",
		description: "Clear an account's invalidated state",
		takesArgument: true,
		choices: context => [...accounts(context), { value: "all", description: "Revive every invalidated account" }],
	},
	{ name: "rediscover", description: "Rescan auth.json and rebuild the rotation" },
	{ name: "reload", description: "Reload config from disk and rediscover accounts" },
	{ name: "reset", description: "Clear cooldowns, invalidations and pending auto-resume" },
	{ name: "stop", description: "Stop automatic failover and resume for the current task" },
	{ name: "enable", description: "Turn failover on for this pi process" },
	{ name: "disable", description: "Turn failover off for this pi process" },
	{ name: "log", description: "Show or toggle the debug log", takesArgument: true, choices: toggle },
	{ name: "only-active", description: "Legacy: limit the model picker to the active account", takesArgument: true, choices: toggle },
	{ name: "clear", description: "Warning: wipe fallbacks, rotation state and numbered account logins" },
];

const ALIASES: Readonly<Record<string, string>> = {
	usage: "limits",
	quota: "limits",
	account: "accounts",
	live: "best",
	use: "switch",
	order: "priority",
	model: "models",
	rm: "remove",
	delete: "remove",
	logs: "log",
	debug: "log",
	focus: "only-active",
};

function completeSubcommand(typed: string): CompletionItem[] {
	return SUBCOMMANDS.filter(subcommand => subcommand.name.startsWith(typed)).map(subcommand => ({
		value: subcommand.takesArgument ? `${subcommand.name} ` : subcommand.name,
		label: subcommand.name,
		description: subcommand.description,
	}));
}

function completeArgument(typedCommand: string, typedArgument: string, context: CompletionContext): CompletionItem[] | null {
	const name = ALIASES[typedCommand] ?? typedCommand;
	const choices = SUBCOMMANDS.find(subcommand => subcommand.name === name)?.choices;
	if (!choices) return null;
	return choices(context)
		.filter(choice => choice.value.startsWith(typedArgument))
		.map(choice => ({ value: `${typedCommand} ${choice.value}`, label: choice.value, description: choice.description }));
}

/** Completions for the text typed after `/multi-account `; the returned `value` replaces all of that text. */
export function completeCommandArguments(prefix: string, context: CompletionContext): CompletionItem[] | null {
	const words = prefix.trimStart().split(/\s+/);
	if (words.length === 1) return completeSubcommand(words[0]);
	if (words.length === 2) return completeArgument(words[0], words[1], context);
	return null;
}
