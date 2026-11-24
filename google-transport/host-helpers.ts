import { readFileSync, realpathSync, statSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Resolve pi-ai's public import target from the running host, never the extension's peers. */
export function googleHelpersURL(hostDir: string): string {
	try {
		const hostManifest = join(hostDir, "package.json");
		if (JSON.parse(readFileSync(hostManifest, "utf8")).name !== "@earendil-works/pi-coding-agent") throw new Error();
		const manifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(hostManifest));
		if (!manifest) throw new Error();
		const pkg = JSON.parse(readFileSync(manifest, "utf8"));
		if (pkg.name !== "@earendil-works/pi-ai") throw new Error();
		const exact = pkg.exports?.["./api/google-shared"];
		const exported = exact === undefined ? pkg.exports?.["./api/*"] : exact;
		const target = typeof exported === "string" ? exported : exported?.import;
		if (typeof target !== "string" || !target.startsWith("./")) throw new Error();
		const root = realpathSync(dirname(manifest));
		const file = realpathSync(join(root, exact === undefined ? target.replaceAll("*", "google-shared") : target));
		const rel = relative(root, file);
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !statSync(file).isFile()) throw new Error();
		return pathToFileURL(file).href;
	} catch {
		throw new Error("Cannot locate the host's @earendil-works/pi-ai Google helpers; this feature requires a Pi installation with the public ./api/google-shared export on disk");
	}
}
