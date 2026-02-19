#!/usr/bin/env node

/**
 * job-email-ingest.js - Parse job alert emails and inject into cache
 *
 * Bridges the gap between email alerts (Wellfound, WTTJ, Otta) and
 * the main job-listings-cache.json used by job-qualify.js.
 *
 * Usage:
 *   job-email-ingest.js                    # Parse last 7 days of emails
 *   job-email-ingest.js --since 24         # Parse last 24 hours
 *   job-email-ingest.js --since 72         # Parse last 72 hours
 *   job-email-ingest.js --dry-run          # Show what would be added
 *   job-email-ingest.js --verbose          # Show parsing details
 *   job-email-ingest.js --score            # Also run job-qualify.js after ingest
 *
 * Data sources:
 *   - Wellfound email alerts
 *   - Welcome to the Jungle (WTTJ) email alerts
 *   (Otta support can be added to lib/job-email-parser.js)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

import { parseJobAlertEmails } from "./lib/job-email-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_PATH = path.join(process.env.HOME, ".claude/state/job-listings-cache.json");
const DEFAULT_SINCE_HOURS = 168; // 7 days

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    sinceHours: DEFAULT_SINCE_HOURS,
    dryRun: false,
    verbose: false,
    runScore: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--since" || arg === "-s") {
      options.sinceHours = parseInt(args[++i], 10);
      if (isNaN(options.sinceHours) || options.sinceHours <= 0) {
        console.error("Error: --since requires a positive number of hours");
        process.exit(1);
      }
    } else if (arg === "--dry-run" || arg === "-d") {
      options.dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--score") {
      options.runScore = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  return options;
}

function printUsage() {
  console.log(`
job-email-ingest.js - Parse job alert emails and inject into cache

Usage:
  job-email-ingest.js [options]

Options:
  --since, -s N     Parse emails from last N hours (default: 168 = 7 days)
  --dry-run, -d     Preview what would be added without saving
  --verbose, -v     Show detailed parsing output
  --score           Run job-qualify.js after ingesting
  --help, -h        Show this help message

Examples:
  job-email-ingest.js                    # Parse last 7 days
  job-email-ingest.js --since 24         # Parse last 24 hours
  job-email-ingest.js --dry-run --since 72   # Preview last 72 hours
  job-email-ingest.js --score            # Parse and score new jobs
`);
}

// ============================================================================
// CACHE OPERATIONS
// ============================================================================

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    }
  } catch (err) {
    console.error("Error loading cache:", err.message);
  }
  return { version: "1.0", lastUpdated: null, listings: {} };
}

function saveCache(cache) {
  cache.lastUpdated = new Date().toISOString();
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const options = parseArgs();

  console.log(`\nJob Email Ingest`);
  console.log("─".repeat(50));
  console.log(`Parsing emails from last ${options.sinceHours} hours...`);
  if (options.dryRun) {
    console.log("(dry run - no changes will be saved)\n");
  } else {
    console.log("");
  }

  // 1. Parse emails using existing library
  const { jobs, stats, error } = await parseJobAlertEmails({
    since: options.sinceHours,
    verbose: options.verbose,
  });

  if (error) {
    console.error(`\nError parsing emails: ${error}`);
    process.exit(1);
  }

  // 2. Display stats
  console.log(`Emails checked: ${stats.emailsChecked}`);
  console.log(`  Wellfound: ${stats.wellfoundEmails}`);
  console.log(`  WTTJ: ${stats.wttjEmails}`);
  console.log(`Jobs extracted: ${stats.jobsFound}`);

  if (jobs.length === 0) {
    console.log("\nNo new jobs found in emails.");
    return;
  }

  // 3. Load existing cache
  const cache = loadCache();
  const existingCount = Object.keys(cache.listings).length;

  // 4. Merge new jobs (dedupe by jobId)
  let newCount = 0;
  let skippedCount = 0;
  const newJobs = [];

  for (const job of jobs) {
    if (!job.jobId) {
      skippedCount++;
      continue;
    }

    if (cache.listings[job.jobId]) {
      // Already exists
      skippedCount++;
      if (options.verbose) {
        console.log(`  Skip (exists): ${job.jobId}`);
      }
    } else {
      // New job - add to cache
      cache.listings[job.jobId] = {
        ...job,
        status: "new",
        score: null,
        firstSeen: job.firstSeen || new Date().toISOString(),
      };
      newCount++;
      newJobs.push(job);

      if (options.verbose) {
        const company = job.company || "Unknown";
        const title = job.title || "Unknown title";
        console.log(`  + [${job.source}] ${title} @ ${company}`);
      }
    }
  }

  // 5. Summary
  console.log("");
  console.log("─".repeat(50));
  console.log(`New jobs to add: ${newCount}`);
  console.log(`Skipped (duplicates): ${skippedCount}`);
  console.log(`Cache before: ${existingCount} listings`);
  console.log(`Cache after: ${existingCount + newCount} listings`);

  if (options.dryRun) {
    console.log("\nDry run - no changes saved.");

    if (newJobs.length > 0 && !options.verbose) {
      console.log("\nNew jobs that would be added:");
      for (const job of newJobs.slice(0, 10)) {
        const company = job.company || "Unknown";
        const title = job.title || "Unknown title";
        console.log(`  [${job.source}] ${title} @ ${company}`);
        console.log(`    ${job.jobUrl}`);
      }
      if (newJobs.length > 10) {
        console.log(`  ... and ${newJobs.length - 10} more`);
      }
    }
    return;
  }

  // 6. Save cache
  if (newCount > 0) {
    saveCache(cache);
    console.log(`\nCache saved: ${CACHE_PATH}`);
  } else {
    console.log("\nNo new jobs - cache unchanged.");
  }

  // 7. Optionally run scoring
  if (options.runScore && newCount > 0) {
    console.log("\nRunning job-qualify.js...");
    console.log("─".repeat(50));
    try {
      execFileSync("node", [path.join(__dirname, "job-qualify.js")], {
        stdio: "inherit",
      });
    } catch (err) {
      console.error("Scoring failed:", err.message);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
