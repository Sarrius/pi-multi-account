/** Shared installed-application identifiers, NOT user/account credentials.
 * RFC8252 section8.5: a shared native-app client secret is not confidential.
 * Public MIT protocol reference: NoeFabris/opencode-antigravity-auth
 * commit f212f7eb01aa904b5985895cf93f6d3074c5bc6d, src/constants.ts.
 * Keep plaintext and provenance reviewable; do not encode or download at runtime.
 */
export interface OAuthClient { readonly clientId: string; readonly clientSecret: string }
export const PUBLIC_INSTALLED_CLIENT: OAuthClient = Object.freeze({
 clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
 clientSecret: "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",
});
