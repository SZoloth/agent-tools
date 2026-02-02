#!/usr/bin/env node

/**
 * company-intel.js - Company stability and market health intelligence
 *
 * Aggregates data from:
 * - layoffs.fyi (via Google Sheets export) - stability signal
 * - ramp.com/vendors - B2B SaaS market health signal
 *
 * Usage:
 *   company-intel.js layoffs "Stripe"      # Check layoffs.fyi for company
 *   company-intel.js ramp "Stripe"         # Check Ramp vendors for company
 *   company-intel.js all "Stripe"          # Check all sources
 *   company-intel.js batch companies.txt   # Batch process companies from file
 *   company-intel.js cache --refresh       # Refresh cached data
 *   company-intel.js cache --status        # Show cache status
 *
 * Scoring:
 *   Uses 12-month half-life decay for recency weighting.
 *   Graduated penalty by layoff percentage: <5%=-1, 5-15%=-3, >15%=-5
 *
 * Output: JSON with layoffs history, weighted risk scores, and market health signals
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// CONFIGURATION
// ============================================================================

const CACHE_DIR = path.join(process.env.HOME, ".claude/cache/company-intel");
const LOOKUPS_DIR = path.join(CACHE_DIR, "lookups");
const LAYOFFS_CACHE = path.join(CACHE_DIR, "layoffs-fyi-dump.json");
const RAMP_CACHE = path.join(CACHE_DIR, "ramp-vendors.json");

// Google Sheets export URL for layoffs data
const LAYOFFS_SHEETS_ID = "1S8LHKLzoP8iRDg1zW8WTV0J-XlEUd5FLtgVyuxG9Fhk";
const LAYOFFS_CSV_URL = `https://docs.google.com/spreadsheets/d/${LAYOFFS_SHEETS_ID}/export?format=csv`;

// Ramp vendors base URL
const RAMP_BASE_URL = "https://ramp.com/vendors";

// Cache TTL: 7 days for lookups, refresh full cache weekly
const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Known B2B SaaS categories (for Ramp scope filtering)
const B2B_SAAS_INDICATORS = [
  "software", "saas", "platform", "cloud", "api", "enterprise",
  "b2b", "developer", "devtools", "infrastructure", "analytics",
  "data", "security", "payments", "fintech", "hr", "crm", "marketing",
  "sales", "productivity", "collaboration", "communication"
];

// ============================================================================
// CACHE HELPERS
// ============================================================================

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOOKUPS_DIR)) {
    fs.mkdirSync(LOOKUPS_DIR, { recursive: true });
  }
}

function getCacheAge(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

function isCacheValid(filePath, ttlMs = CACHE_TTL_MS) {
  return getCacheAge(filePath) < ttlMs;
}

function readCache(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(filePath, data) {
  ensureCacheDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function getLookupPath(company) {
  return path.join(LOOKUPS_DIR, `${slugify(company)}.json`);
}

/**
 * Get data freshness info for output.
 * Warns if layoffs cache is >7 days old.
 */
function getDataFreshness() {
  const layoffsAgeMs = getCacheAge(LAYOFFS_CACHE);
  const rampAgeMs = getCacheAge(RAMP_CACHE);

  const layoffsAgeHours = layoffsAgeMs === Infinity ? null : Math.floor(layoffsAgeMs / (60 * 60 * 1000));
  const rampAgeHours = rampAgeMs === Infinity ? null : Math.floor(rampAgeMs / (60 * 60 * 1000));

  return {
    layoffs_cache_age_hours: layoffsAgeHours,
    ramp_cache_age_hours: rampAgeHours,
    stale_warning: layoffsAgeHours !== null && layoffsAgeHours > 168 // >7 days
  };
}

// ============================================================================
// LAYOFFS.FYI DATA
// ============================================================================

async function fetchLayoffsCSV() {
  console.error("  Fetching layoffs.fyi data from Google Sheets...");

  try {
    const response = await fetch(LAYOFFS_CSV_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/csv,*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const csv = await response.text();
    return parseLayoffsCSV(csv);
  } catch (err) {
    console.error(`  Error fetching layoffs data: ${err.message}`);
    return null;
  }
}

function parseLayoffsCSV(csv) {
  const lines = csv.split("\n");
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const entries = [];

  // Find column indices
  const companyIdx = headers.findIndex(h => h.toLowerCase().includes("company"));
  const countIdx = headers.findIndex(h => h.toLowerCase().includes("no.") || h.toLowerCase().includes("number") || h.toLowerCase().includes("layoff"));
  const percentIdx = headers.findIndex(h => h.toLowerCase().includes("%"));
  const dateIdx = headers.findIndex(h => h.toLowerCase().includes("date") || h.toLowerCase().includes("announced"));
  const industryIdx = headers.findIndex(h => h.toLowerCase().includes("industry"));
  const hqIdx = headers.findIndex(h => h.toLowerCase().includes("hq") || h.toLowerCase().includes("headquarters"));
  const statusIdx = headers.findIndex(h => h.toLowerCase().includes("status"));

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    if (values.length < 3) continue;

    const company = values[companyIdx]?.trim();
    if (!company) continue;

    const countRaw = countIdx >= 0 ? values[countIdx]?.trim() : "";
    const percentRaw = percentIdx >= 0 ? values[percentIdx]?.trim() : "";
    const dateRaw = dateIdx >= 0 ? values[dateIdx]?.trim() : "";
    const industry = industryIdx >= 0 ? values[industryIdx]?.trim() : "";
    const hq = hqIdx >= 0 ? values[hqIdx]?.trim() : "";
    const status = statusIdx >= 0 ? values[statusIdx]?.trim() : "";

    // Parse count
    let count = null;
    if (countRaw && countRaw.toLowerCase() !== "unclear") {
      const num = parseInt(countRaw.replace(/,/g, ""), 10);
      if (!isNaN(num)) count = num;
    }

    // Parse percent
    let percent = null;
    if (percentRaw && percentRaw !== "—" && percentRaw.toLowerCase() !== "unclear") {
      const pctMatch = percentRaw.match(/(\d+(?:\.\d+)?)/);
      if (pctMatch) percent = parseFloat(pctMatch[1]);
    }

    // Parse date
    let date = null;
    if (dateRaw) {
      const parsed = new Date(dateRaw);
      if (!isNaN(parsed.getTime())) {
        date = parsed.toISOString().split("T")[0];
      }
    }

    entries.push({
      company,
      count,
      percent,
      date,
      industry,
      hq,
      status,
    });
  }

  return entries;
}

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function getLayoffsData(forceRefresh = false) {
  ensureCacheDir();

  if (!forceRefresh && isCacheValid(LAYOFFS_CACHE)) {
    const cached = readCache(LAYOFFS_CACHE);
    if (cached) {
      console.error("  Using cached layoffs data");
      return cached;
    }
  }

  const data = await fetchLayoffsCSV();
  if (data) {
    writeCache(LAYOFFS_CACHE, {
      fetchedAt: new Date().toISOString(),
      entries: data,
    });
    console.error(`  Cached ${data.length} layoff entries`);
    return { fetchedAt: new Date().toISOString(), entries: data };
  }

  // Fall back to stale cache
  const stale = readCache(LAYOFFS_CACHE);
  if (stale) {
    console.error("  Using stale cached data (fetch failed)");
    return stale;
  }

  return { fetchedAt: null, entries: [] };
}

function searchLayoffs(layoffsData, companyName) {
  const normalized = companyName.toLowerCase().trim();
  const events = [];

  for (const entry of layoffsData.entries) {
    const entryName = entry.company.toLowerCase();
    // Match exact or partial (e.g., "Stripe" matches "Stripe, Inc.")
    if (entryName === normalized ||
        entryName.startsWith(normalized + " ") ||
        entryName.startsWith(normalized + ",") ||
        entryName.includes(` ${normalized} `) ||
        entryName.includes(`(${normalized})`)
    ) {
      events.push(entry);
    }
  }

  // Sort by date (most recent first)
  events.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  return events;
}

/**
 * Normalize company name for matching.
 * Removes common suffixes (Inc., LLC, Corp.) and punctuation.
 */
function normalizeCompanyName(name) {
  return name.toLowerCase()
    .replace(/,?\s*(inc\.?|llc\.?|corp\.?|corporation|ltd\.?|co\.?|company|holdings?)$/i, '')
    .replace(/[^\w\s]/g, '')
    .trim();
}

/**
 * Calculate match confidence between query and target company name.
 * Returns 0-1 score based on match quality.
 */
function calculateMatchConfidence(queryNorm, targetNorm, targetOriginal) {
  // Exact match after normalization
  if (targetNorm === queryNorm) return 1.0;

  // Target starts with query + space (e.g., "stripe inc" starts with "stripe ")
  if (targetNorm.startsWith(queryNorm + " ")) return 0.95;

  // Target starts with query (e.g., "stripeco" starts with "stripe")
  if (targetNorm.startsWith(queryNorm)) return 0.9;

  // Query appears as a word in target
  if (targetNorm.includes(` ${queryNorm} `)) return 0.8;
  if (targetNorm.startsWith(`${queryNorm} `) || targetNorm.endsWith(` ${queryNorm}`)) return 0.8;

  // Query is contained somewhere in target
  if (targetNorm.includes(queryNorm)) return 0.7;

  return 0;
}

/**
 * Search layoffs data with confidence scoring for multiple matches.
 * Returns all matching companies grouped with their events.
 */
function searchLayoffsWithConfidence(layoffsData, companyName) {
  const queryNorm = normalizeCompanyName(companyName);
  const matchGroups = new Map(); // company name -> { name, confidence, events }

  for (const entry of layoffsData.entries) {
    const entryNorm = normalizeCompanyName(entry.company);
    const confidence = calculateMatchConfidence(queryNorm, entryNorm, entry.company);

    if (confidence > 0) {
      const key = entry.company;
      if (!matchGroups.has(key)) {
        matchGroups.set(key, { name: entry.company, confidence, events: [] });
      }
      matchGroups.get(key).events.push(entry);
    }
  }

  // Sort events within each match group by date (most recent first)
  for (const group of matchGroups.values()) {
    group.events.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date) - new Date(a.date);
    });
  }

  // Convert to array and sort by confidence (highest first)
  const matches = Array.from(matchGroups.values())
    .sort((a, b) => b.confidence - a.confidence);

  return {
    matches,
    selectedMatch: matches[0]?.name || null,
    alternativesFound: matches.length > 1
  };
}

/**
 * Calculate weighted layoff risk using 12-month half-life decay.
 * Each layoff event contributes a penalty weighted by recency.
 *
 * Base penalty by percentage:
 *   - <5% layoff: -1 point
 *   - 5-15% layoff: -3 points
 *   - >15% layoff: -5 points
 *   - Unknown %: -1 point (conservative)
 *
 * Decay: contribution = basePenalty * 0.5^(days_since/365)
 */
function calculateWeightedScore(events) {
  if (events.length === 0) {
    return {
      weightedScore: 0,
      riskLevel: "none",
      reason: "No layoffs found in records",
      components: []
    };
  }

  const HALF_LIFE_DAYS = 365; // 12-month half-life
  let totalScore = 0;
  const components = [];
  let mostRecentDaysAgo = null;

  for (const event of events) {
    if (!event.date) continue;

    const eventDate = new Date(event.date);
    const daysSince = Math.floor((Date.now() - eventDate.getTime()) / (24 * 60 * 60 * 1000));

    if (mostRecentDaysAgo === null || daysSince < mostRecentDaysAgo) {
      mostRecentDaysAgo = daysSince;
    }

    const decayMultiplier = Math.pow(0.5, daysSince / HALF_LIFE_DAYS);

    // Base penalty by percentage
    let basePenalty = -1; // default for unknown %
    const pct = event.percent;
    if (pct !== null && pct !== undefined) {
      if (pct > 15) basePenalty = -5;
      else if (pct >= 5) basePenalty = -3;
      else basePenalty = -1;
    }

    const contribution = basePenalty * decayMultiplier;
    totalScore += contribution;

    components.push({
      date: event.date,
      percent: pct,
      count: event.count,
      basePenalty,
      decayMultiplier: Math.round(decayMultiplier * 1000) / 1000,
      contribution: Math.round(contribution * 100) / 100
    });
  }

  // Round to 2 decimal places
  const roundedScore = Math.round(totalScore * 100) / 100;

  // Determine risk level from weighted score
  let riskLevel;
  let reason;
  if (roundedScore <= -3) {
    riskLevel = "high";
    reason = `Weighted score ${roundedScore} (significant recent layoffs)`;
  } else if (roundedScore <= -1) {
    riskLevel = "medium";
    reason = `Weighted score ${roundedScore} (moderate layoff history)`;
  } else if (roundedScore < 0) {
    riskLevel = "low";
    reason = `Weighted score ${roundedScore} (minor/older layoffs)`;
  } else {
    riskLevel = "none";
    reason = "No significant layoff impact";
  }

  return {
    weightedScore: roundedScore,
    riskLevel,
    reason,
    daysAgo: mostRecentDaysAgo,
    components
  };
}

// Legacy function for backwards compatibility
function calculateLayoffRisk(events) {
  const weighted = calculateWeightedScore(events);
  return {
    score: weighted.riskLevel,
    daysAgo: weighted.daysAgo,
    reason: weighted.reason
  };
}

// ============================================================================
// RAMP VENDORS DATA
// ============================================================================

async function fetchRampVendor(vendorSlug) {
  const url = `${RAMP_BASE_URL}/${vendorSlug}`;
  console.error(`  Checking Ramp vendors for ${vendorSlug}...`);

  // Ramp uses client-side rendering, so we can only check if the page exists
  // and note that the user can manually check for detailed metrics
  try {
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });

    if (response.status === 404) {
      return { found: false, reason: "Vendor not listed on Ramp" };
    }

    if (response.ok) {
      // Vendor exists, but we can't extract metrics without browser automation
      return {
        found: true,
        slug: vendorSlug,
        url: url,
        note: "Vendor exists on Ramp. Visit URL for adoption metrics (requires browser).",
        // Placeholder values - actual data requires browser automation
        category: null,
        adoption: null,
        adoptionChange: null,
        categoryRank: null,
      };
    }

    return { found: false, reason: `HTTP ${response.status}` };
  } catch (err) {
    console.error(`  Error checking Ramp: ${err.message}`);
    return { found: false, reason: `Check failed: ${err.message}` };
  }
}

function calculateMarketHealth(rampData) {
  if (!rampData.found) {
    return { signal: "not_applicable", reason: rampData.reason };
  }

  // If we have adoption data (from manual input or future browser automation)
  const adoption = rampData.adoption;
  const change = rampData.adoptionChange;
  const rank = rampData.categoryRank;

  if (adoption !== null) {
    // Strong: high adoption + growing or #1 rank
    if ((adoption >= 80 && (change === null || change >= 0)) || rank === 1) {
      return { signal: "strong", reason: `${adoption}% adoption, category leader` };
    }

    // Growing: increasing adoption
    if (change !== null && change > 0) {
      return { signal: "growing", reason: `Adoption up ${change}% YoY` };
    }

    // Stable: decent adoption, not declining much
    if (adoption >= 50 && (change === null || change >= -5)) {
      return { signal: "stable", reason: `${adoption}% adoption, stable` };
    }

    // Declining: significant adoption loss
    if (change !== null && change < -5) {
      return { signal: "declining", reason: `Adoption down ${Math.abs(change)}% YoY` };
    }
  }

  // Vendor exists but no detailed metrics available
  if (rampData.found && rampData.url) {
    return { signal: "listed", reason: `Listed on Ramp - check ${rampData.url} for metrics` };
  }

  return { signal: "unknown", reason: "Insufficient data" };
}

function isLikelyB2BSaaS(companyName, layoffsData) {
  // Check if company appears in layoffs with a B2B indicator
  const events = searchLayoffs(layoffsData, companyName);
  for (const event of events) {
    const industry = (event.industry || "").toLowerCase();
    if (B2B_SAAS_INDICATORS.some(ind => industry.includes(ind))) {
      return true;
    }
  }

  // Heuristic: check company name for tech indicators
  const nameLC = companyName.toLowerCase();
  const techIndicators = ["ai", "io", "tech", "cloud", "data", "labs", "soft", "api"];
  if (techIndicators.some(ind => nameLC.includes(ind))) {
    return true;
  }

  // Default: assume yes for tech companies (can be refined)
  return true;
}

// ============================================================================
// COMBINED LOOKUP
// ============================================================================

async function lookupCompany(companyName, sources = ["layoffs", "ramp"], skipCache = false) {
  const lookupPath = getLookupPath(companyName);

  // Check cached lookup
  if (!skipCache && isCacheValid(lookupPath, LOOKUP_TTL_MS)) {
    const cached = readCache(lookupPath);
    if (cached) {
      console.error(`  Using cached lookup for ${companyName}`);
      return cached;
    }
  }

  const result = {
    company: companyName,
    lookupAt: new Date().toISOString(),
    data_freshness: getDataFreshness(),
    layoffs: null,
    ramp: null,
  };

  // Get layoffs data
  if (sources.includes("layoffs")) {
    const layoffsData = await getLayoffsData();

    // Use confidence-based matching
    const matchResult = searchLayoffsWithConfidence(layoffsData, companyName);

    // Get events from the best match (or empty if no matches)
    const bestMatch = matchResult.matches[0];
    const events = bestMatch?.events || [];

    // Calculate weighted scoring
    const scoring = calculateWeightedScore(events);

    result.layoffs = {
      found: matchResult.matches.length > 0,
      matches: matchResult.matches.map(m => ({
        name: m.name,
        confidence: m.confidence,
        event_count: m.events.length,
        events: m.events.slice(0, 5) // Limit events per match
      })),
      selected_match: matchResult.selectedMatch,
      alternatives_found: matchResult.alternativesFound,
      weighted_score: scoring.weightedScore,
      risk_level: scoring.riskLevel,
      scoring_components: scoring.components,
      last_layoff_days_ago: scoring.daysAgo,
      total_laid_off: events.reduce((sum, e) => sum + (e.count || 0), 0),
      // Legacy fields for backwards compatibility
      events: events.slice(0, 5),
      riskScore: scoring.riskLevel,
      riskReason: scoring.reason,
    };
  }

  // Get Ramp data (only for B2B SaaS)
  if (sources.includes("ramp")) {
    const layoffsData = await getLayoffsData();
    if (isLikelyB2BSaaS(companyName, layoffsData)) {
      const vendorSlug = slugify(companyName);
      const rampData = await fetchRampVendor(vendorSlug);
      const health = calculateMarketHealth(rampData);

      result.ramp = {
        ...rampData,
        healthSignal: health.signal,
        healthReason: health.reason,
      };
    } else {
      result.ramp = {
        found: false,
        reason: "Company not identified as B2B SaaS",
        healthSignal: "not_applicable",
      };
    }
  }

  // Cache the lookup
  writeCache(lookupPath, result);
  return result;
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

async function refreshCache() {
  console.error("Refreshing company intel cache...\n");

  // Refresh layoffs data
  console.error("=== Layoffs.fyi ===");
  const layoffs = await fetchLayoffsCSV();
  if (layoffs) {
    writeCache(LAYOFFS_CACHE, {
      fetchedAt: new Date().toISOString(),
      entries: layoffs,
    });
    console.error(`  Cached ${layoffs.length} entries\n`);
  }

  // Clear old lookups
  console.error("=== Clearing stale lookups ===");
  try {
    const files = fs.readdirSync(LOOKUPS_DIR);
    let cleared = 0;
    for (const file of files) {
      const filePath = path.join(LOOKUPS_DIR, file);
      if (!isCacheValid(filePath, LOOKUP_TTL_MS)) {
        fs.unlinkSync(filePath);
        cleared++;
      }
    }
    console.error(`  Cleared ${cleared} stale lookup files\n`);
  } catch (err) {
    console.error(`  Error clearing lookups: ${err.message}\n`);
  }

  console.error("Cache refresh complete.");
}

function showCacheStatus() {
  console.error("=== Cache Status ===\n");

  // Layoffs cache
  const layoffsAge = getCacheAge(LAYOFFS_CACHE);
  if (layoffsAge === Infinity) {
    console.error("Layoffs cache: NOT FOUND");
  } else {
    const ageDays = Math.floor(layoffsAge / (24 * 60 * 60 * 1000));
    const cached = readCache(LAYOFFS_CACHE);
    const count = cached?.entries?.length || 0;
    console.error(`Layoffs cache: ${count} entries, ${ageDays} days old`);
    console.error(`  Valid: ${isCacheValid(LAYOFFS_CACHE) ? "yes" : "no (stale)"}`);
  }

  // Ramp cache
  const rampAge = getCacheAge(RAMP_CACHE);
  if (rampAge === Infinity) {
    console.error("Ramp cache: NOT FOUND (fetched on-demand per vendor)");
  } else {
    const ageDays = Math.floor(rampAge / (24 * 60 * 60 * 1000));
    console.error(`Ramp cache: ${ageDays} days old`);
  }

  // Lookup cache
  try {
    const files = fs.readdirSync(LOOKUPS_DIR);
    const validCount = files.filter(f =>
      isCacheValid(path.join(LOOKUPS_DIR, f), LOOKUP_TTL_MS)
    ).length;
    console.error(`\nLookup cache: ${files.length} entries (${validCount} valid)`);
  } catch {
    console.error("\nLookup cache: NOT INITIALIZED");
  }
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

async function runBatch(filePath, sources, jsonOnly) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const companies = content.split('\n').map(c => c.trim()).filter(Boolean);

  if (companies.length === 0) {
    console.error("Error: No companies found in file");
    process.exit(1);
  }

  console.error(`Processing ${companies.length} companies...`);
  const results = [];

  for (const company of companies) {
    console.error(`  ${company}...`);
    const result = await lookupCompany(company, sources);
    results.push(result);
  }

  if (jsonOnly) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(formatOutput(result));
      console.log("─".repeat(60) + "\n");
    }
  }

  return results;
}

// ============================================================================
// CLI
// ============================================================================

function printUsage() {
  console.log(`Usage: company-intel.js <command> [options]

Commands:
  layoffs <company>     Check layoffs.fyi for company
  ramp <company>        Check Ramp vendors for company (B2B SaaS only)
  all <company>         Check all sources
  batch <file>          Process companies from file (one per line)
  cache --refresh       Refresh cached data from sources
  cache --status        Show cache status

Options:
  --json                Output JSON only (no formatting)
  --no-cache            Skip cache, fetch fresh data

Scoring:
  Uses 12-month half-life decay for recency weighting.
  Graduated penalty: <5% layoff=-1, 5-15%=-3, >15%=-5

Examples:
  company-intel.js all "Stripe"
  company-intel.js layoffs "WeWork"
  company-intel.js ramp "Figma"
  company-intel.js batch companies.txt --json
  company-intel.js cache --refresh`);
}

function formatOutput(result) {
  let output = "";

  output += `\n=== Company Intel: ${result.company} ===\n`;
  output += `Lookup: ${result.lookupAt}\n`;

  // Data freshness warning
  if (result.data_freshness?.stale_warning) {
    const hours = result.data_freshness.layoffs_cache_age_hours;
    const days = Math.floor(hours / 24);
    output += `\n⚠️  DATA STALE: Layoffs cache is ${days} days old. Run 'cache --refresh'\n`;
  }
  output += "\n";

  if (result.layoffs) {
    output += "--- Layoffs.fyi ---\n";
    if (result.layoffs.found) {
      // Show selected match and alternatives
      output += `Matched: ${result.layoffs.selected_match}`;
      if (result.layoffs.alternatives_found) {
        const altCount = result.layoffs.matches.length - 1;
        output += ` (+${altCount} alternative match${altCount > 1 ? 'es' : ''})\n`;
        output += `Alternatives: ${result.layoffs.matches.slice(1).map(m => m.name).join(', ')}\n`;
      } else {
        output += "\n";
      }

      output += `Weighted Score: ${result.layoffs.weighted_score}\n`;
      output += `Risk Level: ${result.layoffs.risk_level.toUpperCase()}\n`;

      if (result.layoffs.last_layoff_days_ago !== null) {
        output += `Last Layoff: ${result.layoffs.last_layoff_days_ago} days ago\n`;
      }
      if (result.layoffs.total_laid_off > 0) {
        output += `Total Laid Off: ${result.layoffs.total_laid_off.toLocaleString()}\n`;
      }

      // Show scoring breakdown
      if (result.layoffs.scoring_components?.length > 0) {
        output += "\nScoring Breakdown:\n";
        for (const c of result.layoffs.scoring_components.slice(0, 5)) {
          const pctStr = c.percent !== null ? `${c.percent}%` : "?%";
          output += `  ${c.date}: ${pctStr} → ${c.basePenalty} × ${c.decayMultiplier} = ${c.contribution}\n`;
        }
        if (result.layoffs.scoring_components.length > 5) {
          output += `  ... and ${result.layoffs.scoring_components.length - 5} more events\n`;
        }
      }
    } else {
      output += "No layoffs found in records.\n";
      output += `Risk Level: NONE (clean record)\n`;
    }
    output += "\n";
  }

  if (result.ramp) {
    output += "--- Ramp Vendors ---\n";
    if (result.ramp.found) {
      output += `Status: Listed on Ramp\n`;
      if (result.ramp.url) {
        output += `URL: ${result.ramp.url}\n`;
      }
      if (result.ramp.category) {
        output += `Category: ${result.ramp.category}\n`;
      }
      if (result.ramp.categoryRank) {
        output += `Category Rank: #${result.ramp.categoryRank}\n`;
      }
      if (result.ramp.adoption !== null) {
        output += `Adoption: ${result.ramp.adoption}%`;
        if (result.ramp.adoptionChange !== null) {
          const dir = result.ramp.adoptionChange >= 0 ? "+" : "";
          output += ` (${dir}${result.ramp.adoptionChange}% YoY)`;
        }
        output += "\n";
      }
      output += `Health Signal: ${result.ramp.healthSignal.toUpperCase()}\n`;
      if (result.ramp.note) {
        output += `Note: ${result.ramp.note}\n`;
      }
    } else {
      output += `Not found: ${result.ramp.reason}\n`;
      output += `Health Signal: ${result.ramp.healthSignal.toUpperCase()}\n`;
    }
    output += "\n";
  }

  return output;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const command = args[0];
  let companyName = null;
  let jsonOnly = false;
  let noCache = false;

  // Parse arguments
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonOnly = true;
    } else if (arg === "--no-cache") {
      noCache = true;
    } else if (arg === "--refresh" || arg === "--status") {
      // Handled below
    } else if (!arg.startsWith("-")) {
      companyName = arg;
    }
  }

  // Handle cache commands
  if (command === "cache") {
    if (args.includes("--refresh")) {
      await refreshCache();
    } else if (args.includes("--status")) {
      showCacheStatus();
    } else {
      console.error("Usage: company-intel.js cache --refresh|--status");
      process.exit(1);
    }
    return;
  }

  // Handle batch command
  if (command === "batch") {
    const filePath = args[1];
    if (!filePath) {
      console.error("Error: batch requires a file path");
      console.error("Usage: company-intel.js batch <file.txt> [--json]");
      process.exit(1);
    }
    await runBatch(filePath, ["layoffs", "ramp"], jsonOnly);
    return;
  }

  // Validate company name for lookup commands
  if (!companyName && ["layoffs", "ramp", "all"].includes(command)) {
    console.error(`Error: Missing company name for '${command}' command`);
    printUsage();
    process.exit(1);
  }

  // Determine sources
  let sources = [];
  switch (command) {
    case "layoffs":
      sources = ["layoffs"];
      break;
    case "ramp":
      sources = ["ramp"];
      break;
    case "all":
      sources = ["layoffs", "ramp"];
      break;
    default:
      // Assume command is company name for convenience
      companyName = command;
      sources = ["layoffs", "ramp"];
  }

  // Force refresh if --no-cache
  if (noCache) {
    const lookupPath = getLookupPath(companyName);
    try {
      fs.unlinkSync(lookupPath);
    } catch {}
  }

  // Run lookup
  const result = await lookupCompany(companyName, sources);

  // Output
  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatOutput(result));
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
