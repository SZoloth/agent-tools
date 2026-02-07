#!/usr/bin/env node

/**
 * job-next.js - Show next review-ready application packet and set review cursor.
 *
 * Usage:
 *   job-next.js
 *   job-next.js --queue-id q_job_li_12345
 *   job-next.js --json
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  buildReviewQueue,
  clearQueueSkipped,
  ensureJobPipeline,
  normalizePipelineEntriesInState,
  pickCurrentReviewItem,
  setCurrentQueueId,
} from "./job-pipeline-lib.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const STATE_PATH = path.join(HOME, ".claude/state/cos-state.json");
const CACHE_PATH = path.join(HOME, ".claude/state/job-listings-cache.json");
const APPLICATIONS_DIR = path.join(
  HOME,
  "Documents/LLM CONTEXT/1 - personal/job_search/Applications"
);
const RESUME_DIR = path.join(
  HOME,
  "Documents/LLM CONTEXT/1 - personal/job_search/resumes"
);

function parseArgs(argv) {
  const opts = {
    queueId: null,
    skipMigrate: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--queue-id" && argv[i + 1]) opts.queueId = argv[++i];
    else if (arg === "--skip-migrate") opts.skipMigrate = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }
  return opts;
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err.message}`);
  }
  return fallback;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function maybeMigrate() {
  try {
    execFileSync("node", [path.join(__dirname, "job-state-migrate.js"), "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch {
    // best effort
  }
}

function findLatestFile(folderPath, regex) {
  if (!folderPath || !fs.existsSync(folderPath)) return null;
  const entries = fs.readdirSync(folderPath)
    .filter((name) => regex.test(name))
    .map((name) => {
      const fullPath = path.join(folderPath, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0] || null;
}

function findCanonicalResume() {
  try {
    if (!fs.existsSync(RESUME_DIR)) return null;
    const files = fs.readdirSync(RESUME_DIR)
      .filter((name) => /^primary-general-resume-.*\.md$/i.test(name))
      .map((name) => {
        const fullPath = path.join(RESUME_DIR, name);
        return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch {
    return null;
  }
}

function coverPreview(content, lines = 12) {
  return String(content || "")
    .split("\n")
    .map((line) => line.trimRight())
    .filter((line, idx) => !(idx === 0 && line.startsWith("#")))
    .slice(0, lines)
    .join("\n")
    .trim();
}

function evaluateCover(content, company, title) {
  const text = String(content || "");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const issues = [];
  if (words < 120) issues.push("too_short");
  if (!text.includes("Sam Zoloth")) issues.push("missing_signature_name");
  if (!text.includes("smzoloth@gmail.com")) issues.push("missing_signature_email");
  if (company && !text.toLowerCase().includes(String(company).toLowerCase())) issues.push("missing_company_reference");
  if (title && !text.toLowerCase().includes(String(title).toLowerCase())) issues.push("missing_role_reference");
  if (/\bTBD\b/i.test(text) || /\bAdd one\b/i.test(text)) issues.push("contains_placeholder_text");
  return {
    wordCount: words,
    pass: issues.length === 0,
    issues,
  };
}

function normalizeLines(content) {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^---+$/.test(line))
    .map((line) => line.replace(/^[-*•]\s*/, "").trim());
}

function computeResumeDelta(tailored, canonical) {
  const tailoredLines = normalizeLines(tailored);
  const canonicalLines = normalizeLines(canonical);
  const canonicalSet = new Set(canonicalLines.map((line) => line.toLowerCase()));

  const additions = [];
  for (const line of tailoredLines) {
    const normalized = line.toLowerCase();
    if (line.length < 24) continue;
    if (canonicalSet.has(normalized)) continue;
    additions.push(line);
  }

  return {
    addedLineCount: additions.length,
    topAdditions: additions.slice(0, 5),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-next.js [--queue-id <id>] [--json] [--skip-migrate]");
    return;
  }

  if (!opts.skipMigrate) maybeMigrate();

  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensureJobPipeline(state);
  normalizePipelineEntriesInState(state);

  const reviewQueue = buildReviewQueue({
    state,
    cacheListings: cache.listings || {},
    applicationsDir: APPLICATIONS_DIR,
  });

  if (reviewQueue.length === 0) {
    const empty = {
      action: "job_next",
      hasItem: false,
      message: "No review-ready applications found.",
      nextActions: [
        { priority: 1, command: "/job autopilot \"company or listing url\"", reason: "fill review queue" },
      ],
    };
    if (opts.json) {
      console.log(JSON.stringify(empty, null, 2));
      return;
    }
    console.log("JOB NEXT");
    console.log("No review-ready applications found.");
    console.log("Next: /job autopilot \"company or listing url\"");
    return;
  }

  const current = pickCurrentReviewItem(state, reviewQueue, opts.queueId);
  if (!current) {
    console.error("Could not resolve current review item.");
    process.exit(1);
  }

  clearQueueSkipped(state, current.queueId);
  setCurrentQueueId(state, current.queueId);
  state.last_updated = new Date().toISOString();
  saveJson(STATE_PATH, state);

  const folderPath = current.folderName ? path.join(APPLICATIONS_DIR, current.folderName) : null;
  const coverFile = findLatestFile(folderPath, /^Cover_Letter_.*\.md$/i);
  const resumeFile = findLatestFile(folderPath, /^Resume_.*\.md$/i);
  const notesFile = folderPath ? path.join(folderPath, "Application_Research_Notes.md") : null;

  const coverContent = coverFile ? fs.readFileSync(coverFile.fullPath, "utf8") : "";
  const resumeContent = resumeFile ? fs.readFileSync(resumeFile.fullPath, "utf8") : "";
  const canonicalResume = findCanonicalResume();
  const canonicalContent = canonicalResume ? fs.readFileSync(canonicalResume.fullPath, "utf8") : "";
  const coverQuality = evaluateCover(coverContent, current.company, current.title);
  const resumeDelta = computeResumeDelta(resumeContent, canonicalContent);

  const packet = {
    queueId: current.queueId,
    stage: current.sourceBucket,
    company: current.company || null,
    title: current.title || null,
    score: current.score ?? null,
    jobId: current.jobId || null,
    folderName: current.folderName || null,
    files: {
      folderPath: folderPath || null,
      coverLetter: coverFile?.fullPath || null,
      resume: resumeFile?.fullPath || null,
      notes: notesFile && fs.existsSync(notesFile) ? notesFile : null,
    },
    coverLetter: {
      quality: coverQuality,
      preview: coverPreview(coverContent),
    },
    resume: {
      canonicalPath: canonicalResume?.fullPath || null,
      tailoredPath: resumeFile?.fullPath || null,
      delta: resumeDelta,
    },
    commands: [
      "/job approve",
      "/job revise \"what to improve\"",
      "/job skip",
      "/job reject \"reason\"",
    ],
  };

  const result = {
    action: "job_next",
    hasItem: true,
    queueSize: reviewQueue.length,
    packet,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("JOB NEXT");
  console.log(`Queue ID: ${packet.queueId}`);
  console.log(`Role: ${packet.company || "(unknown)"} - ${packet.title || "(unknown)"}`);
  console.log(`Score: ${packet.score ?? "N/A"} | Stage: ${packet.stage}`);
  console.log(`Folder: ${packet.folderName || "(none)"}`);
  console.log(`Cover quality: ${packet.coverLetter.quality.pass ? "PASS" : "NEEDS EDIT"} (${packet.coverLetter.quality.wordCount} words)`);
  if (packet.coverLetter.quality.issues.length > 0) {
    console.log(`Quality issues: ${packet.coverLetter.quality.issues.join(", ")}`);
  }
  if (packet.resume.delta.topAdditions.length > 0) {
    console.log("Resume deltas:");
    for (const line of packet.resume.delta.topAdditions.slice(0, 3)) {
      console.log(`  - ${line}`);
    }
  }
  console.log("");
  console.log("Cover letter preview:");
  console.log(packet.coverLetter.preview || "(no cover letter found)");
  console.log("");
  console.log("Commands:");
  for (const command of packet.commands) {
    console.log(`  ${command}`);
  }
}

main();

