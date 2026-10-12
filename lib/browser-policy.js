export function localBrowserBlockMessage(operation, env = process.env) {
	if (env.CODEX_SANDBOX !== "seatbelt") return null;

	return `${operation} blocked: local browser binaries cannot launch inside the Codex macOS sandbox. Use the Browser Plugin, an existing CDP connection, HTTP/API access, or an approved outside-sandbox renderer.`;
}
