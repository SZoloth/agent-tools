import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("checks the shared browser policy before Puppeteer runs", () => {
	const source = fs.readFileSync(
		fileURLToPath(new URL("./search.js", import.meta.url)),
		"utf8",
	);
	const guard = source.indexOf("localBrowserBlockMessage(");
	const launch = source.indexOf("puppeteer.launch");

	assert.ok(guard !== -1 && guard < launch);
});
