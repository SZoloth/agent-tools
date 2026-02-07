#!/usr/bin/env node

/**
 * job-state-migrate.js - Normalize cache + pipeline state to canonical lifecycle.
 *
 * Canonical listing statuses:
 *   new -> qualified -> prepped -> materials_ready -> applied -> archived
 *
 * Usage:
 *   job-state-migrate.js
 *   job-state-migrate.js --dry-run --json
 */

import fs from "fs";
import path from "path";
import {
  dedupePipelineEntries,
  ensureJobPipeline,
  withQueueId,
  queueIdForEntry,
} from "./job-pipeline-lib.js";

const CACHE_PATH = path.join(
  process.env.HOME,
  ".claude/state/job-listings-cache.json"
);
const COS_STATE_PATH = path.join(
  process.env.HOME,
  ".claude/state/cos-state.json"
);

const CANONICAL_STATUSES = new Set([
  "new",
  "qualified",
  "below_threshold",
  "prepped",
  "materials_ready",
  "applied",
  "archived",
]);

function parseArgs(argv) {
  const opts = {
    threshold: 70,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--threshold" && argv[i + 1]) opts.threshold = Number(argv[++i]);
    else if (arg === "--dry-run") opts.dryRun = true;
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

function normalizeStatus(listing, threshold) {
  const current = String(listing.status || "").trim().toLowerCase();

  const mappedLegacy = {
    application_folder_created: "prepped",
    researched: listing.applicationFolder ? "prepped" : "qualified",
    rejected: "archived",
    closed: "archived",
  };
  if (mappedLegacy[current]) return mappedLegacy[current];

  if (CANONICAL_STATUSES.has(current)) {
    if (current === "qualified" && listing.applicationFolder) return "prepped";
    return current;
  }

  if (listing.applicationFolder) return "prepped";
  if (listing.score === null || listing.score === undefined) return "new";
  return Number(listing.score) >= threshold ? "qualified" : "below_threshold";
}

function entryKey(entry) {
  if (entry?.jobId) return `job:${entry.jobId}`;
  if (entry?.folderName) return `folder:${entry.folderName}`;
  if (entry?.company && entry?.title) return `ct:${entry.company}|${entry.title}`;
  return null;
}

function findListingId(listings, entry) {
  if (!entry) return null;
  if (entry.jobId && listings[String(entry.jobId)]) return String(entry.jobId);
  if (entry.folderName) {
    const byFolder = Object.keys(listings).find(
      (jobId) => listings[jobId]?.applicationFolder === entry.folderName
    );
    if (byFolder) return byFolder;
  }
  if (entry.company && entry.title) {
    const normCompany = String(entry.company).toLowerCase().trim();
    const normTitle = String(entry.title).toLowerCase().trim();
    return (
      Object.keys(listings).find((jobId) => {
        const l = listings[jobId];
        return (
          String(l.company || "").toLowerCase().trim() === normCompany &&
          String(l.title || "").toLowerCase().trim() === normTitle
        );
      }) || null
    );
  }
  return null;
}

function toPipelineEntry(jobId, listing, stage) {
  const base = {
    folderName: listing.applicationFolder || null,
    company: listing.company || null,
    title: listing.title || null,
    jobId: String(jobId),
    queueId: listing.queueId || queueIdForEntry({ jobId: String(jobId), folderName: listing.applicationFolder }),
    score: listing.score ?? null,
    beadsIssueId: listing.beadsIssueId ?? null,
  };

  const nowIso = new Date().toISOString();
  if (stage === "pending") {
    return {
      ...base,
      createdAt: listing.preppedAt || nowIso,
    };
  }
  if (stage === "ready") {
    return {
      ...base,
      createdAt: listing.preppedAt || nowIso,
      materialsReadyAt: listing.materialsReadyAt || nowIso,
      materialsReadyDate: listing.materialsReadyAt
        ? String(listing.materialsReadyAt).split("T")[0]
        : String(nowIso).split("T")[0],
      readyChannel: listing.readyChannel || "generated",
    };
  }
  return {
    ...base,
    createdAt: listing.preppedAt || nowIso,
    submittedAt: listing.appliedAt || nowIso,
    submittedDate: listing.appliedAt
      ? String(listing.appliedAt).split("T")[0]
      : String(nowIso).split("T")[0],
    submissionChannel: listing.submissionChannel || "LinkedIn",
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-state-migrate.js [--threshold N] [--dry-run] [--json]");
    return;
  }

  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  const state = loadJson(COS_STATE_PATH, { version: "1.0", job_pipeline: {} });
  ensureJobPipeline(state);

  const listings = cache.listings || {};
  const before = {
    listingCount: Object.keys(listings).length,
    statusCounts: {},
    pending_materials: state.job_pipeline.pending_materials.length,
    materials_ready: state.job_pipeline.materials_ready.length,
    submitted_applications: state.job_pipeline.submitted_applications.length,
  };

  for (const listing of Object.values(listings)) {
    const status = String(listing.status || "unknown");
    before.statusCounts[status] = (before.statusCounts[status] || 0) + 1;
  }

  let listingStatusChanges = 0;
  const normalizedFromLegacy = {};

  for (const [jobId, listing] of Object.entries(listings)) {
    const next = normalizeStatus(listing, opts.threshold);
    if (listing.status !== next) {
      normalizedFromLegacy[`${listing.status || "undefined"}->${next}`] =
        (normalizedFromLegacy[`${listing.status || "undefined"}->${next}`] || 0) + 1;
      listing.status = next;
      listingStatusChanges++;
    }
    if (listing.jobId === undefined || listing.jobId === null) {
      listing.jobId = jobId;
    }
    if (!listing.queueId) {
      listing.queueId = queueIdForEntry({ jobId: String(jobId), folderName: listing.applicationFolder });
    }
  }

  const rawPending = dedupePipelineEntries(state.job_pipeline.pending_materials).map(withQueueId);
  const rawReady = dedupePipelineEntries(state.job_pipeline.materials_ready).map(withQueueId);
  const rawSubmitted = dedupePipelineEntries(state.job_pipeline.submitted_applications).map(withQueueId);

  const submittedKeys = new Set(rawSubmitted.map((e) => entryKey(e)).filter(Boolean));
  const readyKeys = new Set(rawReady.map((e) => entryKey(e)).filter(Boolean));

  const pending = rawPending.filter((e) => {
    const key = entryKey(e);
    if (!key) return true;
    return !submittedKeys.has(key) && !readyKeys.has(key);
  });
  const ready = rawReady.filter((e) => {
    const key = entryKey(e);
    if (!key) return true;
    return !submittedKeys.has(key);
  });
  const submitted = rawSubmitted;

  let pipelineFilled = 0;
  const knownKeys = new Set([
    ...pending.map((e) => entryKey(e)).filter(Boolean),
    ...ready.map((e) => entryKey(e)).filter(Boolean),
    ...submitted.map((e) => entryKey(e)).filter(Boolean),
  ]);

  for (const [jobId, listing] of Object.entries(listings)) {
    if (!listing.applicationFolder) continue;

    const key = `job:${jobId}`;
    if (knownKeys.has(key)) continue;

    if (listing.status === "prepped") {
      pending.push(toPipelineEntry(jobId, listing, "pending"));
      knownKeys.add(key);
      pipelineFilled++;
    } else if (listing.status === "materials_ready") {
      ready.push(toPipelineEntry(jobId, listing, "ready"));
      knownKeys.add(key);
      pipelineFilled++;
    } else if (listing.status === "applied") {
      submitted.push(toPipelineEntry(jobId, listing, "submitted"));
      knownKeys.add(key);
      pipelineFilled++;
    }
  }

  for (const entry of pending) {
    const jobId = findListingId(listings, entry);
    if (!jobId) continue;
    const listing = listings[jobId];
    listing.status = "prepped";
    if (!listing.applicationFolder && entry.folderName) listing.applicationFolder = entry.folderName;
    if (!listing.beadsIssueId && entry.beadsIssueId) listing.beadsIssueId = entry.beadsIssueId;
  }
  for (const entry of ready) {
    const jobId = findListingId(listings, entry);
    if (!jobId) continue;
    const listing = listings[jobId];
    listing.status = "materials_ready";
    if (!listing.applicationFolder && entry.folderName) listing.applicationFolder = entry.folderName;
    if (!listing.beadsIssueId && entry.beadsIssueId) listing.beadsIssueId = entry.beadsIssueId;
    if (!listing.materialsReadyAt && entry.materialsReadyAt) listing.materialsReadyAt = entry.materialsReadyAt;
  }
  for (const entry of submitted) {
    const jobId = findListingId(listings, entry);
    if (!jobId) continue;
    const listing = listings[jobId];
    listing.status = "applied";
    if (!listing.applicationFolder && entry.folderName) listing.applicationFolder = entry.folderName;
    if (!listing.beadsIssueId && entry.beadsIssueId) listing.beadsIssueId = entry.beadsIssueId;
    if (!listing.appliedAt && entry.submittedAt) listing.appliedAt = entry.submittedAt;
    if (!listing.submissionChannel && entry.submissionChannel) listing.submissionChannel = entry.submissionChannel;
  }

  state.job_pipeline.pending_materials = dedupePipelineEntries(pending).map(withQueueId);
  state.job_pipeline.materials_ready = dedupePipelineEntries(ready).map(withQueueId);
  state.job_pipeline.submitted_applications = dedupePipelineEntries(submitted).map(withQueueId);

  const afterStatusCounts = {};
  for (const listing of Object.values(listings)) {
    const status = String(listing.status || "unknown");
    afterStatusCounts[status] = (afterStatusCounts[status] || 0) + 1;
  }

  const nowIso = new Date().toISOString();
  if (!opts.dryRun) {
    cache.lastUpdated = nowIso;
    state.last_updated = nowIso;
    saveJson(CACHE_PATH, cache);
    saveJson(COS_STATE_PATH, state);
  }

  const result = {
    action: "state_migrate",
    dryRun: opts.dryRun,
    threshold: opts.threshold,
    listingStatusChanges,
    normalizedFromLegacy,
    pipelineFilledFromCache: pipelineFilled,
    before,
    after: {
      listingCount: Object.keys(listings).length,
      statusCounts: afterStatusCounts,
      pending_materials: state.job_pipeline.pending_materials.length,
      materials_ready: state.job_pipeline.materials_ready.length,
      submitted_applications: state.job_pipeline.submitted_applications.length,
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("JOB STATE MIGRATION COMPLETE");
  console.log(`Listing status changes: ${listingStatusChanges}`);
  console.log(`Pipeline entries backfilled: ${pipelineFilled}`);
  console.log(`Pending materials: ${before.pending_materials} -> ${result.after.pending_materials}`);
  console.log(`Materials ready: ${before.materials_ready} -> ${result.after.materials_ready}`);
  console.log(`Submitted applications: ${before.submitted_applications} -> ${result.after.submitted_applications}`);
}

main();
