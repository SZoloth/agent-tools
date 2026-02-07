#!/usr/bin/env node

/**
 * job-run.js - One-command job pipeline orchestrator.
 *
 * Usage:
 *   job-run.js
 *   job-run.js run --preset all --hours 6 --threshold 70 --prep-top 3
 *   job-run.js status
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_PATH = path.join(
  process.env.HOME,
  ".claude/state/job-listings-cache.json"
);
const COS_STATE_PATH = path.join(
  process.env.HOME,
  ".claude/state/cos-state.json"
);
const LOCK_PATH = path.join(
  process.env.HOME,
  ".claude/state/job-pipeline.lock"
);

const DEFAULTS = {
  mode: "run",
  preset: "all",
  hours: 6,
  threshold: 70,
  prepTop: 3,
  writeTop: 0,
  writeAllPending: false,
  noWrite: false,
  waitMs: 5000,
  fetch: false,
  skipBeads: false,
  company: null,
  remote: false,
  location: null,
  noFresh: false,
  noScrape: false,
  noQualify: false,
  backfill: false,
  skipMigrate: false,
  syncFollowups: false,
  followupDays: 7,
  lockTimeoutMs: 60000,
  json: false,
  help: false,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };

  if (argv[0] && !argv[0].startsWith("-")) {
    const mode = argv.shift();
    if (mode === "run" || mode === "status") {
      opts.mode = mode;
    } else {
      opts.mode = "run";
      argv.unshift(mode);
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preset" && argv[i + 1]) opts.preset = argv[++i];
    else if (arg === "--hours" && argv[i + 1]) opts.hours = Number(argv[++i]);
    else if (arg === "--threshold" && argv[i + 1]) opts.threshold = Number(argv[++i]);
    else if (arg === "--prep-top" && argv[i + 1]) opts.prepTop = Math.max(0, Number(argv[++i]));
    else if (arg === "--write-top" && argv[i + 1]) opts.writeTop = Math.max(0, Number(argv[++i]));
    else if (arg === "--write-all-pending") opts.writeAllPending = true;
    else if (arg === "--no-write") opts.noWrite = true;
    else if (arg === "--wait-ms" && argv[i + 1]) opts.waitMs = Math.max(0, Number(argv[++i]));
    else if (arg === "--company" && argv[i + 1]) opts.company = argv[++i];
    else if (arg === "--location" && argv[i + 1]) opts.location = argv[++i];
    else if (arg === "--remote") opts.remote = true;
    else if (arg === "--fetch") opts.fetch = true;
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--no-fresh") opts.noFresh = true;
    else if (arg === "--no-scrape") opts.noScrape = true;
    else if (arg === "--no-qualify") opts.noQualify = true;
    else if (arg === "--backfill") opts.backfill = true;
    else if (arg === "--skip-migrate") opts.skipMigrate = true;
    else if (arg === "--sync-followups") opts.syncFollowups = true;
    else if (arg === "--followup-days" && argv[i + 1]) opts.followupDays = Math.max(1, Number(argv[++i]));
    else if (arg === "--lock-timeout-ms" && argv[i + 1]) opts.lockTimeoutMs = Math.max(1000, Number(argv[++i]));
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
    console.error(`Failed to read ${filePath}: ${err.message}`);
  }
  return fallback;
}

function ensureJobPipeline(state) {
  if (!state.job_pipeline) state.job_pipeline = {};
  if (!Array.isArray(state.job_pipeline.pending_materials)) state.job_pipeline.pending_materials = [];
  if (!Array.isArray(state.job_pipeline.materials_ready)) state.job_pipeline.materials_ready = [];
  if (!Array.isArray(state.job_pipeline.submitted_applications)) state.job_pipeline.submitted_applications = [];
}

function extractJson(raw) {
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) {
    throw new Error(`Expected JSON output, got: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(start));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePostedTimeToDays(postedTime) {
  if (!postedTime) return 30;
  const value = String(postedTime).trim();

  const parsedDate = Date.parse(value);
  if (!Number.isNaN(parsedDate)) {
    const diffMs = Date.now() - parsedDate;
    return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  }

  if (/just now|today|hour/i.test(value)) return 0;
  const match = value.match(/(\d+)\s*(hour|day|week|month)/i);
  if (!match) return 30;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("hour")) return 0;
  if (unit.startsWith("day")) return amount;
  if (unit.startsWith("week")) return amount * 7;
  if (unit.startsWith("month")) return amount * 30;
  return 30;
}

function titleSignature(title) {
  const stop = new Set(["senior", "sr", "staff", "principal", "lead", "ii", "iii", "iv", "remote", "hybrid", "onsite"]);
  const tokens = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !stop.has(token));
  const selected = (tokens.length > 0 ? tokens : String(title || "").toLowerCase().split(/\s+/)).slice(0, 8);
  return selected.join(" ");
}

function candidateKey(item) {
  const company = String(item.company || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${company}::${titleSignature(item.title)}`;
}

function tierBonus(item) {
  const tier = String(item?.scoreBreakdown?.companyTier?.tier || "unknown").toLowerCase();
  if (tier === "target") return 25;
  if (tier === "stretch") return 20;
  if (tier === "known") return 12;
  return 5;
}

function computePriorityScore(item) {
  const score = Number(item.score ?? 0);
  const days = parsePostedTimeToDays(item.postedTime);
  const freshness = Math.max(0, 20 - days * 2);
  return score + tierBonus(item) + freshness;
}

function collectSuppressionKeys(entries, cosState) {
  const keys = new Set();

  for (const item of entries) {
    const status = String(item.status || "");
    if (status === "prepped" || status === "materials_ready" || status === "applied") {
      keys.add(candidateKey(item));
    }
  }

  for (const bucketName of ["pending_materials", "materials_ready", "submitted_applications"]) {
    for (const entry of cosState.job_pipeline[bucketName] || []) {
      keys.add(candidateKey(entry));
    }
  }

  return keys;
}

function sortCandidates(a, b) {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  const scoreA = Number.isFinite(a.score) ? a.score : -1;
  const scoreB = Number.isFinite(b.score) ? b.score : -1;
  if (scoreB !== scoreA) return scoreB - scoreA;
  const timeA = Date.parse(a.scoredAt || a.discoveredAt || a.firstSeen || a.scrapedAt || 0) || 0;
  const timeB = Date.parse(b.scoredAt || b.discoveredAt || b.firstSeen || b.scrapedAt || 0) || 0;
  return timeB - timeA;
}

function summarizeState(cache, cosState) {
  const listings = cache?.listings || {};
  const entries = Object.entries(listings).map(([jobId, listing]) => ({ jobId, ...listing }));

  const statuses = {};
  for (const item of entries) {
    const status = item.status || "unknown";
    statuses[status] = (statuses[status] || 0) + 1;
  }

  ensureJobPipeline(cosState);
  const suppression = collectSuppressionKeys(entries, cosState);
  const seen = new Set();

  const qualifiedUnprepped = entries
    .filter((item) => item.status === "qualified" && !item.applicationFolder)
    .map((item) => ({ ...item, priorityScore: computePriorityScore(item) }))
    .sort(sortCandidates)
    .filter((item) => {
      const key = candidateKey(item);
      if (suppression.has(key)) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    totalListings: entries.length,
    statuses,
    qualifiedUnprepped,
    pendingMaterials: cosState.job_pipeline.pending_materials.length,
    materialsReady: cosState.job_pipeline.materials_ready.length,
    submittedApplications: cosState.job_pipeline.submitted_applications.length,
  };
}

function listQualifiedIds(summary) {
  return new Set(summary.qualifiedUnprepped.map((item) => String(item.jobId)));
}

function conciseCandidate(item) {
  return {
    jobId: item.jobId,
    score: item.score ?? null,
    priorityScore: item.priorityScore ?? null,
    company: item.company ?? null,
    title: item.title ?? null,
    postedTime: item.postedTime ?? null,
  };
}

function printHelp() {
  console.log("Usage:");
  console.log("  job-run.js");
  console.log("  job-run.js run [options]");
  console.log("  job-run.js status");
  console.log("");
  console.log("Options:");
  console.log("  --preset <name>         job-fresh preset (default: all)");
  console.log("  --hours <n>             freshness hours for LinkedIn search (default: 6)");
  console.log("  --threshold <n>         qualification threshold (default: 70)");
  console.log("  --prep-top <n>          auto-prep top N newly qualified (default: 3, 0 disables prep)");
  console.log("  --write-top <n>         auto-write top N pending items to materials_ready (default: 0)");
  console.log("  --write-all-pending     write drafts for every pending_materials entry");
  console.log("  --no-write              disable automatic draft writing");
  console.log("  --backfill              if no newly qualified, prep from existing qualified queue");
  console.log("  --skip-migrate          skip state migration pre-step");
  console.log("  --company <name>        filter LinkedIn search to target company");
  console.log("  --remote                use remote-only LinkedIn filter");
  console.log("  --location <id|key>     override location for job-fresh");
  console.log("  --fetch                 fetch full posting body during prep");
  console.log("  --skip-beads            do not create beads issues during prep");
  console.log("  --sync-followups        run follow-up sync after submit queue check");
  console.log("  --followup-days <n>     days before follow-up is due (default: 7)");
  console.log("  --no-fresh              skip job-fresh step");
  console.log("  --no-scrape             skip job-scraper step");
  console.log("  --no-qualify            skip job-qualify step");
  console.log("  --wait-ms <n>           wait between fresh and scrape (default: 5000)");
  console.log("  --lock-timeout-ms <n>   lock wait timeout (default: 60000)");
  console.log("  --json                  print JSON summary");
}

function runTool(scriptName, args = [], options = {}) {
  const { expectJson = false, jsonMode = false, showCommand = true } = options;
  const scriptPath = path.join(__dirname, scriptName);
  const command = ["node", scriptName, ...args].join(" ");

  if (showCommand && !jsonMode) {
    console.log(`\n$ ${command}`);
  }

  if (expectJson) {
    const jsonArgs = args.includes("--json") ? args : [...args, "--json"];
    const output = execFileSync("node", [scriptPath, ...jsonArgs], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return extractJson(output);
  }

  execFileSync("node", [scriptPath, ...args], {
    stdio: jsonMode ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  return null;
}

async function acquireLock(lockPath, timeoutMs) {
  const start = Date.now();
  const staleMs = 10 * 60 * 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
      );
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }

      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared between checks.
      }

      await sleep(300);
    }
  }

  return false;
}

function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup.
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const lockAcquired = await acquireLock(LOCK_PATH, opts.lockTimeoutMs);
  if (!lockAcquired) {
    console.error(`Could not acquire lock at ${LOCK_PATH} within ${opts.lockTimeoutMs}ms`);
    process.exit(1);
  }

  try {
    const migration = opts.skipMigrate
      ? { action: "state_migrate", skipped: true }
      : runTool(
          "job-state-migrate.js",
          ["--threshold", String(opts.threshold)],
          { expectJson: true, jsonMode: opts.json, showCommand: true }
        );

    const beforeCache = loadJson(CACHE_PATH, { listings: {} });
    const beforeState = loadJson(COS_STATE_PATH, { version: "1.0", job_pipeline: {} });
    const before = summarizeState(beforeCache, beforeState);
    const beforeQualifiedIds = listQualifiedIds(before);

    if (opts.mode === "status") {
      const statusResult = {
        mode: "status",
        migration,
        summary: {
          totalListings: before.totalListings,
          statuses: before.statuses,
          qualifiedUnprepped: before.qualifiedUnprepped.length,
          pendingMaterials: before.pendingMaterials,
          materialsReady: before.materialsReady,
          submittedApplications: before.submittedApplications,
        },
        topQualified: before.qualifiedUnprepped.slice(0, 5).map(conciseCandidate),
      };

      if (opts.json) {
        console.log(JSON.stringify(statusResult, null, 2));
        return;
      }

      console.log("JOB PIPELINE STATUS");
      console.log(`Total listings: ${statusResult.summary.totalListings}`);
      console.log(`Qualified (unprepped): ${statusResult.summary.qualifiedUnprepped}`);
      console.log(`Pending materials: ${statusResult.summary.pendingMaterials}`);
      console.log(`Materials ready: ${statusResult.summary.materialsReady}`);
      console.log(`Submitted applications: ${statusResult.summary.submittedApplications}`);
      return;
    }

    const stepsRun = [];
    const preppedJobs = [];
    const prepFailures = [];
    const writeRuns = [];
    const writeFailures = [];
    const stepResults = {};

    try {
      if (!opts.noFresh) {
        const freshArgs = ["--preset", opts.preset, "--hours", String(opts.hours)];
        if (opts.company) freshArgs.push("--company", opts.company);
        if (opts.remote) freshArgs.push("--remote");
        if (opts.location) freshArgs.push("--location", opts.location);
        stepResults.fresh = runTool("job-fresh.js", freshArgs, {
          expectJson: opts.json,
          jsonMode: opts.json,
          showCommand: true,
        });
        stepsRun.push("fresh");
        if (opts.waitMs > 0) await sleep(opts.waitMs);
      }

      if (!opts.noScrape) {
        stepResults.scrape = runTool("job-scraper.js", ["--all", "--scroll"], {
          expectJson: opts.json,
          jsonMode: opts.json,
          showCommand: true,
        });
        stepsRun.push("scrape");
      }

      if (!opts.noQualify) {
        stepResults.qualify = runTool("job-qualify.js", ["--threshold", String(opts.threshold)], {
          expectJson: opts.json,
          jsonMode: opts.json,
          showCommand: true,
        });
        stepsRun.push("qualify");
      }
    } catch (err) {
      console.error(`Pipeline execution failed: ${err.message}`);
      process.exit(1);
    }

    const afterPrePrepCache = loadJson(CACHE_PATH, { listings: {} });
    const afterPrePrepState = loadJson(COS_STATE_PATH, { version: "1.0", job_pipeline: {} });
    const afterPrePrep = summarizeState(afterPrePrepCache, afterPrePrepState);

    let prepPool = afterPrePrep.qualifiedUnprepped.filter(
      (item) => !beforeQualifiedIds.has(String(item.jobId))
    );
    const usedBackfill = prepPool.length === 0 && opts.backfill;
    if (usedBackfill) {
      prepPool = afterPrePrep.qualifiedUnprepped;
    }

    const toPrep = opts.prepTop > 0 ? prepPool.slice(0, opts.prepTop) : [];
    for (const candidate of toPrep) {
      const prepArgs = [String(candidate.jobId)];
      if (opts.fetch) prepArgs.push("--fetch");
      if (opts.skipBeads) prepArgs.push("--skip-beads");

      try {
        runTool("job-apply-prep.js", prepArgs, {
          expectJson: opts.json,
          jsonMode: opts.json,
          showCommand: true,
        });
        preppedJobs.push(conciseCandidate(candidate));
      } catch (err) {
        prepFailures.push({
          ...conciseCandidate(candidate),
          error: err.message,
        });
      }
    }
    if (toPrep.length > 0) stepsRun.push("prep");

    const writeJobById = (jobId) => {
      const writeArgs = ["--job-id", String(jobId), "--channel", "auto-run"];
      if (opts.skipBeads) writeArgs.push("--skip-beads");
      return runTool("job-write-drafts.js", writeArgs, {
        expectJson: true,
        jsonMode: opts.json,
        showCommand: true,
      });
    };

    const writePendingTop = (count) => {
      const writeArgs = ["--top", String(count), "--channel", "auto-run"];
      if (opts.skipBeads) writeArgs.push("--skip-beads");
      return runTool("job-write-drafts.js", writeArgs, {
        expectJson: true,
        jsonMode: opts.json,
        showCommand: true,
      });
    };

    if (!opts.noWrite) {
      if (opts.writeAllPending) {
        try {
          const args = ["--all", "--channel", "auto-run"];
          if (opts.skipBeads) args.push("--skip-beads");
          const allWriteResult = runTool("job-write-drafts.js", args, {
            expectJson: true,
            jsonMode: opts.json,
            showCommand: true,
          });
          writeRuns.push({ mode: "all", result: allWriteResult });
        } catch (err) {
          writeFailures.push({ mode: "all", error: err.message });
        }
      } else if (opts.writeTop > 0) {
        let writesUsed = 0;
        for (const job of preppedJobs) {
          if (writesUsed >= opts.writeTop) break;
          try {
            const res = writeJobById(job.jobId);
            writeRuns.push({ mode: "job-id", jobId: job.jobId, result: res });
            writesUsed++;
          } catch (err) {
            writeFailures.push({ mode: "job-id", jobId: job.jobId, error: err.message });
          }
        }

        const remaining = opts.writeTop - writesUsed;
        if (remaining > 0) {
          try {
            const res = writePendingTop(remaining);
            writeRuns.push({ mode: "top", count: remaining, result: res });
          } catch (err) {
            writeFailures.push({ mode: "top", count: remaining, error: err.message });
          }
        }
      }
    }
    if (writeRuns.length > 0 || writeFailures.length > 0) stepsRun.push("write");

    let followupSync = null;
    if (opts.syncFollowups) {
      const followupArgs = ["--days", String(opts.followupDays)];
      if (opts.skipBeads) followupArgs.push("--skip-beads");
      followupSync = runTool("job-followup-sync.js", followupArgs, {
        expectJson: true,
        jsonMode: opts.json,
        showCommand: true,
      });
      stepsRun.push("followup_sync");
    }

    const afterCache = loadJson(CACHE_PATH, { listings: {} });
    const afterState = loadJson(COS_STATE_PATH, { version: "1.0", job_pipeline: {} });
    const after = summarizeState(afterCache, afterState);

    const result = {
      mode: "run",
      migration,
      options: {
        preset: opts.preset,
        hours: opts.hours,
        threshold: opts.threshold,
        prepTop: opts.prepTop,
        writeTop: opts.writeTop,
        writeAllPending: opts.writeAllPending,
        noWrite: opts.noWrite,
        backfill: opts.backfill,
        skipMigrate: opts.skipMigrate,
        fetch: opts.fetch,
        skipBeads: opts.skipBeads,
        noFresh: opts.noFresh,
        noScrape: opts.noScrape,
        noQualify: opts.noQualify,
        syncFollowups: opts.syncFollowups,
        followupDays: opts.followupDays,
      },
      stepsRun,
      stepResults,
      counts: {
        before: {
          totalListings: before.totalListings,
          qualifiedUnprepped: before.qualifiedUnprepped.length,
          pendingMaterials: before.pendingMaterials,
          materialsReady: before.materialsReady,
        },
        after: {
          totalListings: after.totalListings,
          qualifiedUnprepped: after.qualifiedUnprepped.length,
          pendingMaterials: after.pendingMaterials,
          materialsReady: after.materialsReady,
        },
      },
      newlyQualified: afterPrePrep.qualifiedUnprepped
        .filter((item) => !beforeQualifiedIds.has(String(item.jobId)))
        .map(conciseCandidate),
      prep: {
        usedBackfill,
        attempted: toPrep.length,
        succeeded: preppedJobs.length,
        failed: prepFailures.length,
        preppedJobs,
        prepFailures,
      },
      write: {
        attemptedRuns: writeRuns.length + writeFailures.length,
        succeededRuns: writeRuns.length,
        failedRuns: writeFailures.length,
        writeRuns,
        writeFailures,
      },
      followupSync,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("\nJOB RUN COMPLETE");
    console.log(`Steps run: ${stepsRun.join(" -> ") || "(none)"}`);
    console.log(`Listings: ${result.counts.before.totalListings} -> ${result.counts.after.totalListings}`);
    console.log(`Qualified (unprepped): ${result.counts.before.qualifiedUnprepped} -> ${result.counts.after.qualifiedUnprepped}`);
    console.log(`Pending materials: ${result.counts.before.pendingMaterials} -> ${result.counts.after.pendingMaterials}`);
    console.log(`Materials ready: ${result.counts.before.materialsReady} -> ${result.counts.after.materialsReady}`);
    console.log(`Newly qualified this run: ${result.newlyQualified.length}`);
    console.log(`Auto-prepped: ${result.prep.succeeded}/${result.prep.attempted}`);
    if (!opts.noWrite) {
      console.log(`Auto-written runs: ${result.write.succeededRuns}/${result.write.attemptedRuns}`);
    }
    if (result.prep.failed > 0) {
      console.log(`Prep failures: ${result.prep.failed}`);
    }
    if (result.write.failedRuns > 0) {
      console.log(`Write failures: ${result.write.failedRuns}`);
    }
    if (followupSync) {
      console.log(`Follow-ups created: ${followupSync.createdCount}`);
    }

    if (result.counts.after.materialsReady > 0) {
      console.log("\nNext:");
      console.log("  /job next");
      console.log("  (review materials and submit)");
    } else if (result.counts.after.pendingMaterials > 0) {
      console.log("\nNext:");
      console.log("  /job generate 1");
      console.log("  (repeat /job generate N for pending materials you review)");
    } else if (after.qualifiedUnprepped.length > 0) {
      console.log("\nNext:");
      console.log("  /job run --backfill");
      console.log("  (to prep candidates from existing qualified backlog)");
    }
  } finally {
    releaseLock(LOCK_PATH);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
