import assert from "node:assert/strict";
import test from "node:test";
import { containsPackageSecret } from "../package-secret-scan.ts";

test("package secret gate permits only the exact quoted public OAuth proxy sentinel", () => {
	for (const quote of ['"', "'", "`"]) {
		assert.equal(containsPackageSecret(`const publicKey = ${quote}sk-ant-oat01-pi-multi-account-proxy${quote};`), false);
	}
	for (const token of ["sk-ant-oat01-real-credential-fixture", "sk-ant-oat01-pi-multi-account-proxy-private-suffix",
		"sk-ant-oat01-pi-multi-account-proxy${secret}", "sk-proj-private-credential-fixture",
		"ghp_abcdefghijklmnopqrstuvwxyz", "AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ", "-----BEGIN RSA PRIVATE KEY-----"]) {
		assert.equal(containsPackageSecret(JSON.stringify({ token })), true, token);
	}
	assert.equal(containsPackageSecret("sk-ant-oat01-pi-multi-account-proxy"), true, "unquoted token text is not allowlisted");
});
