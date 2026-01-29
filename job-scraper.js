#!/usr/bin/env node

/**
 * job-scraper.js - LinkedIn job listing extractor
 *
 * Scrapes job cards from LinkedIn search results using Chrome DevTools Protocol.
 * Designed to handle LinkedIn's frequently-changing DOM with multiple fallback strategies.
 *
 * Usage:
 *   job-scraper.js                    # Scrape current tab
 *   job-scraper.js --all              # Scrape all open LinkedIn job tabs
 *   job-scraper.js --scroll           # Scroll to load more results first
 *   job-scraper.js --output file.json # Output to specific file
 *
 * Prerequisites:
 *   - Chrome running with remote debugging (browser-start.js --profile)
 *   - LinkedIn job search page open (job-fresh.js --preset all)
 */

import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

const CACHE_PATH = path.join(
  process.env.HOME,
  ".claude/state/job-listings-cache.json"
);

// ============================================================================
// SELECTORS - Multiple fallback strategies for LinkedIn's changing DOM
// ============================================================================

const SELECTORS = {
  // Job card containers - try multiple patterns
  jobCards: [
    'li.jobs-search-results__list-item',
    '[data-occludable-job-id]',
    '.job-card-container',
    '.jobs-search-results-list li',
    'div[data-job-id]',
  ],

  // Title selectors within a card
  title: [
    '.job-card-list__title',
    '.job-card-container__link',
    'a[data-control-name="jobPosting_jobPostingList"]',
    '.artdeco-entity-lockup__title a',
    'h3.base-search-card__title',
    '[class*="job-card"] a[href*="/jobs/view/"]',
  ],

  // Company name selectors
  company: [
    '.job-card-container__primary-description',
    '.job-card-container__company-name',
    '.artdeco-entity-lockup__subtitle',
    '.base-search-card__subtitle a',
    '[class*="company-name"]',
  ],

  // Location selectors
  location: [
    '.job-card-container__metadata-item',
    '.artdeco-entity-lockup__caption',
    '.job-search-card__location',
    '[class*="job-card"] [class*="location"]',
  ],

  // Posted time selectors
  postedTime: [
    'time',
    '.job-card-container__listed-time',
    '[class*="listed-time"]',
    '[class*="posted"]',
  ],

  // Job URL pattern
  jobUrlPattern: /\/jobs\/view\/(\d+)/,
};

// ============================================================================
// EXTRACTION LOGIC
// ============================================================================

async function extractJobsFromPage(page) {
  const jobs = await page.evaluate((selectors) => {
    const results = [];

    // Helper to try multiple selectors
    function querySelector(parent, selectorList) {
      for (const sel of selectorList) {
        const el = parent.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    function querySelectorAll(parent, selectorList) {
      for (const sel of selectorList) {
        const els = parent.querySelectorAll(sel);
        if (els.length > 0) return Array.from(els);
      }
      return [];
    }

    // Find all job cards
    const cards = querySelectorAll(document, selectors.jobCards);

    for (const card of cards) {
      try {
        // Extract title and URL
        const titleEl = querySelector(card, selectors.title);
        const title = titleEl?.textContent?.trim() || null;

        // Get job URL from link
        let jobUrl = null;
        let jobId = null;
        const link = titleEl?.tagName === 'A' ? titleEl : card.querySelector('a[href*="/jobs/view/"]');
        if (link) {
          jobUrl = link.href;
          const match = jobUrl.match(/\/jobs\/view\/(\d+)/);
          if (match) jobId = match[1];
        }

        // Extract company
        const companyEl = querySelector(card, selectors.company);
        const company = companyEl?.textContent?.trim() || null;

        // Extract location
        const locationEl = querySelector(card, selectors.location);
        const location = locationEl?.textContent?.trim() || null;

        // Extract posted time
        const timeEl = querySelector(card, selectors.postedTime);
        const postedTime = timeEl?.textContent?.trim() || timeEl?.getAttribute('datetime') || null;

        // Get data attributes as fallback
        const dataJobId = card.getAttribute('data-occludable-job-id') ||
                          card.getAttribute('data-job-id');

        if (title || dataJobId) {
          results.push({
            title: title || 'Unknown',
            company: company || 'Unknown',
            location: location || 'Unknown',
            postedTime: postedTime || null,
            jobUrl: jobUrl || (dataJobId ? `https://www.linkedin.com/jobs/view/${dataJobId}` : null),
            jobId: jobId || dataJobId || null,
            scrapedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        // Skip malformed cards
        console.error('Error parsing card:', err);
      }
    }

    return results;
  }, SELECTORS);

  return jobs;
}

// Accessibility tree fallback - more reliable but slower
async function extractJobsFromA11y(page) {
  const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
  const jobs = [];

  function walk(node, context = {}) {
    if (!node) return;

    // Look for job links
    if (node.role === 'link' && node.name && node.value?.includes('/jobs/view/')) {
      const match = node.value.match(/\/jobs\/view\/(\d+)/);
      if (match) {
        jobs.push({
          title: node.name,
          jobUrl: node.value,
          jobId: match[1],
          company: context.company || 'Unknown',
          location: context.location || 'Unknown',
          postedTime: context.time || null,
          scrapedAt: new Date().toISOString(),
        });
      }
    }

    // Build context from parent elements
    const newContext = { ...context };
    if (node.name?.includes('ago')) {
      newContext.time = node.name;
    }

    for (const child of node.children || []) {
      walk(child, newContext);
    }
  }

  walk(snapshot);
  return jobs;
}

async function scrollToLoadMore(page, scrollCount = 3) {
  for (let i = 0; i < scrollCount; i++) {
    await page.evaluate(() => {
      const container = document.querySelector('.jobs-search-results-list') || window;
      if (container.scrollTo) {
        container.scrollTo(0, container.scrollHeight || document.body.scrollHeight);
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
    });
    await new Promise(r => setTimeout(r, 1500)); // Wait for content to load
  }
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading cache:', err.message);
  }
  return {
    version: '1.0',
    lastUpdated: null,
    listings: {},
  };
}

function saveCache(cache) {
  cache.lastUpdated = new Date().toISOString();
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function mergeIntoCache(cache, jobs, source) {
  let newCount = 0;
  let updateCount = 0;

  for (const job of jobs) {
    if (!job.jobId) continue;

    const existing = cache.listings[job.jobId];
    if (existing) {
      // Update if we have better data
      if (!existing.title || existing.title === 'Unknown') {
        cache.listings[job.jobId] = { ...existing, ...job };
        updateCount++;
      }
    } else {
      cache.listings[job.jobId] = {
        ...job,
        status: 'new',
        score: null,
        source: source,
        firstSeen: new Date().toISOString(),
      };
      newCount++;
    }
  }

  return { newCount, updateCount };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  let scrapeAll = false;
  let doScroll = false;
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all' || arg === '-a') scrapeAll = true;
    if (arg === '--scroll' || arg === '-s') doScroll = true;
    if (arg === '--output' || arg === '-o') outputPath = args[++i];
  }

  // Connect to Chrome
  const browser = await Promise.race([
    puppeteer.connect({
      browserURL: 'http://localhost:9222',
      defaultViewport: null,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 5000)
    ),
  ]).catch((e) => {
    console.error('Could not connect to browser:', e.message);
    console.error('Run: browser-start.js --profile');
    process.exit(1);
  });

  const pages = await browser.pages();
  const linkedinPages = pages.filter(p =>
    p.url().includes('linkedin.com/jobs/search')
  );

  if (linkedinPages.length === 0) {
    console.error('No LinkedIn job search tabs found');
    console.error('Run: job-fresh.js --preset all');
    await browser.disconnect();
    process.exit(1);
  }

  console.log(`\nFound ${linkedinPages.length} LinkedIn job search tab(s)\n`);

  const cache = loadCache();
  let totalNew = 0;
  let totalUpdated = 0;
  const allJobs = [];

  const pagesToScrape = scrapeAll ? linkedinPages : [linkedinPages[linkedinPages.length - 1]];

  for (const page of pagesToScrape) {
    const url = page.url();
    const urlParams = new URL(url).searchParams;
    const keywords = urlParams.get('keywords') || 'unknown';

    console.log(`Scraping: "${keywords}"`);
    console.log(`  URL: ${url.substring(0, 80)}...`);

    if (doScroll) {
      console.log('  Scrolling to load more...');
      await scrollToLoadMore(page);
    }

    // Try DOM extraction first
    let jobs = await extractJobsFromPage(page);
    console.log(`  DOM extraction: ${jobs.length} listings`);

    // If DOM extraction fails, try accessibility tree
    if (jobs.length === 0) {
      console.log('  Trying accessibility tree fallback...');
      jobs = await extractJobsFromA11y(page);
      console.log(`  A11y extraction: ${jobs.length} listings`);
    }

    // Add source info
    jobs = jobs.map(j => ({ ...j, searchKeywords: keywords }));
    allJobs.push(...jobs);

    const { newCount, updateCount } = mergeIntoCache(cache, jobs, keywords);
    totalNew += newCount;
    totalUpdated += updateCount;

    console.log(`  New: ${newCount}, Updated: ${updateCount}\n`);
  }

  // Save cache
  saveCache(cache);

  // Output summary
  const totalInCache = Object.keys(cache.listings).length;
  const newListings = Object.values(cache.listings).filter(l => l.status === 'new');

  console.log('─'.repeat(50));
  console.log(`Total scraped this run: ${allJobs.length}`);
  console.log(`New listings added: ${totalNew}`);
  console.log(`Existing updated: ${totalUpdated}`);
  console.log(`Total in cache: ${totalInCache}`);
  console.log(`Awaiting qualification: ${newListings.length}`);
  console.log('─'.repeat(50));
  console.log(`Cache saved to: ${CACHE_PATH}`);

  // Optional: output to specific file
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(allJobs, null, 2));
    console.log(`Raw output saved to: ${outputPath}`);
  }

  await browser.disconnect();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
