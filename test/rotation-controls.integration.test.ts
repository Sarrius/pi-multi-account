import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Drive the real CLI's extension-command dispatch in fresh processes. No owner
// credentials are copied, no model inference is requested, and fetch is blocked.
test("fresh Pi commands persist reversible rotation exclusions without logging out or hiding models", { timeout: 60_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pmacct-rotation-rpc-"));
	const authPath = join(root, "auth.json"), modelsPath = join(root, "models.json"), configPath = join(root, "provider-failover.json");
	const networkLog = join(root, "unexpected-network.log");
	const logoutLog = join(root, "logout-attempts.log"), postCommitFault = join(root, "post-commit-fault");
	const guardPath = join(root, "network-guard.mjs");
	const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
	writeFileSync(authPath, JSON.stringify({
		"fixture-primary": { type: "api_key", key: "fixture-primary-key" },
		"opencode-go": { type: "api_key", key: "fixture-go-key" },
	}));
	writeFileSync(modelsPath, JSON.stringify({ providers: {
		"fixture-primary": { baseUrl: "http://127.0.0.1:1", api: "openai-completions", models: [{ id: "fixture-model" }] },
		"opencode-go": { modelOverrides: { "glm-5.1": { contextWindow: 42000 } } },
	} }));
	writeFileSync(configPath, JSON.stringify({ autoDiscoverModels: false, showUsage: false, childProxy: false,
		includeCursor: false, includeOllama: false, debugLog: false, fallbacks: [], fixtureSetting: { keep: true } }));
	writeFileSync(join(root, "settings.json"), JSON.stringify({ packages: [], enableInstallTelemetry: false, compaction: { enabled: false } }));
	writeFileSync(guardPath, `import { appendFileSync, existsSync } from "node:fs";
import { ModelRuntime, CredentialSynchronizationError } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
globalThis.fetch = async () => { appendFileSync(${JSON.stringify(networkLog)}, "fetch attempted\\n"); throw new Error("Fixture forbids network"); };
const logout = ModelRuntime.prototype.logout;
ModelRuntime.prototype.logout = async function(provider, options) {
	appendFileSync(${JSON.stringify(logoutLog)}, provider + "\\n");
	await logout.call(this, provider, options);
	if (existsSync(${JSON.stringify(postCommitFault)})) throw new CredentialSynchronizationError(provider, "logout", undefined, { cause: new Error("Injected post-commit fixture fault") });
};`);

	function start() {
		const events: any[] = [];
		const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
		let buffer = "", stderr = "", nextId = 0;
		const child = spawn(process.execPath, ["--import", guardPath, cli, "--mode", "rpc", "--no-session", "--no-tools",
			"--no-extensions", "-e", extension, "--no-skills", "--no-prompt-templates", "--no-context-files",
			"--provider", "fixture-primary", "--model", "fixture-model"], {
			cwd: root, stdio: ["pipe", "pipe", "pipe"],
			env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: root,
				PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
				PI_CURSOR_PROVIDER_ROOT: join(root, "absent-cursor"), NO_COLOR: "1" },
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => {
			for (const wait of pending.values()) wait.reject(new Error(`Pi closed: ${stderr}`));
			pending.clear(); resolve();
		}));
		child.on("error", (error) => { for (const wait of pending.values()) wait.reject(error); });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20_000); });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				let event: any;
				try { event = JSON.parse(line); } catch { stderr += `\nInvalid JSONL: ${line}`; continue; }
				events.push(event);
				const wait = pending.get(event.id);
				if (event.type === "response" && wait) {
					pending.delete(event.id);
					if (event.success) wait.resolve(event);
					else wait.reject(new Error(event.error ?? "RPC request rejected"));
				}
			}
		});
		async function request(type: string, data: Record<string, unknown> = {}) {
			const id = `rotation-${++nextId}`;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await new Promise<any>((resolve, reject) => {
					pending.set(id, { resolve, reject });
					timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timed out: ${stderr}`)); }, 15_000);
					child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
				});
			} finally { if (timer) clearTimeout(timer); }
		}
		async function command(args: string) {
			const before = events.length;
			await request("prompt", { message: `/multi-account ${args}` });
			return events.slice(before).filter((event) => event.type === "extension_ui_request" && event.method === "notify")
				.map((event) => event.message).join("\n");
		}
		async function stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
			try { await closed; } finally { clearTimeout(killTimer); }
			assert.ok(!events.some((event) => event.type === "agent_start" || event.type === "extension_error"),
				"commands must not start inference or throw extension errors");
		}
		return { request, command, stop };
	}

	try {
		const authBefore = readFileSync(authPath, "utf8"), modelsBefore = readFileSync(modelsPath, "utf8");
		const first = start();
		let modelTarget = "";
		try {
			const commands = await first.request("get_commands");
			assert.ok(commands.data.commands.some((command: any) => command.name === "multi-account"));
			const before = await first.request("get_available_models");
			const goModel = before.data.models.find((model: any) => model.provider === "opencode-go");
			assert.ok(goModel, "fixture starts with an authenticated OpenCode Go catalog");
			modelTarget = `opencode-go/${goModel.id}`;
			assert.match(await first.command(`exclude ${modelTarget}`), /excluded.*from rotation/);
			assert.match(await first.command("exclude opencode-go"), /excluded opencode-go from rotation/);
			assert.match(await first.command("exclude kimi-coding-account-2"), /excluded kimi-coding-account-2 from rotation/);
			assert.equal(readFileSync(authPath, "utf8"), authBefore);
			assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore);
			const after = await first.request("get_available_models");
			assert.deepEqual(after.data.models, before.data.models, "native /model availability is preserved");
			const state = await first.request("get_state");
			assert.equal(state.data.model.provider, "fixture-primary");
			await first.command("reload");
		} finally { await first.stop(); }

		const second = start();
		try {
			await second.request("get_commands");
			const status = await second.command("status");
			assert.doesNotMatch(status.split("\n").find((line) => line.startsWith("Rotation (")) ?? "", /opencode-go/);
			assert.match(status, /Excluded providers: opencode-go, kimi-coding-account-2/);
			assert.match(status, /Excluded models: opencode-go\//);
			await second.command("include opencode-go");
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).excludedModels, [modelTarget]);
			await second.command(`include ${modelTarget}`);
			const included = await second.command("status");
			assert.match(included.split("\n").find((line) => line.startsWith("Rotation (")) ?? "", /opencode-go/);
			assert.match(await second.command("remove opencode-go"), /removed opencode-go/);
			const auth = JSON.parse(readFileSync(authPath, "utf8"));
			assert.equal(auth["opencode-go"], undefined);
			assert.equal(auth["fixture-primary"].key, "fixture-primary-key");
			const loggedOut = await second.request("get_available_models");
			assert.ok(!loggedOut.data.models.some((model: any) => model.provider === "opencode-go"),
				"native availability is refreshed after locked logout");
			assert.ok(loggedOut.data.models.some((model: any) => model.provider === "fixture-primary"));

			// Wrap the REAL public SDK logout with a fault injected only after it commits.
			// A typed synchronization error must not cause destructive mutation replay.
			await second.command("log on");
			writeFileSync(authPath, JSON.stringify({ ...auth, "opencode-go": { type: "api_key", key: "fixture-go-relogin" } }));
			writeFileSync(postCommitFault, "inject after real logout");
			const committed = await second.command("remove opencode-go");
			assert.match(committed, /removed opencode-go/);
			assert.doesNotMatch(committed, /deletion could not be confirmed/);
			assert.match(await second.command("log 20"), /logout_local_snapshot/,
				"fixture must actually exercise the post-commit synchronization error");
			assert.deepEqual(readFileSync(logoutLog, "utf8").trim().split("\n"), ["opencode-go", "opencode-go"]);
			const afterCommitted = JSON.parse(readFileSync(authPath, "utf8"));
			assert.equal(afterCommitted["opencode-go"], undefined);
			assert.equal(afterCommitted["fixture-primary"].key, "fixture-primary-key");

			// The file-only removal runtime has no dependency on the host's catalog store.
			// A genuinely damaged host cache still must not undo/retry successful logout.
			rmSync(postCommitFault);
			writeFileSync(authPath, JSON.stringify({ ...auth, "opencode-go": { type: "api_key", key: "fixture-go-cache-fault" } }));
			writeFileSync(join(root, "models-store.json"), "{ malformed fixture catalog");
			const cacheFault = await second.command("remove opencode-go");
			assert.match(cacheFault, /removed opencode-go/);
			assert.match(cacheFault, /local model list could not be fully refreshed/);
			assert.equal(JSON.parse(readFileSync(authPath, "utf8"))["opencode-go"], undefined);
			assert.deepEqual(readFileSync(logoutLog, "utf8").trim().split("\n"), ["opencode-go", "opencode-go", "opencode-go"]);
			assert.match(await second.command("remove kimi-coding-account-2"), /no stored credential/);
			assert.equal(readFileSync(modelsPath, "utf8"), modelsBefore);
			assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).fixtureSetting, { keep: true });
		} finally { await second.stop(); }
		assert.equal(existsSync(networkLog), false, "fresh command verification makes no network requests");
	} finally { rmSync(root, { recursive: true, force: true }); }
});
