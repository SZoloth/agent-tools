#!/usr/bin/env node

/**
 * job-materials-ready.js - Move an application from pending_materials to materials_ready.
 *
 * Usage:
 *   job-materials-ready.js 1
 *   job-materials-ready.js --folder 48-stripe
 *   job-materials-ready.js --job-id 4338838020
 *   job-materials-ready.js --company "Stripe"
 *
 * Options:
 *   --channel <name>   Source channel note (default: generated)
 *   --date <YYYY-MM-DD>
 *   --skip-beads
 *   --dry-run
 *   --json
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  dedupePipelineEntries,
  ensureJobPipeline,
  queueIdForEntry,
  samePipelineEntry,
  withQueueId,
} from "./job-pipeline-lib.js";

const HOME = process.env.HOME;
const STATE_PATH = path.join(HOME, ".claude/state/cos-state.json");
const CACHE_PATH = path.join(HOME, ".claude/state/job-listings-cache.json");
const APPLICATIONS_DIR = path.join(
  HOME,
  "Documents/LLM CONTEXT/1 - personal/job_search/Applications"
);
const BEADS_CWD = path.join(HOME, "Documents/LLM CONTEXT/1 - personal");

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
  ensureJobPipeline(state);
}

function parseArgs(argv) {
  const opts = {
    target: null,
    folder: null,
    jobId: null,
    queueId: null,
    company: null,
    channel: "generated",
    date: new Date().toISOString().split("T")[0],
    skipBeads: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--folder" && argv[i + 1]) opts.folder = argv[++i];
    else if (arg === "--job-id" && argv[i + 1]) opts.jobId = argv[++i];
    else if (arg === "--queue-id" && argv[i + 1]) opts.queueId = argv[++i];
    else if (arg === "--company" && argv[i + 1]) opts.company = argv[++i];
    else if (arg === "--channel" && argv[i + 1]) opts.channel = argv[++i];
    else if (arg === "--date" && argv[i + 1]) opts.date = argv[++i];
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && !opts.target) opts.target = arg;
  }

  return opts;
}

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

function sameEntry(a, b) {
  return samePipelineEntry(a, b);
}

function resolveFromPending(pending, opts) {
  if (opts.folder) {
    const idx = pending.findIndex((e) => e.folderName === opts.folder);
    return idx >= 0 ? { index: idx, entry: pending[idx], reason: "folder" } : null;
  }
  if (opts.jobId) {
    const idx = pending.findIndex((e) => String(e.jobId) === String(opts.jobId));
    return idx >= 0 ? { index: idx, entry: pending[idx], reason: "job-id" } : null;
  }
  if (opts.queueId) {
    const idx = pending.findIndex((e) => String(e.queueId || "") === String(opts.queueId));
    return idx >= 0 ? { index: idx, entry: pending[idx], reason: "queue-id" } : null;
  }
  if (opts.company) {
    const companyNorm = normalize(opts.company);
    const idx = pending.findIndex((e) => normalize(e.company).includes(companyNorm));
    return idx >= 0 ? { index: idx, entry: pending[idx], reason: "company" } : null;
  }
  if (opts.target && /^\d+$/.test(opts.target)) {
    const index = Number(opts.target) - 1;
    if (index >= 0 && index < pending.length) {
      return { index, entry: pending[index], reason: "index" };
    }
  }
  if (opts.target) {
    const targetNorm = normalize(opts.target);
    const idx = pending.findIndex(
      (e) =>
        e.folderName === opts.target ||
        String(e.jobId || "") === opts.target ||
        normalize(e.company).includes(targetNorm)
    );
    return idx >= 0 ? { index: idx, entry: pending[idx], reason: "target" } : null;
  }
  return null;
}

function updateTrackingInNotes(notesPath, date, channel) {
  if (!fs.existsSync(notesPath)) return false;
  let content = fs.readFileSync(notesPath, "utf8");

  if (/^\*\*Application Status:\*\*.*$/m.test(content)) {
    content = content.replace(
      /^\*\*Application Status:\*\*.*$/m,
      `**Application Status:** MATERIALS READY - Awaiting Submission (${date})`
    );
  }

  if (/^\*\*Status:\*\*.*$/m.test(content)) {
    content = content.replace(
      /^\*\*Status:\*\*.*$/m,
      `**Status:** Materials ready (${date})`
    );
  }

  if (/^\*\*Materials Generated:\*\*.*$/m.test(content)) {
    content = content.replace(
      /^\*\*Materials Generated:\*\*.*$/m,
      `**Materials Generated:** ${date}`
    );
  } else if (/^\*\*Status:\*\*.*$/m.test(content)) {
    content = content.replace(
      /^\*\*Status:\*\*.*$/m,
      (m) => `${m}\n**Materials Generated:** ${date}`
    );
  }

  const noteLine = `**${date}:** Materials generated and moved to materials_ready (${channel}).`;
  if (/## Notes & Updates/m.test(content) && !content.includes(noteLine)) {
    content = content.replace(/## Notes & Updates\n/, `## Notes & Updates\n\n${noteLine}\n`);
  }

  fs.writeFileSync(notesPath, content);
  return true;
}

function maybeCommentBeads(folderName, date, skipBeads) {
  if (skipBeads) return { attempted: false, ok: true, reason: "skipped" };
  const beadsPath = path.join(APPLICATIONS_DIR, folderName, ".beads-issue");
  if (!fs.existsSync(beadsPath)) return { attempted: false, ok: false, reason: "missing-beads-issue" };
  const issueId = fs.readFileSync(beadsPath, "utf8").trim();
  if (!issueId) return { attempted: false, ok: false, reason: "empty-beads-issue" };

  const message = `Materials ready: cover letter + resume generated ${date}.`;
  try {
    execFileSync("bd", ["comment", issueId, message], {
      cwd: BEADS_CWD,
      stdio: "pipe",
      timeout: 30000,
    });
    return { attempted: true, ok: true, issueId };
  } catch (err) {
    return { attempted: true, ok: false, issueId, reason: err.message };
  }
}

function updateListingStatus(cache, entry, timestamp) {
  const listings = cache?.listings || {};
  let key = null;

  if (entry.jobId && listings[entry.jobId]) {
    key = String(entry.jobId);
  } else {
    key = Object.keys(listings).find((k) => listings[k].applicationFolder === entry.folderName) || null;
  }

  if (!key) return { updated: false };

  listings[key].status = "materials_ready";
  listings[key].materialsReadyAt = timestamp;
  return { updated: true, jobId: key };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-materials-ready.js <index|target> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --folder <name>       Match by application folder name");
    console.log("  --job-id <id>         Match by job ID");
    console.log("  --queue-id <id>       Match by stable queue ID");
    console.log("  --company <name>      Match by company name");
    console.log("  --channel <name>      Tracking source label (default: generated)");
    console.log("  --date <YYYY-MM-DD>   Override date written to notes");
    console.log("  --skip-beads          Do not post beads comment");
    console.log("  --dry-run             Calculate without writing files");
    console.log("  --json                Output JSON summary");
    return;
  }
  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensurePipeline(state);

  const pending = state.job_pipeline.pending_materials;
  const resolved = resolveFromPending(pending, opts);

  if (!resolved) {
    console.error("No matching entry in pending_materials. Provide index, --folder, --job-id, or --company.");
    process.exit(1);
  }

  const nowIso = new Date().toISOString();
  const queueId = resolved.entry.queueId || queueIdForEntry(resolved.entry);
  const entry = withQueueId({
    ...resolved.entry,
    queueId,
    materialsReadyAt: nowIso,
    materialsReadyDate: opts.date,
    readyChannel: opts.channel,
  });

  const nextPending = pending.filter((item) => !sameEntry(item, entry));
  const nextReady = state.job_pipeline.materials_ready
    .filter((item) => !sameEntry(item, entry))
    .concat([entry]);

  state.job_pipeline.pending_materials = nextPending;
  state.job_pipeline.materials_ready = nextReady;
  state.job_pipeline.pending_materials = dedupePipelineEntries(state.job_pipeline.pending_materials);
  state.job_pipeline.materials_ready = dedupePipelineEntries(state.job_pipeline.materials_ready);
  state.job_pipeline.submitted_applications = dedupePipelineEntries(state.job_pipeline.submitted_applications);

  const listingUpdate = updateListingStatus(cache, entry, nowIso);
  if (listingUpdate.updated && listingUpdate.jobId) {
    cache.listings[listingUpdate.jobId].queueId = queueId;
  }
  const notesPath = path.join(APPLICATIONS_DIR, entry.folderName || "", "Application_Research_Notes.md");
  const notesUpdated = opts.dryRun
    ? false
    : entry.folderName
    ? updateTrackingInNotes(notesPath, opts.date, opts.channel)
    : false;
  const beadsResult = opts.dryRun
    ? { attempted: false, ok: true, reason: "dry-run" }
    : entry.folderName
    ? maybeCommentBeads(entry.folderName, opts.date, opts.skipBeads)
    : { attempted: false, ok: false, reason: "missing-folder" };

  if (!opts.dryRun) {
    state.last_updated = nowIso;
    saveJson(STATE_PATH, state);
    if (listingUpdate.updated) {
      cache.lastUpdated = nowIso;
      saveJson(CACHE_PATH, cache);
    }
  }

  const result = {
    action: "materials_ready",
    dryRun: opts.dryRun,
    resolvedBy: resolved.reason,
    movedEntry: {
      queueId: entry.queueId || null,
      folderName: entry.folderName || null,
      company: entry.company || null,
      title: entry.title || null,
      jobId: entry.jobId || null,
    },
    counts: {
      pending_materials: state.job_pipeline.pending_materials.length,
      materials_ready: state.job_pipeline.materials_ready.length,
      submitted_applications: state.job_pipeline.submitted_applications.length,
    },
    listingUpdate,
    notesUpdated,
    beadsResult,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("MATERIALS READY UPDATED");
  console.log(`Resolved by: ${resolved.reason}`);
  console.log(`Folder: ${result.movedEntry.folderName || "(unknown)"}`);
  console.log(`Company: ${result.movedEntry.company || "(unknown)"}`);
  console.log(`Pending materials: ${result.counts.pending_materials}`);
  console.log(`Materials ready: ${result.counts.materials_ready}`);
  if (listingUpdate.updated) console.log(`Cache listing updated: ${listingUpdate.jobId}`);
  if (notesUpdated) console.log("Application_Research_Notes.md updated");
  if (beadsResult.attempted && beadsResult.ok) {
    console.log(`Beads commented: ${beadsResult.issueId}`);
  } else if (beadsResult.reason && beadsResult.reason !== "skipped") {
    console.log(`Beads note skipped: ${beadsResult.reason}`);
  }
}

main();
