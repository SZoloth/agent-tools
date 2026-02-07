#!/usr/bin/env node

/**
 * job-fresh.js - LinkedIn job search with freshness filtering
 *
 * Uses Sam's CMF sweet spots + the f_TPR hack to surface fresh postings
 * Opens in Chrome via browser-tools for persistent session/cookies
 *
 * Usage:
 *   job-fresh.js                    # Default: Product Strategy/Ops, last 6 hours
 *   job-fresh.js --preset founding  # Founding PM roles
 *   job-fresh.js --preset cos       # Chief of Staff roles
 *   job-fresh.js --preset pe        # PE Portfolio roles
 *   job-fresh.js --preset all       # Open all presets in tabs
 *   job-fresh.js "custom keywords"  # Custom search
 *   job-fresh.js --hours 2          # Last 2 hours only
 *   job-fresh.js --company canva    # Filter to specific company
 *   job-fresh.js --list             # List all presets
 *   job-fresh.js --json             # JSON summary output
 */

import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// CONFIGURATION - Sam's CMF Sweet Spots
// ============================================================================

const PRESETS = {
  // Sweet Spot 1: Product Strategy/Ops at Scale (PRIMARY - 60%)
  strategy: {
    name: 'Product Strategy/Ops',
    keywords: [
      'Product Strategy',
      'Product Operations',
      'Head of Product Operations',
      'Director Product Strategy',
      'Senior Product Manager Strategy'
    ],
    description: 'Scale companies - Databricks, Snowflake, Atlassian, Adobe, Palantir, Stripe'
  },

  // Core PM roles
  pm: {
    name: 'Product Manager',
    keywords: [
      'Senior Product Manager',
      'Product Manager',
      'Lead Product Manager',
      'Principal Product Manager',
      'Group Product Manager'
    ],
    description: 'Core PM roles across levels'
  },

  // Sweet Spot 2: Founding PM (30%)
  founding: {
    name: 'Founding PM',
    keywords: [
      'Founding Product Manager',
      'First Product Manager',
      'Head of Product startup',
      'Product Manager Series A'
    ],
    description: 'Pre-PMF startups, $5-15M raised, 15-40 people'
  },

  // Sweet Spot 3: Chief of Staff (10%)
  cos: {
    name: 'Chief of Staff',
    keywords: [
      'Chief of Staff Product',
      'Chief of Staff CEO',
      'Chief of Staff CPO',
      'Strategic Operations'
    ],
    description: 'Series B/C growth stage, founder leverage'
  },

  // Sweet Spot 4: PE Portfolio
  pe: {
    name: 'PE Portfolio',
    keywords: [
      'Product Strategy Lead',
      'Product Operations Director',
      'VP Product Operations',
      'Head of Product B2B SaaS'
    ],
    description: 'PE-backed B2B SaaS needing product professionalization'
  }
};

// Target companies from job-search-context.md
const TARGET_COMPANIES = {
  // Primary targets
  databricks: '4439996',
  snowflake: '1142245',
  atlassian: '12447',
  adobe: '1480',
  palantir: '20708',
  stripe: '889175',
  // Stretch targets
  canva: '2410473',
  figma: '3209082',
  notion: '11118066',
  linear: '35589720',
  anthropic: '43742383',
  openai: '21839196',
  // Pipeline
  sandboxaq: '35534468',
  vercel: '15870204',
  supabase: '35520282',
  replit: '15073960'
};

// Location geoIds
const LOCATIONS = {
  denver: '103644278',
  austin: '104472866',
  sf: '102277331',
  nyc: '102571732',
  remote: null  // no location filter
};

const DEFAULT_LOCATION = 'denver';

// ============================================================================
// HELPERS
// ============================================================================

function hoursToSeconds(hours) {
  return Math.floor(hours * 3600);
}

function buildLinkedInUrl(keywords, options = {}) {
  const {
    hours = 6,
    company = null,
    remote = false,
    location = DEFAULT_LOCATION
  } = options;

  const params = new URLSearchParams();
  params.set('keywords', keywords);
  params.set('f_TPR', `r${hoursToSeconds(hours)}`);
  params.set('origin', 'JOB_SEARCH_PAGE_JOB_FILTER');

  if (company && TARGET_COMPANIES[company.toLowerCase()]) {
    params.set('f_C', TARGET_COMPANIES[company.toLowerCase()]);
  }

  if (remote) {
    params.set('f_WT', '2');
  }

  // Don't restrict location if remote, otherwise use geoId
  if (!remote && location) {
    const geoId = LOCATIONS[location.toLowerCase()] || location;
    if (geoId) {
      params.set('geoId', geoId);
    }
  }

  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

// Browser tools directory
const BROWSER_TOOLS = path.join(__dirname, 'browser-tools');

function isChromeRunning() {
  try {
    const result = spawnSync('curl', ['-s', 'http://localhost:9222/json/version'], {
      encoding: 'utf8',
      timeout: 2000
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function ensureChromeRunning(quiet = false) {
  if (isChromeRunning()) {
    return true;
  }

  if (!quiet) console.log('Starting Chrome with profile...');
  const browserStart = path.join(BROWSER_TOOLS, 'browser-start.js');

  try {
    execFileSync('node', [browserStart, '--profile'], { stdio: 'inherit' });
    // Wait for Chrome to be ready
    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    console.error('Failed to start Chrome:', err.message);
    return false;
  }

  return isChromeRunning();
}

async function openInChrome(url, newTab = false, quiet = false) {
  const browserNav = path.join(BROWSER_TOOLS, 'browser-nav.js');
  // browser-nav.js expects: <url> [--new]
  const args = newTab ? [browserNav, url, '--new'] : [browserNav, url];

  try {
    execFileSync('node', args, { stdio: quiet ? 'pipe' : 'inherit' });
  } catch (err) {
    // Fallback to system open - explicitly target Chrome (not default browser)
    if (!quiet) console.log('Browser tools failed, falling back to Chrome...');
    execFileSync('open', ['-a', 'Google Chrome', url]);
  }
}

function listPresets() {
  console.log('\n📋 Available Presets:\n');
  for (const [key, preset] of Object.entries(PRESETS)) {
    console.log(`  --preset ${key.padEnd(10)} ${preset.name}`);
    console.log(`  ${''.padEnd(20)} ${preset.description}`);
    console.log(`  ${''.padEnd(20)} Keywords: ${preset.keywords[0]}, ...`);
    console.log('');
  }

  console.log('\n🏢 Target Companies:\n');
  const companies = Object.keys(TARGET_COMPANIES).sort();
  console.log(`  ${companies.join(', ')}`);

  console.log('\n📝 Examples:\n');
  console.log('  job-fresh.js                      # Product Strategy, last 6 hours');
  console.log('  job-fresh.js --preset founding    # Founding PM roles');
  console.log('  job-fresh.js --hours 2            # Last 2 hours only');
  console.log('  job-fresh.js --company canva      # Filter to Canva');
  console.log('  job-fresh.js --preset all         # Open all presets');
  console.log('  job-fresh.js "AI Product Manager" # Custom search');
  console.log('  job-fresh.js --remote             # Remote jobs only');
  console.log('');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let preset = 'strategy'; // default
  let hours = 6;
  let company = null;
  let remote = false;
  let location = DEFAULT_LOCATION;
  let customKeywords = null;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--json') {
      jsonOutput = true;
      continue;
    }

    if (arg === '--list' || arg === '-l') {
      if (jsonOutput) {
        console.log(JSON.stringify({
          presets: PRESETS,
          targetCompanies: TARGET_COMPANIES,
          locations: LOCATIONS,
        }, null, 2));
        return;
      }
      listPresets();
      return;
    }

    if (arg === '--preset' || arg === '-p') {
      preset = args[++i];
      continue;
    }

    if (arg === '--hours' || arg === '-h') {
      hours = parseFloat(args[++i]);
      continue;
    }

    if (arg === '--company' || arg === '-c') {
      company = args[++i];
      continue;
    }

    if (arg === '--location') {
      location = args[++i];
      continue;
    }

    if (arg === '--remote' || arg === '-r') {
      remote = true;
      continue;
    }

    if (!arg.startsWith('-')) {
      customKeywords = arg;
    }
  }

  // Ensure Chrome is running with profile
  const chromeReady = await ensureChromeRunning(jsonOutput);
  if (!chromeReady) {
    console.error('Chrome is not available on localhost:9222. Start it with browser-start.js --profile and retry.');
    process.exit(1);
  }

  const options = { hours, company, remote, location };
  const openedSearches = [];

  // Handle "all" preset - open each in new tab
  if (preset === 'all') {
    if (!jsonOutput) console.log(`\n🔍 Opening all presets (last ${hours} hours)...\n`);

    let first = true;
    let tabCount = 0;

    // Open location-filtered searches for each preset
    for (const [key, presetConfig] of Object.entries(PRESETS)) {
      const keyword = presetConfig.keywords[0];
      const url = buildLinkedInUrl(keyword, options);

      if (!jsonOutput) console.log(`  → ${presetConfig.name}: ${keyword}`);
      await openInChrome(url, !first, jsonOutput);
      openedSearches.push({ type: 'preset', preset: key, name: presetConfig.name, keyword, url });
      first = false;
      tabCount++;

      // Small delay between tabs
      await new Promise(r => setTimeout(r, 500));
    }

    // Add remote-only searches for key presets (strategy, pm, founding)
    const remotePresets = ['strategy', 'pm', 'founding'];
    const remoteOptions = { ...options, remote: true, location: null };

    if (!jsonOutput) console.log('\n  📡 Remote-only searches:');
    for (const key of remotePresets) {
      const presetConfig = PRESETS[key];
      const keyword = presetConfig.keywords[0];
      const url = buildLinkedInUrl(keyword, remoteOptions);

      if (!jsonOutput) console.log(`  → ${presetConfig.name} (Remote): ${keyword}`);
      await openInChrome(url, true, jsonOutput);
      openedSearches.push({ type: 'remote', preset: key, name: presetConfig.name, keyword, url });
      tabCount++;

      await new Promise(r => setTimeout(r, 500));
    }

    const result = {
      action: 'fresh_open',
      preset,
      hours,
      tabCount,
      openedSearches,
      remoteSearchCount: remotePresets.length,
      localSearchCount: Object.keys(PRESETS).length,
    };
    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`\n✅ Opened ${tabCount} searches (${Object.keys(PRESETS).length} local + ${remotePresets.length} remote)`);
    console.log(`   Freshness: last ${hours} hours (${hoursToSeconds(hours)} seconds)`);
    return;
  }

  // Single search
  let keywords;
  let searchName;

  if (customKeywords) {
    keywords = customKeywords;
    searchName = 'Custom';
  } else if (PRESETS[preset]) {
    keywords = PRESETS[preset].keywords[0];
    searchName = PRESETS[preset].name;
  } else {
    console.error(`Unknown preset: ${preset}`);
    console.log('Use --list to see available presets');
    process.exit(1);
  }

  const url = buildLinkedInUrl(keywords, options);

  if (!jsonOutput) {
    console.log(`\n🔍 ${searchName} Search`);
    console.log(`   Keywords: ${keywords}`);
    console.log(`   Freshness: last ${hours} hours (${hoursToSeconds(hours)} seconds)`);
    if (company) console.log(`   Company: ${company}`);
    if (remote) console.log(`   Remote only: yes`);
    console.log('');
  }

  await openInChrome(url, false, jsonOutput);
  openedSearches.push({ type: customKeywords ? 'custom' : 'preset', preset, name: searchName, keyword: keywords, url });

  const result = {
    action: 'fresh_open',
    preset,
    hours,
    tabCount: 1,
    openedSearches,
  };
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('✅ Opened in Chrome');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
