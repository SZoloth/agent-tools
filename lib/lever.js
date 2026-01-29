/**
 * lever.js - Lever ATS API adapter
 *
 * Fetches jobs from Lever public API and normalizes to cache format.
 * No auth required. Rate limit: ~100 req/min.
 */

const LEVER_API = "https://api.lever.co/v0/postings/{token}?mode=json";

/**
 * Parse salary from Lever salaryRange object
 * @param {Object} salaryRange - Lever salary range object
 * @returns {Object} { salaryMin, salaryMax, salaryCurrency }
 */
function extractSalary(salaryRange) {
  if (!salaryRange) return { salaryMin: null, salaryMax: null, salaryCurrency: null };

  return {
    salaryMin: salaryRange.min || null,
    salaryMax: salaryRange.max || null,
    salaryCurrency: salaryRange.currency || "USD",
  };
}

/**
 * Parse location from Lever categories
 * @param {Object} categories - Lever categories object
 * @returns {string} Normalized location string
 */
function parseLocation(categories) {
  if (!categories?.location) return "Unknown";
  return categories.location;
}

/**
 * Extract departments from Lever categories
 * @param {Object} categories - Lever categories object
 * @returns {Array<string>} Department names
 */
function extractDepartments(categories) {
  const depts = [];
  if (categories?.team) depts.push(categories.team);
  if (categories?.department) depts.push(categories.department);
  return [...new Set(depts)];
}

/**
 * Normalize Lever job to cache format
 * @param {Object} job - Lever job object
 * @param {string} companyName - Company display name
 * @param {string} token - ATS token
 * @returns {Object} Normalized job object
 */
function normalizeJob(job, companyName, token) {
  const salary = extractSalary(job.salaryRange);
  const location = parseLocation(job.categories);
  const departments = extractDepartments(job.categories);

  // Lever ID is in the hostedUrl, extract last segment
  const leverId = job.id;
  const jobId = `lever_${token}_${leverId}`;

  // Parse posted time from createdAt (milliseconds timestamp)
  let postedTime = null;
  if (job.createdAt) {
    postedTime = new Date(job.createdAt).toISOString();
  }

  return {
    jobId,
    source: "lever",
    atsToken: token,
    title: job.text,
    company: companyName,
    location,
    departments,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryCurrency: salary.salaryCurrency,
    jobUrl: job.hostedUrl,
    postedTime,
    scrapedAt: new Date().toISOString(),
    score: null,
    status: "new",
    firstSeen: new Date().toISOString(),
    leverId,
    content: job.descriptionPlain ? job.descriptionPlain.substring(0, 5000) : null,
  };
}

/**
 * Filter for product-related roles
 * @param {Object} job - Normalized job object
 * @returns {boolean} True if product-related
 */
function isProductRole(job) {
  const title = job.title.toLowerCase();
  const depts = job.departments.map((d) => d.toLowerCase()).join(" ");
  return (
    title.includes("product") ||
    title.includes("strategy") ||
    title.includes("chief of staff") ||
    title.includes("cos") ||
    depts.includes("product")
  );
}

/**
 * Fetch jobs from a Lever board
 * @param {string} token - Lever board token (company slug)
 * @param {string} companyName - Company display name
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} { jobs: [], error: null } or { jobs: [], error: string }
 */
export async function fetchLeverJobs(token, companyName, options = {}) {
  const { timeout = 15000, filterProduct = true } = options;

  const url = LEVER_API.replace("{token}", token);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "JobDiscovery/1.0",
      },
    });

    if (!response.ok) {
      clearTimeout(timeoutId);
      if (response.status === 404) {
        return { jobs: [], error: `Board not found: ${token}` };
      }
      return { jobs: [], error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();
    clearTimeout(timeoutId);

    if (!Array.isArray(data)) {
      return { jobs: [], error: "Invalid response format" };
    }

    let jobs = data.map((job) => normalizeJob(job, companyName, token));

    if (filterProduct) {
      jobs = jobs.filter(isProductRole);
    }

    return { jobs, error: null };
  } catch (err) {
    if (err.name === "AbortError") {
      return { jobs: [], error: `Timeout fetching ${token}` };
    }
    return { jobs: [], error: err.message };
  }
}

/**
 * Fetch jobs from multiple Lever boards in parallel
 * @param {Array} companies - Array of { token, displayName }
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} { jobs: [], errors: [], stats: {} }
 */
export async function fetchMultipleBoards(companies, options = {}) {
  const { concurrency = 5 } = options;

  const results = [];
  const errors = [];
  const stats = {
    total: companies.length,
    successful: 0,
    failed: 0,
    jobsFound: 0,
  };

  for (let i = 0; i < companies.length; i += concurrency) {
    const batch = companies.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async ({ token, displayName }) => {
        const result = await fetchLeverJobs(token, displayName, options);
        return { token, displayName, ...result };
      })
    );

    for (const result of batchResults) {
      if (result.error) {
        errors.push({ company: result.displayName, error: result.error });
        stats.failed++;
      } else {
        results.push(...result.jobs);
        stats.successful++;
        stats.jobsFound += result.jobs.length;
      }
    }

    // Small delay between batches
    if (i + concurrency < companies.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return { jobs: results, errors, stats };
}

export { extractSalary, normalizeJob, isProductRole };
