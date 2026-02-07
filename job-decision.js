#!/usr/bin/env node

/**
 * job-decision.js - Apply decision to current review item.
 *
 * Usage:
 *   job-decision.js approve
 *   job-decision.js revise "tighten opening paragraph"
 *   job-decision.js skip
 *   job-decision.js reject "scope mismatch"
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import {
  buildReviewQueue,
  clearQueueSkipped,
  ensureJobPipeline,
  markQueueSkipped,
  normalizePipelineEntriesInState,
  pickCurrentReviewItem,
  queueIdForEntry,
  samePipelineEntry,
  setCurrentQueueId,
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
  const opts = {
    action: null,
    reason: null,
    queueId: null,
    channel: "LinkedIn",
    skipBeads: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!opts.action && !arg.startsWith("-")) {
      opts.action = arg.toLowerCase();
      continue;
    }
    if (arg === "--queue-id" && argv[i + 1]) opts.queueId = argv[++i];
    else if (arg === "--channel" && argv[i + 1]) opts.channel = argv[++i];
    else if (arg === "--reason" && argv[i + 1]) opts.reason = argv[++i];
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-")) opts.reason = opts.reason ? `${opts.reason} ${arg}` : arg;
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

function appendDecisionNote(folderName, text) {
  if (!folderName) return false;
  const notesPath = path.join(APPLICATIONS_DIR, folderName, "Application_Research_Notes.md");
  if (!fs.existsSync(notesPath)) return false;
  let content = fs.readFileSync(notesPath, "utf8");
  const date = new Date().toISOString().split("T")[0];
  const note = `**${date}:** ${text}`;
  if (/## Notes & Updates/m.test(content) && !content.includes(note)) {
    content = content.replace(/## Notes & Updates\n/, `## Notes & Updates\n\n${note}\n`);
    fs.writeFileSync(notesPath, content);
    return true;
  }
  if (!content.includes(note)) {
    content = `${content.trimEnd()}\n\n## Notes & Updates\n\n${note}\n`;
    fs.writeFileSync(notesPath, content);
    return true;
  }
  return false;
}

function resolveListingKey(cacheListings, item) {
  if (item.jobId && cacheListings[item.jobId]) return String(item.jobId);
  if (!item.folderName) return null;
  return Object.keys(cacheListings).find(
    (id) => cacheListings[id]?.applicationFolder === item.folderName
  ) || null;
}

function runSubmit(item, opts) {
  const args = ["--channel", String(opts.channel), "--json"];
  if (opts.skipBeads) args.push("--skip-beads");
  if (opts.dryRun) args.push("--dry-run");
  if (item.jobId) args.push("--job-id", String(item.jobId));
  else if (item.folderName) args.push("--folder", item.folderName);
  else throw new Error("approve requires jobId or folderName");

  const output = execFileSync("node", [path.join(__dirname, "job-submit.js"), ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : { raw: output };
}

function removeFromQueues(state, item) {
  const remove = (entry) => samePipelineEntry(entry, item);
  state.job_pipeline.pending_materials = state.job_pipeline.pending_materials.filter((entry) => !remove(entry));
  state.job_pipeline.materials_ready = state.job_pipeline.materials_ready.filter((entry) => !remove(entry));
}

function chooseNext(state, cacheListings) {
  normalizePipelineEntriesInState(state);
  const queue = buildReviewQueue({
    state,
    cacheListings,
    applicationsDir: APPLICATIONS_DIR,
  });
  const next = pickCurrentReviewItem(state, queue);
  setCurrentQueueId(state, next?.queueId || null);
  return { queue, next };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.action) {
    console.log("Usage: job-decision.js <approve|revise|skip|reject> [reason] [options]");
    console.log("Options: --queue-id <id> --channel <name> --skip-beads --dry-run --json");
    return;
  }

  const valid = new Set(["approve", "revise", "skip", "reject"]);
  if (!valid.has(opts.action)) {
    console.error(`Unsupported action: ${opts.action}`);
    process.exit(1);
  }

  maybeMigrate();
  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensureJobPipeline(state);
  normalizePipelineEntriesInState(state);

  const reviewQueue = buildReviewQueue({
    state,
    cacheListings: cache.listings || {},
    applicationsDir: APPLICATIONS_DIR,
  });
  const current = pickCurrentReviewItem(state, reviewQueue, opts.queueId);
  if (!current) {
    console.error("No review-ready item available.");
    process.exit(1);
  }

  const target = withQueueId({
    ...current,
    queueId: current.queueId || queueIdForEntry(current),
  });

  const result = {
    action: "job_decision",
    decision: opts.action,
    reason: opts.reason || null,
    target: {
      queueId: target.queueId,
      jobId: target.jobId || null,
      folderName: target.folderName || null,
      company: target.company || null,
      title: target.title || null,
    },
    effects: {},
  };
  let stateMutatedExternally = false;

  if (opts.action === "approve") {
    const submit = runSubmit(target, opts);
    result.effects.submit = submit;
    clearQueueSkipped(state, target.queueId);
    stateMutatedExternally = true;
  } else if (opts.action === "revise") {
    const revised = withQueueId({
      ...target,
      revisionRequestedAt: new Date().toISOString(),
      revisionReason: opts.reason || "Needs edits before submission",
    });
    removeFromQueues(state, revised);
    state.job_pipeline.pending_materials = state.job_pipeline.pending_materials
      .filter((entry) => !samePipelineEntry(entry, revised))
      .concat([revised]);
    const key = resolveListingKey(cache.listings || {}, revised);
    if (key && cache.listings[key]) {
      cache.listings[key].status = "prepped";
      cache.listings[key].queueId = revised.queueId;
      cache.listings[key].revisionRequestedAt = revised.revisionRequestedAt;
    }
    if (!opts.dryRun) {
      appendDecisionNote(revised.folderName, `Revision requested: ${revised.revisionReason}`);
    }
    clearQueueSkipped(state, target.queueId);
    result.effects.revise = {
      movedTo: "pending_materials",
      revisionReason: revised.revisionReason,
      listingUpdated: Boolean(key),
    };
  } else if (opts.action === "skip") {
    markQueueSkipped(state, target.queueId);
    result.effects.skip = { skippedQueueId: target.queueId };
  } else if (opts.action === "reject") {
    removeFromQueues(state, target);
    const key = resolveListingKey(cache.listings || {}, target);
    if (key && cache.listings[key]) {
      cache.listings[key].status = "archived";
      cache.listings[key].archivedAt = new Date().toISOString();
      cache.listings[key].archiveReason = opts.reason || "Rejected during human review";
      cache.listings[key].queueId = target.queueId;
    }
    if (!opts.dryRun) {
      appendDecisionNote(
        target.folderName,
        `Application archived from review queue: ${opts.reason || "Rejected during review"}`
      );
    }
    clearQueueSkipped(state, target.queueId);
    result.effects.reject = {
      removedFromReviewQueue: true,
      listingArchived: Boolean(key),
    };
  }

  const effectiveState = stateMutatedExternally
    ? loadJson(STATE_PATH, state)
    : state;
  const effectiveCache = stateMutatedExternally
    ? loadJson(CACHE_PATH, cache)
    : cache;
  ensureJobPipeline(effectiveState);
  normalizePipelineEntriesInState(effectiveState);

  const { queue: nextQueue, next } = chooseNext(effectiveState, effectiveCache.listings || {});
  result.next = next
    ? {
        queueId: next.queueId,
        company: next.company || null,
        title: next.title || null,
        score: next.score ?? null,
      }
    : null;
  result.remainingReviewReady = nextQueue.length;

  if (!opts.dryRun) {
    effectiveState.last_updated = new Date().toISOString();
    saveJson(STATE_PATH, effectiveState);
    saveJson(CACHE_PATH, effectiveCache);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`JOB DECISION: ${opts.action.toUpperCase()}`);
  console.log(`Queue ID: ${target.queueId}`);
  console.log(`Role: ${target.company || "(unknown)"} - ${target.title || "(unknown)"}`);
  if (opts.reason) console.log(`Reason: ${opts.reason}`);
  console.log(`Remaining review-ready: ${result.remainingReviewReady}`);
  if (result.next) {
    console.log(`Next: ${result.next.queueId} (${result.next.company} - ${result.next.title})`);
    console.log("Run: /job next");
  } else {
    console.log("No remaining review-ready items.");
  }
}

main();
