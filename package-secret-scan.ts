/** Package safety policy: one exact public sentinel is not a vendor credential. */
export function containsPackageSecret(text: string): boolean {
	// Native Anthropic selects its OAuth request dialect from this prefix. Allow only
	// the complete quoted dummy literal, never a prefix/suffix, interpolation or token.
	const sanitized = text.replace(/(["'`])sk-ant-oat01-pi-multi-account-proxy\1/g, '"PUBLIC_PROXY_PLACEHOLDER"');
	return [
		/gh[pousr]_[A-Za-z0-9_]{20,}/,
		/sk-[A-Za-z0-9_-]{8,}/,
		/AIza[0-9A-Za-z_-]{20,}/,
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	].some(pattern => pattern.test(sanitized));
}
