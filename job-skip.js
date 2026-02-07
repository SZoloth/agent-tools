#!/usr/bin/env node
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
execFileSync("node", [path.join(__dirname, "job-decision.js"), "skip", ...process.argv.slice(2)], {
  stdio: "inherit",
});

