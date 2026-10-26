import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface OAuthClient { readonly clientId: string; readonly clientSecret: string }

/** Application credentials are private local configuration, never package defaults or account tokens. */
export function readOAuthClient(): OAuthClient {
 const path = process.env.PI_ANTIGRAVITY_OAUTH_CLIENT_FILE ?? join(homedir(), ".pi", "agent", "antigravity-oauth-client.json");
 let fd: number | undefined;
 try {
  if (!isAbsolute(path)) throw new Error();
  fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const info = fstatSync(fd);
  if (!info.isFile() || info.size > 4096 || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) throw new Error();
  const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== "clientId" && key !== "clientSecret") ||
      typeof data.clientId !== "string" || !/^[a-zA-Z0-9._-]{1,256}\.apps\.googleusercontent\.com$/.test(data.clientId) ||
      typeof data.clientSecret !== "string" || !/^[\x21-\x7e]{1,256}$/.test(data.clientSecret)) throw new Error();
  return Object.freeze({ clientId: data.clientId, clientSecret: data.clientSecret });
 } catch {
  // Never expose file contents, parser errors, client values or a caller-supplied path.
  throw new Error("Missing or invalid private OAuth client configuration. Configure an owner-only (0600), non-symlink antigravity-oauth-client.json outside the repository; see docs/antigravity.md. No embedded client fallback is available.");
 } finally { if (fd !== undefined) closeSync(fd); }
}
