#!/usr/bin/env node

/**
 * bd-session.js - Detect beads issues touched in current session
 *
 * Scans for:
 * 1. Issues created/modified today
 * 2. Issue IDs mentioned in provided text (stdin or --text)
 * 3. bd commands in shell history (optional)
 *
 * Usage:
 *   bd-session                      # Show issues created/modified today
 *   bd-session --text "worked on personal-abc"  # Find mentioned issue IDs
 *   bd-session --json               # JSON output for scripting
 *   bd-session --link <diary-path>  # Add issues to diary file
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// Parse arguments
const args = process.argv.slice(2);
let jsonOutput = false;
let textToScan = null;
let diaryPath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--json") jsonOutput = true;
  if (args[i] === "--text" && args[i + 1]) textToScan = args[++i];
  if (args[i] === "--link" && args[i + 1]) diaryPath = args[++i];
}

// Beads issue ID pattern: prefix-xxx (3 alphanumeric chars)
const ISSUE_PATTERN = /\b([a-zA-Z]+-[a-zA-Z0-9]{2,4})\b/g;

// Known beads prefixes (workspaces)
const KNOWN_PREFIXES = ["personal", "dwa", "llm", "ideas", "vault"];

// Known beads directories to search
const BEADS_DIRS = [
  path.join(process.env.HOME, "Documents/LLM CONTEXT/1 - personal"),
  path.join(process.env.HOME, "Documents/LLM CONTEXT"),
  path.join(process.env.HOME, ".beads"),
  path.join(process.env.HOME, "ideas"),
];

/**
 * Get issues created or closed today
 */
function getTodayIssues() {
  // Use local date, not UTC
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const issues = [];

  // Try each beads directory
  for (const dir of BEADS_DIRS) {
    if (!fs.existsSync(path.join(dir, ".beads"))) continue;

    try {
      // Get issues created today
      const created = execSync(`bd list --created-after "${today}" --limit 50 2>/dev/null`, {
        encoding: "utf8",
        cwd: dir,
      }).trim();

      if (created) {
        for (const line of created.split("\n")) {
          const match = line.match(/([a-zA-Z]+-[a-zA-Z0-9]+)/);
          if (match) {
            const status = line.startsWith("●") ? "closed" : "open";
            const titleMatch = line.match(/\] - (.+)$/);
            // Check if already in list (from another directory)
            if (!issues.find((i) => i.id === match[1])) {
              issues.push({
                id: match[1],
                status,
                action: "created",
                title: titleMatch ? titleMatch[1].trim() : "",
              });
            }
          }
        }
      }
    } catch (e) {
      // bd command failed for this directory, continue
    }

    try {
      // Get issues closed today
      const closed = execSync(`bd list --closed-after "${today}" --all --limit 50 2>/dev/null`, {
        encoding: "utf8",
        cwd: dir,
      }).trim();

      if (closed) {
        for (const line of closed.split("\n")) {
          const match = line.match(/([a-zA-Z]+-[a-zA-Z0-9]+)/);
          if (match) {
            // Check if already in list
            const existing = issues.find((i) => i.id === match[1]);
            if (existing) {
              existing.action = "created+closed";
            } else {
              const titleMatch = line.match(/\] - (.+)$/);
              issues.push({
                id: match[1],
                status: "closed",
                action: "closed",
                title: titleMatch ? titleMatch[1].trim() : "",
              });
            }
          }
        }
      }
    } catch (e) {
      // bd command failed for this directory, continue
    }
  }

  return issues;
}

/**
 * Extract issue IDs from text
 */
function extractIssueIds(text) {
  const ids = new Set();
  let match;

  while ((match = ISSUE_PATTERN.exec(text)) !== null) {
    const id = match[1].toLowerCase();
    const prefix = id.split("-")[0];

    // Only include if it looks like a beads ID
    if (KNOWN_PREFIXES.includes(prefix) || id.match(/^[a-z]+-[a-z0-9]{3}$/)) {
      ids.add(match[1]);
    }
  }

  return Array.from(ids);
}

/**
 * Look up issue details by ID
 */
function getIssueDetails(issueId) {
  try {
    const output = execSync(`bd show ${issueId} 2>/dev/null`, {
      encoding: "utf8",
    }).trim();

    const titleMatch = output.match(/Title:\s*(.+)/);
    const statusMatch = output.match(/Status:\s*(\w+)/);

    return {
      id: issueId,
      title: titleMatch ? titleMatch[1].trim() : "",
      status: statusMatch ? statusMatch[1].toLowerCase() : "unknown",
    };
  } catch (e) {
    return { id: issueId, title: "", status: "unknown" };
  }
}

/**
 * Add issues section to diary file
 */
function linkToDiary(diaryPath, issues) {
  if (!fs.existsSync(diaryPath)) {
    console.error(`Diary file not found: ${diaryPath}`);
    process.exit(1);
  }

  let content = fs.readFileSync(diaryPath, "utf8");

  // Check if Issues section already exists
  if (content.includes("## Issues Worked On")) {
    console.log("Issues section already exists in diary");
    return;
  }

  // Build issues section
  const issueLines = issues.map((i) => {
    const statusIcon = i.status === "closed" ? "●" : "○";
    const action = i.action ? ` [${i.action}]` : "";
    return `- ${statusIcon} ${i.id}${action}: ${i.title || "(no title)"}`;
  });

  const issuesSection = `
## Issues Worked On
${issueLines.length > 0 ? issueLines.join("\n") : "- No beads issues detected"}
`;

  // Insert after Task Summary or at the beginning
  const insertPoint = content.indexOf("## Work Summary");
  if (insertPoint > 0) {
    content = content.slice(0, insertPoint) + issuesSection + "\n" + content.slice(insertPoint);
  } else {
    // Fallback: append
    content += issuesSection;
  }

  fs.writeFileSync(diaryPath, content);
  console.log(`Added ${issues.length} issues to diary`);
}

// Main
function main() {
  let issues = [];

  // Always get today's issues
  const todayIssues = getTodayIssues();
  issues.push(...todayIssues);

  // If text provided, scan for additional issue IDs
  if (textToScan) {
    const mentionedIds = extractIssueIds(textToScan);
    for (const id of mentionedIds) {
      if (!issues.find((i) => i.id === id)) {
        const details = getIssueDetails(id);
        issues.push({ ...details, action: "mentioned" });
      }
    }
  }

  // Read from stdin if available
  if (!process.stdin.isTTY) {
    try {
      const stdin = fs.readFileSync(0, "utf8");
      const mentionedIds = extractIssueIds(stdin);
      for (const id of mentionedIds) {
        if (!issues.find((i) => i.id === id)) {
          const details = getIssueDetails(id);
          issues.push({ ...details, action: "mentioned" });
        }
      }
    } catch (e) {
      // No stdin, continue
    }
  }

  // Link to diary if requested
  if (diaryPath) {
    linkToDiary(diaryPath, issues);
    return;
  }

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(issues, null, 2));
  } else {
    if (issues.length === 0) {
      console.log("No beads issues detected for this session");
    } else {
      console.log(`\n${"═".repeat(60)}`);
      console.log("  ISSUES WORKED ON THIS SESSION");
      console.log(`${"═".repeat(60)}\n`);

      for (const issue of issues) {
        const statusIcon = issue.status === "closed" ? "●" : "○";
        const action = issue.action ? `[${issue.action}]` : "";
        console.log(`  ${statusIcon} ${issue.id} ${action}`);
        if (issue.title) {
          console.log(`    ${issue.title}`);
        }
      }

      console.log(`\n${"─".repeat(60)}`);
      console.log(`  Total: ${issues.length} issues`);
      console.log(`${"─".repeat(60)}\n`);
    }
  }
}

main();
