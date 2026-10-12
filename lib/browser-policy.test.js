import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { localBrowserBlockMessage } from "./browser-policy.js";

test("blocks every local browser binary inside the Codex sandbox", () => {
	assert.match(
		localBrowserBlockMessage("Browser launch", { CODEX_SANDBOX: "seatbelt" }),
		/Browser launch blocked/,
	);
	assert.equal(localBrowserBlockMessage("Browser launch", {}), null);
});

for (const [relativePath, launchToken] of [
	["../search-tools/search.js", "puppeteer.launch("],
	["../search-tools/content.js", "puppeteer.launch("],
	["../browser-tools/browser-start.js", "spawn("],
	["../../job-search-pipeline/js/job-materials-ready.js", "puppeteer.launch("],
]) {
	const sourcePath = fileURLToPath(new URL(relativePath, import.meta.url));
	test(`${relativePath} checks policy before launching a browser`, {
		skip: relativePath.startsWith("../../") && !fs.existsSync(sourcePath)
			? "Optional sibling pipeline checkout is absent."
			: false,
	}, () => {
		const source = fs.readFileSync(sourcePath, "utf8");
		const guard = source.indexOf("localBrowserBlockMessage(");
		const launch = source.indexOf(launchToken);

		assert.ok(guard !== -1 && guard < launch);
	});
}
