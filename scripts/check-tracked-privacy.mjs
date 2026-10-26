import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
	.toString("utf8")
	.split("\0")
	.filter(Boolean);

const skip = /\.(png|jpe?g|gif|webp|woff2?|sqlite|lock)$/i;
const allowedUsers = new Set(["example", "runner", "shared"]);
const allowedHome = new Set(["u", "runner"]);
const machineUser = ["vitalij", "simko"].join("");
const accountNick = ["jrnl", "drive"].join("");
const mailLocal = ["vitalii", ".shymko"].join("");
const patterns = [
	{ id: "google-oauth-client-secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
	{ id: "google-oauth-client-id", re: /\b\d{10,15}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/g },
	{ id: "personal-mailbox", re: /@[A-Za-z0-9.-]*\b(gmail|icloud|me|outlook|hotmail|yahoo)\.com\b/gi },
	{ id: "machine-username", re: new RegExp(machineUser, "gi") },
	{ id: "personal-local-part", re: new RegExp(mailLocal.replace(".", "\\."), "gi") },
	{ id: "account-nick", re: new RegExp(accountNick, "gi") },
];

// Exact public installed-client protocol profile, reviewed against the pinned MIT
// reference and RFC8252 section8.5. Never allow an arbitrary client, token, file
// or directory. New values require another provenance review, not obfuscation.
const publicInstalledClient = {
 "google-oauth-client-id": "bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea",
 "google-oauth-client-secret": "1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60",
};
const hits = [];
for (const rel of tracked) {
	if (/(^|\/)(?:auth\.json|antigravity-oauth-client\.json|\.implementation-ledger\.md|\.env(?:\..*)?)$/.test(rel)) hits.push(`${rel}: private-file`);
	if (skip.test(rel)) continue;
	let text;
	try {
		text = readFileSync(join(root, rel), "utf8");
	} catch {
		continue;
	}
	for (const { id, re } of patterns) {
		re.lastIndex = 0;
		for (const match of text.matchAll(re)) {
			const reviewed = rel === "antigravity/oauth-client.ts" && publicInstalledClient[id] === createHash("sha256").update(match[0]).digest("hex");
			if (!reviewed) hits.push(`${rel}: ${id}`);
		}
	}
	for (const match of text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
		if (!allowedUsers.has(match[1].toLowerCase())) hits.push(`${rel}: absolute-macos-home (${match[1]})`);
	}
	for (const match of text.matchAll(/\/home\/([A-Za-z0-9._-]+)/g)) {
		if (!allowedHome.has(match[1].toLowerCase())) hits.push(`${rel}: absolute-linux-home (${match[1]})`);
	}
}

if (hits.length) {
	throw new Error(
		`Refusing private files, credentials or personal identifiers in tracked files:\n  ${[...new Set(hits)].join("\n  ")}\nUse alice@example.com / bob@example.com and relative or $HOME paths.`,
	);
}
console.log(`tracked-privacy check: pass (${tracked.length} files)`);
