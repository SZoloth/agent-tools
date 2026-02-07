#!/usr/bin/env node

/**
 * job-followup-sync.js - Create follow-up tasks for overdue submitted applications.
 *
 * Usage:
 *   job-followup-sync.js
 *   job-followup-sync.js --days 7 --json
 *   job-followup-sync.js --dry-run --json
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const HOME = process.env.HOME;
const STATE_PATH = path.join(HOME, ".claude/state/cos-state.json");
const CACHE_PATH = path.join(HOME, ".claude/state/job-listings-cache.json");
const BEADS_CWD = path.join(HOME, "Documents/LLM CONTEXT/1 - personal");

function parseArgs(argv) {
  const opts = {
    days: 7,
    dryRun: false,
    skipBeads: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days" && argv[i + 1]) opts.days = Math.max(1, Number(argv[++i]));
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }

  return opts;
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err.message}`);
  }
  return fallback;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function ensurePipeline(state) {
  if (!state.job_pipeline) state.job_pipeline = {};
  if (!Array.isArray(state.job_pipeline.submitted_applications)) {
    state.job_pipeline.submitted_applications = [];
  }
}

function parseSubmittedDate(entry) {
  const raw = entry.submittedDate || entry.submittedAt || entry.appliedAt || null;
  if (!raw) return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function formatYmd(date) {
  return date.toISOString().split("T")[0];
}

function createFollowupIssue(entry, dueDateYmd, opts) {
  if (opts.skipBeads) return { ok: false, skipped: true, reason: "skip-beads" };

  const company = String(entry.company || "Unknown Company").trim();
  const submittedDate = entry.submittedDate || (entry.submittedAt ? String(entry.submittedAt).split("T")[0] : "unknown date");
  const title = `Follow up with ${company} recruiter`;
  const description = `Application submitted ${submittedDate}. No response yet. Check LinkedIn for recruiter contact and send follow-up.`;
  const notes = `Folder: ${entry.folderName || "unknown"}. Role: ${entry.title || "unknown"}.`;

  try {
    const output = execFileSync(
      "bd",
      [
        "create",
        title,
        "-l",
        "job search task",
        "-p",
        "P2",
        "--due",
        "+1d",
        "-d",
        description,
        "--notes",
        notes,
        "--silent",
      ],
      {
        cwd: BEADS_CWD,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const issueId = output.trim().split("\n").pop();
    if (!issueId) {
      return { ok: false, skipped: false, reason: "empty issue id from bd create" };
    }
    return { ok: true, skipped: false, issueId, dueDate: dueDateYmd };
  } catch (err) {
    return { ok: false, skipped: false, reason: err.message };
  }
}

function findListingId(cacheListings, entry) {
  if (entry.jobId && cacheListings[String(entry.jobId)]) return String(entry.jobId);
  if (entry.folderName) {
    return (
      Object.keys(cacheListings).find(
        (jobId) => cacheListings[jobId]?.applicationFolder === entry.folderName
      ) || null
    );
  }
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-followup-sync.js [--days N] [--dry-run] [--skip-beads] [--json]");
    return;
  }

  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensurePipeline(state);
  const listings = cache.listings || {};

  const today = new Date();
  const dueCandidates = [];
  const created = [];
  const skipped = [];
  const errors = [];

  for (let i = 0; i < state.job_pipeline.submitted_applications.length; i++) {
    const entry = state.job_pipeline.submitted_applications[i];
    if (entry.followupTaskId || entry.followupCreatedAt) {
      skipped.push({ index: i, jobId: entry.jobId || null, reason: "already-tracked" });
      continue;
    }

    const submittedDate = parseSubmittedDate(entry);
    if (!submittedDate) {
      skipped.push({ index: i, jobId: entry.jobId || null, reason: "missing-submitted-date" });
      continue;
    }

    const dueDate = new Date(submittedDate.getTime() + opts.days * 24 * 60 * 60 * 1000);
    if (dueDate > today) {
      skipped.push({
        index: i,
        jobId: entry.jobId || null,
        reason: "not-due",
        dueDate: formatYmd(dueDate),
      });
      continue;
    }

    dueCandidates.push({ index: i, entry, dueDate });
  }

  for (const candidate of dueCandidates) {
    const { index, entry, dueDate } = candidate;
    const dueDateYmd = formatYmd(dueDate);

    if (opts.dryRun) {
      created.push({
        index,
        jobId: entry.jobId || null,
        company: entry.company || null,
        dryRun: true,
        dueDate: dueDateYmd,
      });
      continue;
    }

    const issue = createFollowupIssue(entry, dueDateYmd, opts);
    if (!issue.ok) {
      if (issue.skipped) {
        skipped.push({
          index,
          jobId: entry.jobId || null,
          reason: issue.reason,
          dueDate: dueDateYmd,
        });
      } else {
        errors.push({
          index,
          jobId: entry.jobId || null,
          reason: issue.reason,
          dueDate: dueDateYmd,
        });
      }
      continue;
    }

    state.job_pipeline.submitted_applications[index] = {
      ...entry,
      followupTaskId: issue.issueId,
      followupDueDate: dueDateYmd,
      followupCreatedAt: new Date().toISOString(),
    };

    const listingId = findListingId(listings, entry);
    if (listingId) {
      const listing = listings[listingId];
      listing.followupTaskId = issue.issueId;
      listing.followupDueDate = dueDateYmd;
      listing.followupCreatedAt = new Date().toISOString();
    }

    created.push({
      index,
      jobId: entry.jobId || null,
      company: entry.company || null,
      issueId: issue.issueId,
      dueDate: dueDateYmd,
    });
  }

  if (!opts.dryRun) {
    const nowIso = new Date().toISOString();
    state.last_updated = nowIso;
    cache.lastUpdated = nowIso;
    saveJson(STATE_PATH, state);
    saveJson(CACHE_PATH, cache);
  }

  const result = {
    action: "followup_sync",
    dryRun: opts.dryRun,
    days: opts.days,
    skipBeads: opts.skipBeads,
    submittedCount: state.job_pipeline.submitted_applications.length,
    dueCandidates: dueCandidates.length,
    createdCount: created.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    created,
    skipped,
    errors,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("FOLLOW-UP SYNC COMPLETE");
  console.log(`Submitted applications: ${result.submittedCount}`);
  console.log(`Due candidates: ${result.dueCandidates}`);
  console.log(`Follow-ups created: ${result.createdCount}`);
  if (result.skippedCount > 0) console.log(`Skipped: ${result.skippedCount}`);
  if (result.errorCount > 0) console.log(`Errors: ${result.errorCount}`);
}

main();
