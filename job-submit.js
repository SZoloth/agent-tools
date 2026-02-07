#!/usr/bin/env node

/**
 * job-submit.js - Mark an application submitted and move it to submitted_applications.
 *
 * Usage:
 *   job-submit.js 1 --channel LinkedIn
 *   job-submit.js --folder 48-stripe --channel Referral
 *   job-submit.js --job-id 4338838020 --channel Direct
 *
 * Options:
 *   --channel <LinkedIn|Direct|Referral|Other>  (default: LinkedIn)
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
    channel: "LinkedIn",
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

function resolveEntry(entries, opts) {
  if (opts.folder) {
    const idx = entries.findIndex((e) => e.folderName === opts.folder);
    return idx >= 0 ? { index: idx, entry: entries[idx], reason: "folder" } : null;
  }
  if (opts.jobId) {
    const idx = entries.findIndex((e) => String(e.jobId) === String(opts.jobId));
    return idx >= 0 ? { index: idx, entry: entries[idx], reason: "job-id" } : null;
  }
  if (opts.queueId) {
    const idx = entries.findIndex((e) => String(e.queueId || "") === String(opts.queueId));
    return idx >= 0 ? { index: idx, entry: entries[idx], reason: "queue-id" } : null;
  }
  if (opts.company) {
    const companyNorm = normalize(opts.company);
    const idx = entries.findIndex((e) => normalize(e.company).includes(companyNorm));
    return idx >= 0 ? { index: idx, entry: entries[idx], reason: "company" } : null;
  }
  if (opts.target && /^\d+$/.test(opts.target)) {
    const index = Number(opts.target) - 1;
    if (index >= 0 && index < entries.length) {
      return { index, entry: entries[index], reason: "index" };
    }
  }
  if (opts.target) {
    const targetNorm = normalize(opts.target);
    const idx = entries.findIndex(
      (e) =>
        e.folderName === opts.target ||
        String(e.jobId || "") === opts.target ||
        normalize(e.company).includes(targetNorm)
    );
    return idx >= 0 ? { index: idx, entry: entries[idx], reason: "target" } : null;
  }
  return null;
}

function updateTrackingInNotes(notesPath, date, channel) {
  if (!fs.existsSync(notesPath)) return false;
  let content = fs.readFileSync(notesPath, "utf8");

  if (/^\*\*Application Status:\*\*.*$/m.test(content)) {
    content = content.replace(
      /^\*\*Application Status:\*\*.*$/m,
      `**Application Status:** SUBMITTED (${date} via ${channel})`
    );
  }

  if (/^\*\*Status:\*\*.*$/m.test(content)) {
    content = content.replace(
      /^\*\*Status:\*\*.*$/m,
      `**Status:** Submitted (${date} via ${channel})`
    );
  }

  if (/^\*\*Submitted:\*\*.*$/m.test(content)) {
    content = content.replace(/^\*\*Submitted:\*\*.*$/m, `**Submitted:** ${date} via ${channel}`);
  } else if (/^\*\*Status:\*\*.*$/m.test(content)) {
    content = content.replace(/^\*\*Status:\*\*.*$/m, (m) => `${m}\n**Submitted:** ${date} via ${channel}`);
  }

  const noteLine = `**${date}:** Application submitted via ${channel}.`;
  if (/## Notes & Updates/m.test(content) && !content.includes(noteLine)) {
    content = content.replace(/## Notes & Updates\n/, `## Notes & Updates\n\n${noteLine}\n`);
  }

  fs.writeFileSync(notesPath, content);
  return true;
}

function updateListingStatus(cache, entry, timestamp, channel) {
  const listings = cache?.listings || {};
  let key = null;

  if (entry.jobId && listings[entry.jobId]) {
    key = String(entry.jobId);
  } else {
    key = Object.keys(listings).find((k) => listings[k].applicationFolder === entry.folderName) || null;
  }

  if (!key) return { updated: false };

  listings[key].status = "applied";
  listings[key].appliedAt = timestamp;
  listings[key].submissionChannel = channel;
  return { updated: true, jobId: key };
}

function maybeCloseBeads(folderName, date, channel, skipBeads) {
  if (skipBeads) return { attempted: false, ok: true, reason: "skipped" };
  const beadsPath = path.join(APPLICATIONS_DIR, folderName, ".beads-issue");
  if (!fs.existsSync(beadsPath)) return { attempted: false, ok: false, reason: "missing-beads-issue" };
  const issueId = fs.readFileSync(beadsPath, "utf8").trim();
  if (!issueId) return { attempted: false, ok: false, reason: "empty-beads-issue" };

  const reason = `Submitted ${date} via ${channel}`;
  try {
    execFileSync("bd", ["close", issueId, "-r", reason], {
      cwd: BEADS_CWD,
      stdio: "pipe",
      timeout: 30000,
    });
    return { attempted: true, ok: true, issueId };
  } catch (err) {
    return { attempted: true, ok: false, issueId, reason: err.message };
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-submit.js <index|target> [options]");
    console.log("");
    console.log("Options:");
    console.log("  --folder <name>       Match by application folder name");
    console.log("  --job-id <id>         Match by job ID");
    console.log("  --queue-id <id>       Match by stable queue ID");
    console.log("  --company <name>      Match by company name");
    console.log("  --channel <name>      Submission channel (default: LinkedIn)");
    console.log("  --date <YYYY-MM-DD>   Override date written to notes");
    console.log("  --skip-beads          Do not close beads issue");
    console.log("  --dry-run             Calculate without writing files");
    console.log("  --json                Output JSON summary");
    return;
  }
  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensurePipeline(state);

  const ready = state.job_pipeline.materials_ready;
  let resolved = resolveEntry(ready, opts);
  let source = "materials_ready";

  if (!resolved) {
    resolved = resolveEntry(state.job_pipeline.pending_materials, opts);
    source = resolved ? "pending_materials" : source;
  }

  if (!resolved) {
    console.error("No matching entry in materials_ready or pending_materials.");
    process.exit(1);
  }

  const nowIso = new Date().toISOString();
  const queueId = resolved.entry.queueId || queueIdForEntry(resolved.entry);
  const submittedEntry = withQueueId({
    ...resolved.entry,
    queueId,
    submittedAt: nowIso,
    submittedDate: opts.date,
    submissionChannel: opts.channel,
  });

  state.job_pipeline.materials_ready = state.job_pipeline.materials_ready.filter(
    (item) => !sameEntry(item, submittedEntry)
  );
  state.job_pipeline.pending_materials = state.job_pipeline.pending_materials.filter(
    (item) => !sameEntry(item, submittedEntry)
  );
  state.job_pipeline.submitted_applications = state.job_pipeline.submitted_applications
    .filter((item) => !sameEntry(item, submittedEntry))
    .concat([submittedEntry]);
  state.job_pipeline.pending_materials = dedupePipelineEntries(state.job_pipeline.pending_materials);
  state.job_pipeline.materials_ready = dedupePipelineEntries(state.job_pipeline.materials_ready);
  state.job_pipeline.submitted_applications = dedupePipelineEntries(state.job_pipeline.submitted_applications);

  const listingUpdate = updateListingStatus(cache, submittedEntry, nowIso, opts.channel);
  if (listingUpdate.updated && listingUpdate.jobId) {
    cache.listings[listingUpdate.jobId].queueId = queueId;
  }
  const notesPath = path.join(
    APPLICATIONS_DIR,
    submittedEntry.folderName || "",
    "Application_Research_Notes.md"
  );
  const notesUpdated = opts.dryRun
    ? false
    : submittedEntry.folderName
    ? updateTrackingInNotes(notesPath, opts.date, opts.channel)
    : false;
  const beadsResult = opts.dryRun
    ? { attempted: false, ok: true, reason: "dry-run" }
    : submittedEntry.folderName
    ? maybeCloseBeads(submittedEntry.folderName, opts.date, opts.channel, opts.skipBeads)
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
    action: "submit_application",
    dryRun: opts.dryRun,
    source,
    resolvedBy: resolved.reason,
    submittedEntry: {
      queueId: submittedEntry.queueId || null,
      folderName: submittedEntry.folderName || null,
      company: submittedEntry.company || null,
      title: submittedEntry.title || null,
      jobId: submittedEntry.jobId || null,
      submissionChannel: opts.channel,
      submittedDate: opts.date,
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

  console.log("APPLICATION SUBMITTED");
  console.log(`Resolved by: ${resolved.reason} (${source})`);
  console.log(`Folder: ${result.submittedEntry.folderName || "(unknown)"}`);
  console.log(`Company: ${result.submittedEntry.company || "(unknown)"}`);
  console.log(`Channel: ${opts.channel}`);
  console.log(`Pending materials: ${result.counts.pending_materials}`);
  console.log(`Materials ready: ${result.counts.materials_ready}`);
  console.log(`Submitted applications: ${result.counts.submitted_applications}`);
  if (listingUpdate.updated) console.log(`Cache listing updated: ${listingUpdate.jobId}`);
  if (notesUpdated) console.log("Application_Research_Notes.md updated");
  if (beadsResult.attempted && beadsResult.ok) {
    console.log(`Beads closed: ${beadsResult.issueId}`);
  } else if (beadsResult.reason && beadsResult.reason !== "skipped") {
    console.log(`Beads close skipped: ${beadsResult.reason}`);
  }
}

main();
