#!/usr/bin/env node

/**
 * job-backlog.js - Review backlog with explicit human-review queue.
 *
 * Focuses on:
 *  - ready_for_human_review (materials written, waiting approval/submission)
 *  - awaiting_writing (prepped/pending without drafts)
 *  - submitted
 *
 * Usage:
 *   job-backlog.js
 *   job-backlog.js --json
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  ensureJobPipeline,
  normalizePipelineEntriesInState,
  withQueueId,
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

function parseArgs(argv) {
  return {
    skipMigrate: argv.includes("--skip-migrate"),
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err.message}`);
  }
  return fallback;
}

function ensurePipeline(state) {
  ensureJobPipeline(state);
  normalizePipelineEntriesInState(state);
}

function fileSignals(folderName) {
  if (!folderName) return { folderPath: null, exists: false, coverLetter: false, resume: false, notes: false };
  const folderPath = path.join(APPLICATIONS_DIR, folderName);
  if (!fs.existsSync(folderPath)) {
    return { folderPath, exists: false, coverLetter: false, resume: false, notes: false };
  }
  const files = fs.readdirSync(folderPath);
  return {
    folderPath,
    exists: true,
    coverLetter: files.some((f) => /^Cover_Letter_.*\.md$/i.test(f)),
    resume: files.some((f) => /^Resume_.*\.md$/i.test(f)),
    notes: files.includes("Application_Research_Notes.md"),
  };
}

function resolveListing(cacheListings, entry) {
  if (entry.jobId && cacheListings[String(entry.jobId)]) {
    return { jobId: String(entry.jobId), listing: cacheListings[String(entry.jobId)] };
  }
  if (entry.folderName) {
    const jobId = Object.keys(cacheListings).find(
      (id) => cacheListings[id]?.applicationFolder === entry.folderName
    );
    if (jobId) return { jobId, listing: cacheListings[jobId] };
  }
  return { jobId: entry.jobId || null, listing: null };
}

function toBacklogRecord(index, entry, cacheListings, stage) {
  const normalized = withQueueId(entry);
  const { jobId, listing } = resolveListing(cacheListings, normalized);
  const files = fileSignals(entry.folderName);
  return {
    index,
    stage,
    queueId: normalized.queueId || null,
    jobId,
    folderName: normalized.folderName || listing?.applicationFolder || null,
    company: normalized.company || listing?.company || null,
    title: normalized.title || listing?.title || null,
    score: normalized.score ?? listing?.score ?? null,
    status: listing?.status || null,
    files,
    waitingHumanReview: files.coverLetter && files.resume,
    submissionChannel: listing?.submissionChannel || normalized.submissionChannel || null,
    submittedAt: listing?.appliedAt || normalized.submittedAt || null,
    followupTaskId: listing?.followupTaskId || normalized.followupTaskId || null,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-backlog.js [--json] [--skip-migrate]");
    return;
  }

  if (!opts.skipMigrate) {
    try {
      execFileSync("node", [path.join(__dirname, "job-state-migrate.js"), "--json"], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60000,
      });
    } catch {
      // Continue with best-effort state read.
    }
  }

  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensurePipeline(state);
  const listings = cache.listings || {};

  const pending = state.job_pipeline.pending_materials.map((entry, i) =>
    toBacklogRecord(i + 1, entry, listings, "pending_materials")
  );
  const ready = state.job_pipeline.materials_ready.map((entry, i) =>
    toBacklogRecord(i + 1, entry, listings, "materials_ready")
  );
  const submitted = state.job_pipeline.submitted_applications.map((entry, i) =>
    toBacklogRecord(i + 1, entry, listings, "submitted_applications")
  );

  const readyForHumanReview = [...ready, ...pending.filter((r) => r.waitingHumanReview)];
  const awaitingWriting = pending.filter((r) => !r.waitingHumanReview);
  const qualifiedUnprepped = Object.entries(listings).filter(
    ([_, l]) => l.status === "qualified" && !l.applicationFolder
  ).length;

  const result = {
    action: "backlog_review",
    summary: {
      totalListings: Object.keys(listings).length,
      qualifiedUnprepped,
      awaitingWriting: awaitingWriting.length,
      readyForHumanReview: readyForHumanReview.length,
      submitted: submitted.length,
    },
    reviewCursor: {
      currentQueueId: state.job_pipeline.review?.currentQueueId || null,
      skippedQueueIds: state.job_pipeline.review?.skippedQueueIds || [],
    },
    queues: {
      awaitingWriting,
      readyForHumanReview,
      submitted,
    },
    nextActions: [
      awaitingWriting.length > 0
        ? { priority: 1, command: "/job generate 1", reason: `${awaitingWriting.length} pending items need drafts` }
        : null,
      readyForHumanReview.length > 0
        ? { priority: 2, command: "/job next", reason: `${readyForHumanReview.length} written items await human approval` }
        : null,
      qualifiedUnprepped > 0
        ? { priority: 3, command: "/job run --backfill", reason: `${qualifiedUnprepped} qualified items still unprepped` }
        : null,
    ].filter(Boolean),
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("JOB BACKLOG");
  console.log(`Ready for human review: ${result.summary.readyForHumanReview}`);
  console.log(`Awaiting writing: ${result.summary.awaitingWriting}`);
  console.log(`Submitted: ${result.summary.submitted}`);
  console.log(`Qualified unprepped: ${result.summary.qualifiedUnprepped}`);
  if (result.nextActions.length > 0) {
    console.log("");
    console.log("Next actions:");
    for (const action of result.nextActions) {
      console.log(`  ${action.priority}. ${action.command}  # ${action.reason}`);
    }
  }
}

main();
