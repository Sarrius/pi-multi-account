import { after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const fixtureClient = Object.freeze({
 clientId: "test-only.apps.googleusercontent.com",
 clientSecret: "test-only-not-a-valid-client-secret",
});
const dir = mkdtempSync(join(tmpdir(), "ag-oauth-fixture-"));
const path = join(dir, "client.json");
const previous = process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
writeFileSync(path, JSON.stringify(fixtureClient), { mode: 0o600 });
process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = path;
after(() => {
 if (previous === undefined) delete process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE;
 else process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE = previous;
 rmSync(dir, { recursive: true, force: true });
});
