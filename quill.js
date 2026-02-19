#!/usr/bin/env node

/**
 * Quill CLI - Bridge between Quill.app and Claude Code
 *
 * Commands:
 *   quill.js           Show current prompt from ~/.quill/document.json
 *   quill.js edit      Open Claude Code with the prompt
 *   quill.js humanize  Run compound-writing skill on the document
 *   quill.js status    Show document info
 */

import fs from "fs";
import path from "path";
import { spawn, execFileSync } from "child_process";
import os from "os";

const QUILL_DIR = path.join(os.homedir(), ".quill");
const DOC_PATH = path.join(QUILL_DIR, "document.json");

function loadDocument() {
  if (!fs.existsSync(DOC_PATH)) {
    console.error("No document found at ~/.quill/document.json");
    console.error("Open a file in Quill first.");
    process.exit(1);
  }

  try {
    const data = fs.readFileSync(DOC_PATH, "utf8");
    return JSON.parse(data);
  } catch (e) {
    console.error("Failed to parse document.json:", e.message);
    process.exit(1);
  }
}

function showPrompt() {
  const doc = loadDocument();
  console.log(doc.prompt);
}

function showStatus() {
  const doc = loadDocument();
  const unresolvedCount = doc.annotations?.length || 0;

  console.log(`📄 ${doc.title || doc.filename || "Untitled"}`);
  console.log(`   ${doc.wordCount} words`);
  console.log(`   ${unresolvedCount} annotation${unresolvedCount !== 1 ? "s" : ""}`);

  if (doc.filepath) {
    console.log(`   ${doc.filepath}`);
  }

  if (unresolvedCount > 0) {
    console.log("\n📝 Annotations:");
    doc.annotations.forEach((ann, i) => {
      const preview = ann.text.slice(0, 40) + (ann.text.length > 40 ? "..." : "");
      const category = ann.category ? `[${ann.category}]` : "";
      console.log(`   ${i + 1}. ${category} "${preview}" - ${ann.comment}`);
    });
  }
}

function openInClaude() {
  const doc = loadDocument();

  if (!doc.annotations?.length) {
    console.log("No annotations to process. Add some feedback in Quill first.");
    process.exit(0);
  }

  const prompt = `${doc.prompt}

## Full Document Content

\`\`\`
${doc.content}
\`\`\``;

  console.log(`Opening Claude Code with ${doc.annotations.length} annotation(s)...`);

  const claude = spawn("claude", ["-p", prompt], { stdio: "inherit" });

  claude.on("error", (err) => {
    console.error("Failed to launch Claude Code:", err.message);
    process.exit(1);
  });
}

function humanize() {
  const doc = loadDocument();

  const prompt = `/compound-writing

## Document to Humanize

**File:** ${doc.filepath || doc.filename || doc.title}
**Word Count:** ${doc.wordCount}

### Author Annotations

${doc.annotations?.map((ann, i) => {
  const category = ann.category ? `[${ann.category}]` : "[General]";
  return `${i + 1}. ${category} "${ann.text.slice(0, 60)}${ann.text.length > 60 ? "..." : ""}"
   → ${ann.comment}`;
}).join("\n\n") || "No specific annotations"}

### Full Content

\`\`\`
${doc.content}
\`\`\`

Run the two-pass humanization system addressing the author's annotations.`;

  console.log(`Running compound-writing on "${doc.title || doc.filename}"...`);

  const claude = spawn("claude", ["-p", prompt], { stdio: "inherit" });
  claude.on("error", (err) => {
    console.error("Failed to launch Claude Code:", err.message);
    process.exit(1);
  });
}

function watch() {
  console.log("Watching ~/.quill/document.json for changes...");
  console.log("Press Ctrl+C to stop\n");

  let lastMtime = null;

  const check = () => {
    try {
      const stat = fs.statSync(DOC_PATH);
      const mtime = stat.mtime.getTime();

      if (lastMtime && mtime !== lastMtime) {
        const doc = loadDocument();
        const count = doc.annotations?.length || 0;

        try {
          execFileSync("osascript", [
            "-e",
            `display notification "${count} annotation(s) ready" with title "Quill Updated"`,
          ]);
        } catch {}

        console.log(
          `[${new Date().toLocaleTimeString()}] Document updated: ${count} annotation(s)`
        );
      }

      lastMtime = mtime;
    } catch {}
  };

  setInterval(check, 2000);
  check();
}

function copyPrompt() {
  const doc = loadDocument();
  const pbcopy = spawn("pbcopy", [], { stdio: ["pipe", "inherit", "inherit"] });
  pbcopy.stdin.write(doc.prompt);
  pbcopy.stdin.end();
  pbcopy.on("close", () => console.log("Prompt copied to clipboard"));
}

// Main
const command = process.argv[2] || "prompt";

switch (command) {
  case "prompt":
  case "show":
    showPrompt();
    break;
  case "status":
  case "info":
    showStatus();
    break;
  case "edit":
  case "claude":
    openInClaude();
    break;
  case "humanize":
  case "compound":
    humanize();
    break;
  case "watch":
    watch();
    break;
  case "copy":
    copyPrompt();
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(`Quill CLI - Bridge between Quill.app and Claude Code

Usage: quill.js [command]

Commands:
  (none)     Show current prompt from Quill
  status     Show document info and annotations
  edit       Open Claude Code with the prompt
  humanize   Run compound-writing humanization
  watch      Watch for changes and notify
  copy       Copy prompt to clipboard
  help       Show this help

Quill exports to ~/.quill/document.json on every save.
Use Cmd+Shift+E in Quill to force an export.`);
    break;
  default:
    console.error(`Unknown command: ${command}\nRun 'quill.js help' for usage`);
    process.exit(1);
}
