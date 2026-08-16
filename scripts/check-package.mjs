import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json"], {
	cwd: root,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
}));
if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0]?.files)) {
	throw new Error("npm pack did not return one package manifest");
}
const names = packed[0].files.map((file) => file.path);
const forbidden = /(^|\/)(?:test|tests|scripts|\.github|node_modules|evidence|patches)(?:\/|$)|(?:^|\/)(?:auth\.json|.*\.sqlite(?:-wal|-shm)?|.*\.sock|.*\.log|.*\.tgz)$/i;
const leaked = names.filter((name) => forbidden.test(name));
if (leaked.length) throw new Error(`Refusing non-public package artifacts: ${leaked.join(", ")}`);
for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md", "index.ts"]) {
	if (!names.includes(required)) throw new Error(`npm package is missing ${required}`);
}
if (!Number.isSafeInteger(packed[0].unpackedSize) || packed[0].unpackedSize > 512 * 1024) {
	throw new Error(`npm package is unexpectedly large: ${packed[0].unpackedSize}`);
}
// `const VERSION` in index.ts is what the runtime reports — startup notices, the
// host_capabilities debug entry, `/multi-account status`. It silently drifted from
// package.json through the 1.14.4 and 1.14.5 releases, so every debug log from those
// versions blamed 1.14.3. publish.yml already pins the git tag to package.json; this
// pins the source constant to it as well, and fails the release instead of shipping a
// build that misreports itself.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declaredVersion = /^const VERSION = "([^"]+)";$/m.exec(
	readFileSync(join(root, "index.ts"), "utf8"),
)?.[1];
if (!declaredVersion) {
	throw new Error(
		'index.ts no longer declares `const VERSION = "…";` — the release version check cannot run',
	);
}
if (declaredVersion !== manifest.version) {
	throw new Error(
		`VERSION mismatch: index.ts says ${declaredVersion}, package.json says ${manifest.version}`,
	);
}
const secretPatterns = [
	/gh[pousr]_[A-Za-z0-9_]{20,}/,
	/sk-[A-Za-z0-9_-]{8,}/,
	/AIza[0-9A-Za-z_-]{20,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
for (const name of names) {
	const text = readFileSync(join(root, name), "utf8");
	if (secretPatterns.some((pattern) => pattern.test(text))) {
		throw new Error(`Potential secret marker in publishable file: ${name}`);
	}
}
console.log(`package check: pass (${names.length} files, ${packed[0].unpackedSize} bytes unpacked)`);
