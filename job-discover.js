#!/usr/bin/env node

/**
 * job-discover.js - Unified job discovery coordinator
 *
 * Fetches jobs from multiple sources (ATS APIs, LinkedIn, Email alerts),
 * deduplicates, and merges into the job listings cache.
 *
 * Usage:
 *   job-discover.js                    # All sources (ATS + LinkedIn + Email)
 *   job-discover.js --ats              # ATS only (fast, no browser)
 *   job-discover.js --ats stripe figma # Specific companies only
 *   job-discover.js --linkedin         # LinkedIn only (requires browser)
 *   job-discover.js --email            # Email alerts only
 *   job-discover.js --since 6          # Last N hours
 *   job-discover.js --registry         # Show registered ATS companies
 *   job-discover.js --json             # JSON output
 *   job-discover.js --verbose          # Detailed output
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fetchMultipleBoards } from "./lib/greenhouse.js";
import { mergeJobs } from "./lib/deduplicator.js";

const CACHE_PATH = path.join(process.env.HOME, ".claude/state/job-listings-cache.json");
const REGISTRY_PATH = path.join(process.env.HOME, ".claude/state/ats-registry.json");

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    ats: false,
    atsCompanies: [],
    linkedin: false,
    email: false,
    since: 24,
    registry: false,
    json: false,
    verbose: false,
    all: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--ats") {
      options.ats = true;
      options.all = false;
      // Collect company names until next flag
      while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.atsCompanies.push(args[++i].toLowerCase());
      }
    } else if (arg === "--linkedin") {
      options.linkedin = true;
      options.all = false;
    } else if (arg === "--email") {
      options.email = true;
      options.all = false;
    } else if (arg === "--since") {
      options.since = parseInt(args[++i]) || 24;
    } else if (arg === "--registry") {
      options.registry = true;
    } else if (arg === "--json" || arg === "-j") {
      options.json = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  // If specific source flags set, disable 'all'
  if (options.ats || options.linkedin || options.email) {
    options.all = false;
  }

  return options;
}

function printHelp() {
  console.log(`
job-discover.js - Unified job discovery coordinator

Usage:
  job-discover.js                    # All sources (ATS + LinkedIn + Email)
  job-discover.js --ats              # ATS APIs only (fast, no browser)
  job-discover.js --ats stripe figma # Specific companies only
  job-discover.js --linkedin         # LinkedIn only (requires browser)
  job-discover.js --email            # Email alerts only
  job-discover.js --since 6          # Last N hours
  job-discover.js --registry         # Show registered ATS companies
  job-discover.js --json             # JSON output
  job-discover.js --verbose          # Detailed output

Examples:
  # Quick ATS scan of target companies
  job-discover.js --ats

  # Full discovery from all sources
  job-discover.js --verbose

  # Check specific company
  job-discover.js --ats anthropic
`);
}

// Load ATS registry
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    }
  } catch (err) {
    console.error("Error loading registry:", err.message);
  }
  return { companies: {}, endpoints: {} };
}

// Load job cache
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

// Save job cache
function saveCache(cache) {
  cache.lastUpdated = new Date().toISOString();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Show registry
function showRegistry(registry, json) {
  const companies = Object.entries(registry.companies).map(([key, info]) => ({
    key,
    ...info,
  }));

  if (json) {
    console.log(JSON.stringify({ companies, endpoints: registry.endpoints }, null, 2));
    return;
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  ATS REGISTRY — Registered Companies                          ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");

  // Group by tier
  const tiers = { target: [], stretch: [], known: [] };
  for (const company of companies) {
    if (tiers[company.tier]) {
      tiers[company.tier].push(company);
    } else {
      tiers.known.push(company);
    }
  }

  for (const [tier, list] of Object.entries(tiers)) {
    if (list.length === 0) continue;
    console.log(`║                                                              ║`);
    console.log(`║  ${tier.toUpperCase()} (${list.length})`.padEnd(63) + "║");
    console.log(`║  ${"─".repeat(60)}║`);

    const sorted = list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    const rows = [];
    for (let i = 0; i < sorted.length; i += 4) {
      const row = sorted
        .slice(i, i + 4)
        .map((c) => c.displayName.padEnd(14))
        .join(" ");
      rows.push(`║  ${row.padEnd(60)}║`);
    }
    rows.forEach((r) => console.log(r));
  }

  console.log("║                                                              ║");
  console.log(`║  Total: ${companies.length} companies`.padEnd(63) + "║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
}

// Fetch from ATS APIs
async function fetchFromATS(registry, options) {
  const { atsCompanies, verbose } = options;

  // Determine which companies to fetch
  let companies = Object.entries(registry.companies)
    .filter(([_, info]) => info.ats === "greenhouse")
    .map(([key, info]) => ({
      token: info.token,
      displayName: info.displayName,
      tier: info.tier,
    }));

  // Filter to specific companies if specified
  if (atsCompanies.length > 0) {
    companies = companies.filter(
      (c) =>
        atsCompanies.includes(c.token.toLowerCase()) ||
        atsCompanies.includes(c.displayName.toLowerCase())
    );
  }

  if (verbose) {
    console.log(`Fetching from ${companies.length} Greenhouse boards...`);
  }

  const result = await fetchMultipleBoards(companies, {
    concurrency: 5,
    filterProduct: true,
  });

  if (verbose && result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`  ${err.company}: ${err.error}`);
    }
    if (result.errors.length > 5) {
      console.log(`  ... and ${result.errors.length - 5} more`);
    }
  }

  return result;
}

// Fetch from email alerts (stub - would integrate with gmcli)
async function fetchFromEmail(options) {
  const { since, verbose } = options;

  if (verbose) {
    console.log(`Checking email alerts from last ${since} hours...`);
  }

  // This would call gmcli to search for job alerts
  // For now, return empty - the /job email command handles this interactively
  return { jobs: [], stats: { total: 0, parsed: 0 } };
}

// Fetch from LinkedIn (stub - requires browser)
async function fetchFromLinkedIn(options) {
  const { verbose } = options;

  if (verbose) {
    console.log("LinkedIn requires browser. Use /job scrape --fresh instead.");
  }

  // LinkedIn scraping requires browser automation
  // Return empty - the /job scrape command handles this
  return { jobs: [], stats: { total: 0, scraped: 0 } };
}

// Main discovery function
async function discover(options) {
  const registry = loadRegistry();
  const cache = loadCache();

  const results = {
    ats: null,
    email: null,
    linkedin: null,
  };

  const allJobs = [];

  // Fetch from enabled sources
  if (options.all || options.ats) {
    results.ats = await fetchFromATS(registry, options);
    allJobs.push(...results.ats.jobs);
  }

  if (options.all || options.email) {
    results.email = await fetchFromEmail(options);
    allJobs.push(...results.email.jobs);
  }

  if (options.linkedin) {
    results.linkedin = await fetchFromLinkedIn(options);
    allJobs.push(...results.linkedin.jobs);
  }

  // Merge into cache
  const { listings, stats } = mergeJobs(cache.listings, allJobs);
  cache.listings = listings;
  saveCache(cache);

  return {
    sources: results,
    merge: stats,
    totalInCache: Object.keys(listings).length,
  };
}

// Format output
function formatOutput(results, options) {
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║  JOB DISCOVERY RESULTS                                        ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");

  if (results.sources.ats) {
    const ats = results.sources.ats.stats;
    console.log("║                                                              ║");
    console.log("║  ATS (Greenhouse)                                            ║");
    console.log("║  ───────────────────────────────────────                     ║");
    console.log(`║  Boards fetched: ${ats.successful}/${ats.total}`.padEnd(63) + "║");
    console.log(`║  Product jobs found: ${ats.jobsFound}`.padEnd(63) + "║");
  }

  if (results.sources.email) {
    const email = results.sources.email.stats;
    console.log("║                                                              ║");
    console.log("║  Email Alerts                                                ║");
    console.log("║  ───────────────────────────────────────                     ║");
    console.log(`║  Emails checked: ${email.total}`.padEnd(63) + "║");
    console.log(`║  Jobs parsed: ${email.parsed}`.padEnd(63) + "║");
  }

  if (results.sources.linkedin) {
    console.log("║                                                              ║");
    console.log("║  LinkedIn                                                    ║");
    console.log("║  ───────────────────────────────────────                     ║");
    console.log("║  (Requires browser - use /job scrape)".padEnd(63) + "║");
  }

  console.log("║                                                              ║");
  console.log("║  MERGE RESULTS                                               ║");
  console.log("║  ───────────────────────────────────────                     ║");
  console.log(`║  New jobs added: ${results.merge.added}`.padEnd(63) + "║");
  console.log(`║  Existing updated: ${results.merge.updated}`.padEnd(63) + "║");
  console.log(`║  Duplicates merged: ${results.merge.duplicates}`.padEnd(63) + "║");
  console.log(`║  Total in cache: ${results.totalInCache}`.padEnd(63) + "║");

  console.log("║                                                              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  if (results.merge.added > 0) {
    console.log("\n→ Run job-qualify.js to score new listings");
    console.log("→ Run /job inbox to see qualified jobs");
  }
}

// Main
async function main() {
  const options = parseArgs();

  if (options.registry) {
    const registry = loadRegistry();
    showRegistry(registry, options.json);
    return;
  }

  try {
    const results = await discover(options);
    formatOutput(results, options);
  } catch (err) {
    console.error("Discovery failed:", err.message);
    if (options.verbose) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
