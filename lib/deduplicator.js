/**
 * deduplicator.js - Cross-source job deduplication
 *
 * Handles merging jobs from multiple sources (ATS, LinkedIn, Email alerts)
 * with priority-based deduplication.
 */

// Source priority (higher = preferred)
const SOURCE_PRIORITY = {
  greenhouse: 100,
  lever: 90,
  ashby: 80,
  otta: 70,
  wellfound: 65,
  wttj: 60,
  linkedin: 50,
  email: 40,
  unknown: 0,
};

/**
 * Normalize company name for matching
 * @param {string} company - Raw company name
 * @returns {string} Normalized company name
 */
function normalizeCompany(company) {
  if (!company) return "";
  return company
    .toLowerCase()
    .replace(/[,.\-_']/g, "")
    .replace(/\s+(inc|llc|ltd|corp|co|company|labs|ai|io)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize job title for matching
 * @param {string} title - Raw job title
 * @returns {string} Normalized title
 */
function normalizeTitle(title) {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[,.\-_'()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(sr|senior)\b/gi, "senior")
    .replace(/\b(jr|junior)\b/gi, "junior")
    .replace(/\b(mgr|manager)\b/gi, "manager")
    .replace(/\b(dir|director)\b/gi, "director")
    .replace(/\b(eng|engineer)\b/gi, "engineer")
    .replace(/\b(pm)\b/gi, "product manager")
    .trim();
}

/**
 * Generate deduplication key for a job
 * @param {Object} job - Job object
 * @returns {string} Deduplication key
 */
function generateDedupKey(job) {
  const company = normalizeCompany(job.company);
  const title = normalizeTitle(job.title);
  return `${company}::${title}`;
}

/**
 * Calculate similarity between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Similarity score 0-1
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const wordsA = new Set(a.split(" "));
  const wordsB = new Set(b.split(" "));

  const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}

/**
 * Check if two jobs are likely duplicates
 * @param {Object} job1 - First job
 * @param {Object} job2 - Second job
 * @returns {boolean} True if likely duplicates
 */
function areDuplicates(job1, job2) {
  const key1 = generateDedupKey(job1);
  const key2 = generateDedupKey(job2);

  // Exact key match
  if (key1 === key2) return true;

  // Fuzzy match: same company and similar title
  const company1 = normalizeCompany(job1.company);
  const company2 = normalizeCompany(job2.company);

  if (company1 !== company2) return false;

  const title1 = normalizeTitle(job1.title);
  const title2 = normalizeTitle(job2.title);

  return similarity(title1, title2) > 0.8;
}

/**
 * Get source priority for a job
 * @param {Object} job - Job object
 * @returns {number} Priority value
 */
function getSourcePriority(job) {
  const source = (job.source || "unknown").toLowerCase();
  return SOURCE_PRIORITY[source] || SOURCE_PRIORITY.unknown;
}

/**
 * Choose the better job between two duplicates
 * @param {Object} existing - Existing job in cache
 * @param {Object} newJob - New job being merged
 * @returns {Object} The preferred job (with merged data)
 */
function chooseBetterJob(existing, newJob) {
  const existingPriority = getSourcePriority(existing);
  const newPriority = getSourcePriority(newJob);

  // Start with higher priority job as base
  const preferred = newPriority > existingPriority ? newJob : existing;
  const secondary = newPriority > existingPriority ? existing : newJob;

  // Merge useful data from secondary
  return {
    ...preferred,
    // Preserve firstSeen from earliest discovery
    firstSeen: existing.firstSeen || newJob.firstSeen || new Date().toISOString(),
    // Preserve score if already scored
    score: existing.score !== null ? existing.score : null,
    scoreBreakdown: existing.scoreBreakdown || null,
    status: existing.score !== null ? existing.status : "new",
    // Fill in missing salary data
    salaryMin: preferred.salaryMin || secondary.salaryMin,
    salaryMax: preferred.salaryMax || secondary.salaryMax,
    salaryCurrency: preferred.salaryCurrency || secondary.salaryCurrency,
    // Track alternate sources
    alternateSources: [
      ...(existing.alternateSources || []),
      ...(newJob.alternateSources || []),
      secondary.source,
    ].filter((s, i, arr) => s && arr.indexOf(s) === i),
    // Keep the better URL (ATS preferred)
    jobUrl: newPriority > existingPriority ? newJob.jobUrl : existing.jobUrl,
    // Update scraped time
    scrapedAt: new Date().toISOString(),
  };
}

/**
 * Deduplicate and merge jobs into existing cache
 * @param {Object} existingListings - Current cache listings object
 * @param {Array} newJobs - New jobs to merge
 * @returns {Object} { listings: {}, stats: {} }
 */
export function mergeJobs(existingListings, newJobs) {
  const listings = { ...existingListings };
  const stats = {
    added: 0,
    updated: 0,
    duplicates: 0,
    total: newJobs.length,
  };

  // Build lookup index by dedup key for existing jobs
  const dedupIndex = new Map();
  for (const [jobId, job] of Object.entries(listings)) {
    const key = generateDedupKey(job);
    if (!dedupIndex.has(key)) {
      dedupIndex.set(key, []);
    }
    dedupIndex.get(key).push(jobId);
  }

  for (const newJob of newJobs) {
    const dedupKey = generateDedupKey(newJob);

    // Check for existing job with same key
    const existingIds = dedupIndex.get(dedupKey) || [];
    let foundDuplicate = false;

    for (const existingId of existingIds) {
      const existing = listings[existingId];
      if (areDuplicates(existing, newJob)) {
        // Merge with existing
        listings[existingId] = chooseBetterJob(existing, newJob);
        stats.duplicates++;
        foundDuplicate = true;
        break;
      }
    }

    if (!foundDuplicate) {
      // Also check fuzzy matches across all listings
      for (const [existingId, existing] of Object.entries(listings)) {
        if (areDuplicates(existing, newJob)) {
          listings[existingId] = chooseBetterJob(existing, newJob);
          stats.updated++;
          foundDuplicate = true;
          break;
        }
      }
    }

    if (!foundDuplicate) {
      // New unique job
      const jobId = newJob.jobId || `${newJob.source}_${Date.now()}_${stats.added}`;
      listings[jobId] = {
        ...newJob,
        firstSeen: new Date().toISOString(),
      };

      // Update dedup index
      if (!dedupIndex.has(dedupKey)) {
        dedupIndex.set(dedupKey, []);
      }
      dedupIndex.get(dedupKey).push(jobId);

      stats.added++;
    }
  }

  return { listings, stats };
}

/**
 * Find potential duplicates in cache (for cleanup)
 * @param {Object} listings - Cache listings
 * @returns {Array} Array of duplicate groups
 */
export function findDuplicates(listings) {
  const groups = new Map();

  for (const [jobId, job] of Object.entries(listings)) {
    const key = generateDedupKey(job);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push({ jobId, ...job });
  }

  return Array.from(groups.entries())
    .filter(([_, jobs]) => jobs.length > 1)
    .map(([key, jobs]) => ({
      key,
      jobs: jobs.sort((a, b) => getSourcePriority(b) - getSourcePriority(a)),
    }));
}

export {
  normalizeCompany,
  normalizeTitle,
  generateDedupKey,
  areDuplicates,
  getSourcePriority,
  chooseBetterJob,
  SOURCE_PRIORITY,
};
