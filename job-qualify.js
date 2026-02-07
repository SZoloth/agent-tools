#!/usr/bin/env node

/**
 * job-qualify.js - CMF (Candidate Market Fit) scoring engine
 *
 * Scores job listings against Sam's sweet spots and filters for qualification.
 * Based on criteria from job-search-context.md.
 *
 * Usage:
 *   job-qualify.js                    # Score all new listings
 *   job-qualify.js --threshold 60     # Custom threshold (default: 70)
 *   job-qualify.js --rescore          # Re-score all listings
 *   job-qualify.js --show-qualified   # Show qualified listings
 *   job-qualify.js --json             # Output as JSON
 *   job-qualify.js --verbose          # Show detailed scoring breakdown
 *
 * Scoring weights:
 *   - Sweet Spot Match: 32%
 *   - Company Tier: 18%
 *   - Role Level: 14%
 *   - Location: 18%
 *   - Freshness: 8%
 *   - Salary: 10%
 */

import fs from "fs";
import path from "path";

const CACHE_PATH = path.join(
  process.env.HOME,
  ".claude/state/job-listings-cache.json"
);

const DEFAULT_THRESHOLD = 70;

// ============================================================================
// CMF SWEET SPOTS - From job-search-context.md
// ============================================================================

const SWEET_SPOTS = {
  // Sweet Spot 1: Product Strategy/Ops at Scale (PRIMARY - 60% effort)
  strategyOps: {
    score: 100,
    patterns: [
      /product\s+strateg/i,
      /product\s+ops/i,
      /product\s+operations/i,
      /head\s+of\s+product\s+ops/i,
      /director.*product\s+strateg/i,
      /vp.*product\s+strateg/i,
      /strategic\s+ops/i,
    ],
  },

  // Sweet Spot 2: Founding PM at Pre-PMF (30% effort)
  foundingPM: {
    score: 90,
    patterns: [
      /founding\s+(pm|product)/i,
      /first\s+(pm|product)/i,
      /head\s+of\s+product.*startup/i,
      /product.*series\s*a/i,
      /0-1\s+product/i,
      /zero\s+to\s+one/i,
    ],
  },

  // Sweet Spot 3: Chief of Staff (10% effort)
  chiefOfStaff: {
    score: 80,
    patterns: [
      /chief\s+of\s+staff/i,
      /cos.*product/i,
      /cos.*ceo/i,
      /cos.*cpo/i,
      /strategic\s+operations/i,
    ],
  },

  // Sweet Spot 4: PE Portfolio
  pePortfolio: {
    score: 70,
    patterns: [
      /product\s+strategy\s+lead/i,
      /product\s+ops\s+director/i,
      /vp\s+product\s+ops/i,
      /head\s+of\s+product.*b2b/i,
      /transformation/i,
      /modernization/i,
    ],
  },

  // Core PM roles (good fit)
  corePM: {
    score: 75,
    patterns: [
      /senior\s+product\s+manager/i,
      /staff\s+product\s+manager/i,
      /principal\s+product/i,
      /group\s+product\s+manager/i,
      /lead\s+product\s+manager/i,
      // AI/ML PM roles
      /ai\s+product/i,
      /ml\s+product/i,
      /product.*\bai\b/i,
      /product.*machine\s+learning/i,
      /product.*llm/i,
      // Growth/Platform PM roles
      /growth\s+product/i,
      /platform\s+product/i,
      /product.*growth/i,
      /product.*platform/i,
      // Technical PM
      /technical\s+product\s+manager/i,
      /product\s+manager.*engineer/i,
    ],
  },
};

// ============================================================================
// COMPANY TIERS - From job-search-context.md
// ============================================================================

const COMPANY_TIERS = {
  // Primary targets (Tier 1)
  target: {
    score: 100,
    companies: [
      'databricks', 'snowflake', 'atlassian', 'adobe', 'palantir', 'stripe',
    ],
  },

  // Stretch targets (Tier 1.5)
  stretch: {
    score: 95,
    companies: [
      'canva', 'figma', 'notion', 'linear', 'anthropic', 'openai',
    ],
  },

  // Pipeline / Known good (Tier 2)
  known: {
    score: 80,
    companies: [
      'sandboxaq', 'vercel', 'supabase', 'replit', 'ramp', 'coinbase',
      'airbnb', 'lyft', 'uber', 'doordash', 'instacart', 'robinhood',
      'plaid', 'square', 'affirm', 'brex', 'carta', 'rippling',
      'retool', 'airtable', 'coda', 'miro', 'loom', 'calendly',
      'zapier', 'webflow', 'framer', 'descript', 'runway', 'stability',
      'cohere', 'mistral', 'perplexity', 'cursor', 'rewind',
      'epic games', 'unity', 'autodesk', 'hubspot', 'zendesk',
    ],
  },

  // Unknown (Tier 3) - default
  unknown: {
    score: 50,
  },
};

// ============================================================================
// ROLE LEVEL SCORING
// ============================================================================

const ROLE_LEVELS = {
  // Senior/Staff level (ideal)
  senior: {
    score: 100,
    patterns: [
      /\bstaff\b/i,
      /\bsenior\b/i,
      /\bsr\.?\b/i,
      /\blead\b/i,
      /\bprincipal\b/i,
    ],
  },

  // Director+ level (stretch)
  director: {
    score: 90,
    patterns: [
      /\bdirector\b/i,
      /\bhead\s+of\b/i,
      /\bvp\b/i,
      /\bvice\s+president\b/i,
      /\bgm\b/i,
      /\bgeneral\s+manager\b/i,
    ],
  },

  // Mid-level (okay)
  mid: {
    score: 70,
    patterns: [
      /\bproduct\s+manager\b/i,
      /\bpm\b/i,
    ],
  },

  // Entry level (low fit)
  entry: {
    score: 40,
    patterns: [
      /\bjunior\b/i,
      /\bassociate\b/i,
      /\bentry\b/i,
      /\bintern\b/i,
    ],
  },
};

// ============================================================================
// LOCATION SCORING - Priority order per job-search-specialist plan
// ============================================================================

const LOCATION_SCORES = {
  // Priority 1: Denver (home base)
  denver: {
    score: 100,
    patterns: [
      /\bdenver\b/i,
      /\bcolorado\b/i,
      /\bco\b/i,
      /\bboulder\b/i,
    ],
  },
  // Priority 2: Remote/Hybrid (flexibility)
  remote: {
    score: 90,
    patterns: [
      /\bremote\b/i,
      /\bhybrid\b/i,
      /\bwork\s+from\s+home\b/i,
      /\bwfh\b/i,
      /\banywhere\b/i,
      /\bfully\s+remote\b/i,
      /\bus\s+remote\b/i,
      /\busa\s+remote\b/i,
    ],
  },
  // Priority 3: Boston (familiar territory)
  boston: {
    score: 70,
    patterns: [
      /\bboston\b/i,
      /\bmassachusetts\b/i,
      /\bma\b/i,
      /\bcambridge\b/i,
    ],
  },
  // Priority 4: SF Bay Area (tech hub, but expensive)
  sfBay: {
    score: 60,
    patterns: [
      /\bsan\s+francisco\b/i,
      /\bsf\b/i,
      /\bbay\s+area\b/i,
      /\bsilicon\s+valley\b/i,
      /\bpalo\s+alto\b/i,
      /\bmountain\s+view\b/i,
      /\bsunnyvale\b/i,
      /\bsan\s+jose\b/i,
      /\boakland\b/i,
    ],
  },
  // Priority 5: NYC (acceptable but not preferred)
  nyc: {
    score: 50,
    patterns: [
      /\bnew\s+york\b/i,
      /\bnyc\b/i,
      /\bmanhattan\b/i,
      /\bbrooklyn\b/i,
    ],
  },
  // Default: Other locations
  other: {
    score: 30,
  },
};

function scoreLocation(location) {
  if (!location) return { location: 'unknown', score: 40 };

  const locationLower = location.toLowerCase();

  for (const [name, config] of Object.entries(LOCATION_SCORES)) {
    if (config.patterns) {
      for (const pattern of config.patterns) {
        if (pattern.test(locationLower)) {
          return { location: name, score: config.score };
        }
      }
    }
  }

  return { location: 'other', score: LOCATION_SCORES.other.score };
}

// ============================================================================
// FRESHNESS SCORING
// ============================================================================

function parsePostedTime(postedTime) {
  if (!postedTime) return null;

  const text = postedTime.toLowerCase();

  // Parse relative times
  const hourMatch = text.match(/(\d+)\s*hour/);
  if (hourMatch) return parseInt(hourMatch[1]);

  const dayMatch = text.match(/(\d+)\s*day/);
  if (dayMatch) return parseInt(dayMatch[1]) * 24;

  const weekMatch = text.match(/(\d+)\s*week/);
  if (weekMatch) return parseInt(weekMatch[1]) * 24 * 7;

  const monthMatch = text.match(/(\d+)\s*month/);
  if (monthMatch) return parseInt(monthMatch[1]) * 24 * 30;

  // Keywords
  if (text.includes('just now') || text.includes('moment')) return 0;
  if (text.includes('today')) return 12;
  if (text.includes('yesterday')) return 36;

  return null;
}

function scoreFreshness(postedTime) {
  const hoursAgo = parsePostedTime(postedTime);

  if (hoursAgo === null) return 50; // Unknown freshness

  if (hoursAgo <= 6) return 100;    // < 6 hours
  if (hoursAgo <= 24) return 80;   // < 24 hours
  if (hoursAgo <= 72) return 50;   // < 3 days
  if (hoursAgo <= 168) return 30;  // < 1 week
  return 10;                        // Older
}

// ============================================================================
// SALARY SCORING
// ============================================================================

function scoreSalary(listing) {
  const salaryMax = listing.salaryMax;

  // Unknown salary = neutral score
  if (!salaryMax) {
    return { tier: 'unknown', score: 50 };
  }

  // Score based on max salary (target: $150K-$180K)
  if (salaryMax >= 175000) {
    return { tier: 'excellent', score: 100 };
  }
  if (salaryMax >= 150000) {
    return { tier: 'good', score: 85 };
  }
  if (salaryMax >= 120000) {
    return { tier: 'below_target', score: 60 };
  }
  return { tier: 'low', score: 30 };
}

// ============================================================================
// SCORING FUNCTIONS
// ============================================================================

function scoreSweetSpot(title, company) {
  const text = `${title} ${company}`.toLowerCase();

  for (const [name, config] of Object.entries(SWEET_SPOTS)) {
    for (const pattern of config.patterns) {
      if (pattern.test(text)) {
        return { category: name, score: config.score };
      }
    }
  }

  return { category: 'other', score: 30 };
}

function scoreCompanyTier(company) {
  const companyLower = company.toLowerCase();

  for (const [tier, config] of Object.entries(COMPANY_TIERS)) {
    if (config.companies) {
      for (const targetCompany of config.companies) {
        if (companyLower.includes(targetCompany)) {
          return { tier, score: config.score };
        }
      }
    }
  }

  return { tier: 'unknown', score: COMPANY_TIERS.unknown.score };
}

function scoreRoleLevel(title) {
  const titleLower = title.toLowerCase();

  // Check for entry level first (penalize)
  for (const pattern of ROLE_LEVELS.entry.patterns) {
    if (pattern.test(titleLower)) {
      return { level: 'entry', score: ROLE_LEVELS.entry.score };
    }
  }

  // Check for senior+ levels
  for (const pattern of ROLE_LEVELS.director.patterns) {
    if (pattern.test(titleLower)) {
      return { level: 'director', score: ROLE_LEVELS.director.score };
    }
  }

  for (const pattern of ROLE_LEVELS.senior.patterns) {
    if (pattern.test(titleLower)) {
      return { level: 'senior', score: ROLE_LEVELS.senior.score };
    }
  }

  return { level: 'mid', score: ROLE_LEVELS.mid.score };
}

function calculateScore(listing) {
  const sweetSpot = scoreSweetSpot(listing.title, listing.company);
  const companyTier = scoreCompanyTier(listing.company);
  const roleLevel = scoreRoleLevel(listing.title);
  const location = scoreLocation(listing.location);
  const freshness = scoreFreshness(listing.postedTime);
  const salary = scoreSalary(listing);

  // Weighted calculation (updated weights to include salary)
  // Sweet Spot: 32%, Company Tier: 18%, Role Level: 14%, Location: 18%, Freshness: 8%, Salary: 10%
  const weightedScore = Math.round(
    sweetSpot.score * 0.32 +
    companyTier.score * 0.18 +
    roleLevel.score * 0.14 +
    location.score * 0.18 +
    freshness * 0.08 +
    salary.score * 0.10
  );

  return {
    total: weightedScore,
    breakdown: {
      sweetSpot: { ...sweetSpot, weight: 32 },
      companyTier: { ...companyTier, weight: 18 },
      roleLevel: { ...roleLevel, weight: 14 },
      location: { ...location, weight: 18 },
      freshness: { score: freshness, weight: 8 },
      salary: { ...salary, weight: 10 },
    },
  };
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
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);

  let threshold = DEFAULT_THRESHOLD;
  let rescore = false;
  let showQualified = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--threshold" || arg === "-t") threshold = parseInt(args[++i]);
    if (arg === "--rescore" || arg === "-r") rescore = true;
    if (arg === "--show-qualified" || arg === "-q") showQualified = true;
    if (arg === "--json" || arg === "-j") jsonOutput = true;
  }

  const log = (...parts) => {
    if (!jsonOutput) console.log(...parts);
  };

  const cache = loadCache();

  // Merge jobs from Python discovery daemon (email alerts)
  const discoveredPath = '/Users/samuelz/Documents/LLM CONTEXT/1 - personal/job_search/automation/discovered_jobs.json';
  if (fs.existsSync(discoveredPath)) {
    try {
      const discovered = JSON.parse(fs.readFileSync(discoveredPath, 'utf8'));
      let mergedCount = 0;

      // Handle both array format and object with jobs array
      const jobs = Array.isArray(discovered) ? discovered : (discovered.jobs || []);

      for (const job of jobs) {
        // Generate jobId from job data if not present
        const jobId = job.jobId || job.id || `email_${job.company}_${job.title}`.toLowerCase().replace(/\s+/g, '_');

        // Skip if already in cache
        if (cache.listings[jobId]) continue;

        // Add to cache with source marker
        cache.listings[jobId] = {
          title: job.title || 'Unknown Title',
          company: job.company || 'Unknown Company',
          location: job.location || '',
          jobUrl: job.url || job.jobUrl || '',
          postedTime: job.postedTime || job.posted || null,
          salaryMin: job.salaryMin || null,
          salaryMax: job.salaryMax || null,
          source: 'email_alert',
          discoveredAt: job.discoveredAt || new Date().toISOString(),
          addedAt: new Date().toISOString(),
          score: null,
          status: 'new'
        };
        mergedCount++;
      }

      if (mergedCount > 0) {
        log(`Merged ${mergedCount} jobs from email alerts`);
        saveCache(cache);
      }
    } catch (err) {
      console.error('Error merging discovered jobs:', err.message);
    }
  }
  const listings = Object.entries(cache.listings);

  if (listings.length === 0) {
    if (jsonOutput) {
      console.log(
        JSON.stringify({
          scoredThisRun: 0,
          qualifiedThisRun: 0,
          totalInCache: 0,
          totalQualified: 0,
          totalBelowThreshold: 0,
          threshold,
        })
      );
      return;
    }
    console.log("No listings in cache. Run job-scraper.js first.");
    process.exit(0);
  }

  let scoredCount = 0;
  let qualifiedCount = 0;
  const qualified = [];

  for (const [jobId, listing] of listings) {
    // Skip already scored unless rescore requested
    if (listing.score !== null && !rescore) continue;

    const scoreResult = calculateScore(listing);
    cache.listings[jobId].score = scoreResult.total;
    cache.listings[jobId].scoreBreakdown = scoreResult.breakdown;
    cache.listings[jobId].scoredAt = new Date().toISOString();

    if (scoreResult.total >= threshold) {
      cache.listings[jobId].status = "qualified";
      qualifiedCount++;
      qualified.push({ jobId, ...cache.listings[jobId] });
    } else {
      cache.listings[jobId].status = "below_threshold";
    }

    scoredCount++;
  }

  saveCache(cache);

  // Gather all qualified listings for display
  if (showQualified) {
    const allQualified = Object.entries(cache.listings)
      .filter(([_, l]) => l.status === "qualified")
      .map(([id, l]) => ({ jobId: id, ...l }))
      .sort((a, b) => b.score - a.score);

    if (jsonOutput) {
      console.log(JSON.stringify(allQualified, null, 2));
    } else {
      console.log(`\nQualified Listings (score >= ${threshold}):\n`);
      console.log("─".repeat(70));

      for (const listing of allQualified) {
        const sweetSpot = listing.scoreBreakdown?.sweetSpot?.category || "?";
        const tier = listing.scoreBreakdown?.companyTier?.tier || "?";
        const locationScore = listing.scoreBreakdown?.location?.location || "?";
        const locationPts = listing.scoreBreakdown?.location?.score || 0;
        const salaryTier = listing.scoreBreakdown?.salary?.tier || "unknown";
        const salaryMax = listing.salaryMax ? `$${(listing.salaryMax/1000).toFixed(0)}K` : "?";

        console.log(`[${listing.score}] ${listing.title}`);
        console.log(`     ${listing.company} | ${listing.location}`);
        console.log(`     Sweet spot: ${sweetSpot} | Tier: ${tier} | Location: ${locationScore} (${locationPts}pts)`);
        console.log(`     Salary: ${salaryMax} (${salaryTier})`);
        console.log(`     ${listing.jobUrl || "No URL"}`);
        console.log("");
      }

      console.log("─".repeat(70));
      console.log(`Total qualified: ${allQualified.length}`);
    }
  } else {
    // Summary output
    const totalInCache = Object.keys(cache.listings).length;
    const totalQualified = Object.values(cache.listings).filter(
      (l) => l.status === "qualified"
    ).length;
    const totalBelowThreshold = Object.values(cache.listings).filter(
      (l) => l.status === "below_threshold"
    ).length;

    if (jsonOutput) {
      console.log(
        JSON.stringify({
          scoredThisRun: scoredCount,
          qualifiedThisRun: qualifiedCount,
          totalInCache,
          totalQualified,
          totalBelowThreshold,
          threshold,
        })
      );
    } else {
      console.log(`\nCMF Qualification Results`);
      console.log("─".repeat(40));
      console.log(`Scored this run: ${scoredCount}`);
      console.log(`Qualified this run: ${qualifiedCount}`);
      console.log("");
      console.log(`Total in cache: ${totalInCache}`);
      console.log(`Total qualified: ${totalQualified}`);
      console.log(`Below threshold: ${totalBelowThreshold}`);
      console.log(`Threshold: ${threshold}`);
      console.log("─".repeat(40));

      if (qualifiedCount > 0) {
        console.log(`\nRun with --show-qualified to see details`);
      }
    }
  }
}

main();
