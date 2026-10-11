// Supported Pi hosts bind public provider imports. Exercise the legacy callback
// adapter with fake factories: no browser, token refresh endpoint, or credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootPath = join(dirname(fileURLToPath(import.meta.url)), "..");

test("host provider factories preserve OAuth callbacks, refresh signals, and Codex keys", () => {
	const root = mkdtempSync(join(tmpdir(), "pmacct-host-bridge-"));
	try {
		const sdk = join(root, "node_modules", "@earendil-works", "pi-ai");
		mkdirSync(join(sdk, "providers"), { recursive: true });
		writeFileSync(join(sdk, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-ai", type: "module",
			exports: { "./compat": "./compat.js", "./providers/*": "./providers/*.js" },
		}));
		writeFileSync(join(sdk, "compat.js"), "export const getModel = () => undefined;\n");
		for (const [name, factory] of [
			["anthropic", "anthropicProvider"], ["openai-codex", "openaiCodexProvider"],
			["kimi-coding", "kimiCodingProvider"], ["xai", "xaiProvider"],
		]) {
			writeFileSync(join(sdk, "providers", `${name}.js`), `
export function ${factory}() { return { auth: { oauth: {
 async login(interaction) {
  interaction.notify({type: "auth_url", url: "https://example.invalid/oauth"});
  interaction.notify({type: "info", message: "fake progress"});
  await interaction.prompt({type: "manual_code"});
  return {type: "oauth", access: "fake-access", refresh: "fake-refresh"};
 },
 async refresh(credential, signal) {
  if (!(signal instanceof AbortSignal)) throw new Error("missing refresh signal");
  return {...credential, access: "fake-refreshed:" + credential.refresh};
 }
} } }; }
`);
		}
		writeFileSync(join(sdk, "providers", "all.js"), `
			import {anthropicProvider} from './anthropic.js';
			import {openaiCodexProvider} from './openai-codex.js';
			import {kimiCodingProvider} from './kimi-coding.js';
			import {xaiProvider} from './xai.js';
			export const builtinProviders = () => [
				{...anthropicProvider(), id: 'anthropic'},
				{...openaiCodexProvider(), id: 'openai-codex'},
				{...kimiCodingProvider(), id: 'kimi-coding'},
				{...xaiProvider(), id: 'xai'}
			];
		`);
		const ext = join(root, "extension");
		mkdirSync(ext);
		const files: string[] = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8")).files;
		for (const file of files.filter((file) => file.endsWith(".ts"))) {
			cpSync(join(rootPath, file), join(ext, file));
		}
		writeFileSync(join(ext, "package.json"), '{"type":"module"}');
		const agent = join(root, "agent");
		mkdirSync(agent);
		const driver = join(root, "driver.mjs");
		writeFileSync(driver, `
process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agent)};
process.env.PI_CURSOR_PROVIDER_ROOT = ${JSON.stringify(join(root, "no-cursor"))};
const {default: extension} = await import(${JSON.stringify(join(ext, "index.ts"))});
const registrations = new Map();
extension({registerProvider: (id, config) => registrations.set(id, config),
 registerCommand() {}, on() {}, setModel: async () => true,
 getThinkingLevel: () => "high", setThinkingLevel() {}, appendEntry() {}});
const result = {};
const anthropic = registrations.get("anthropic").oauth;
await anthropic.login({
 onAuth: info => result.url = info.url,
 onProgress: text => result.progress = text,
 onManualCodeInput: async () => { result.manual = true; return "fake-code"; },
 onPrompt: async () => "", onSelect: async () => ""
});
result.refreshed = (await anthropic.refreshToken({access: "old", refresh: "fake-refresh"})).access;
const codex = registrations.get("openai-codex").oauth;
result.callbackServer = codex.usesCallbackServer;
result.key = codex.getApiKey({access: "fake-access"});
result.codexRefreshed = (await codex.refreshToken({access: "old", refresh: "fake-codex"})).access;
console.log(JSON.stringify(result));
`);
		const result = JSON.parse(execFileSync(process.execPath, [driver], {
			cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		}));
		assert.deepEqual(result, {
			url: "https://example.invalid/oauth", progress: "fake progress", manual: true,
			refreshed: "fake-refreshed:fake-refresh", callbackServer: true,
			key: "fake-access", codexRefreshed: "fake-refreshed:fake-codex",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
