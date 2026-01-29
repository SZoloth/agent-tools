/**
 * ashby.js - Ashby ATS API adapter
 *
 * Fetches jobs from Ashby public API and normalizes to cache format.
 * No auth required. Generous rate limits.
 */

const ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true";

/**
 * Extract salary from Ashby compensation structure
 * Looks for "Salary" type with "YEAR" interval in compensationTiers
 * @param {Object} compensation - Ashby compensation object
 * @returns {Object} { salaryMin, salaryMax, salaryCurrency }
 */
function extractSalary(compensation) {
  if (!compensation?.compensationTiers?.length) {
    return { salaryMin: null, salaryMax: null, salaryCurrency: null };
  }

  // Search through all tiers for a yearly salary component
  for (const tier of compensation.compensationTiers) {
    if (!tier.components?.length) continue;

    const salaryComp = tier.components.find(
      (c) => c.compensationType === "Salary" && c.interval?.includes("YEAR")
    );

    if (salaryComp) {
      return {
        salaryMin: salaryComp.min || null,
        salaryMax: salaryComp.max || null,
        salaryCurrency: salaryComp.currencyCode || "USD",
      };
    }
  }

  return { salaryMin: null, salaryMax: null, salaryCurrency: null };
}

/**
 * Parse location from Ashby job
 * @param {Object} job - Ashby job object
 * @returns {string} Normalized location string
 */
function parseLocation(job) {
  const parts = [];
  if (job.location) parts.push(job.location);
  if (job.isRemote) parts.push("Remote");
  return parts.length > 0 ? parts.join(" / ") : "Unknown";
}

/**
 * Extract departments from Ashby job
 * @param {Object} job - Ashby job object
 * @returns {Array<string>} Department names
 */
function extractDepartments(job) {
  const depts = [];
  if (job.department) depts.push(job.department);
  if (job.team) depts.push(job.team);
  return [...new Set(depts)];
}

/**
 * Normalize Ashby job to cache format
 * @param {Object} job - Ashby job object
 * @param {string} companyName - Company display name
 * @param {string} token - ATS token
 * @returns {Object} Normalized job object
 */
function normalizeJob(job, companyName, token) {
  const salary = extractSalary(job.compensation);
  const location = parseLocation(job);
  const departments = extractDepartments(job);

  const ashbyId = job.id;
  const jobId = `ashby_${token}_${ashbyId}`;

  // Parse posted time
  let postedTime = null;
  if (job.publishedAt) {
    postedTime = new Date(job.publishedAt).toISOString();
  }

  return {
    jobId,
    source: "ashby",
    atsToken: token,
    title: job.title,
    company: companyName,
    location,
    departments,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryCurrency: salary.salaryCurrency,
    jobUrl: job.jobUrl,
    postedTime,
    scrapedAt: new Date().toISOString(),
    score: null,
    status: "new",
    firstSeen: new Date().toISOString(),
    ashbyId,
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
 * Fetch jobs from an Ashby job board
 * @param {string} token - Ashby board token (company slug)
 * @param {string} companyName - Company display name
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} { jobs: [], error: null } or { jobs: [], error: string }
 */
export async function fetchAshbyJobs(token, companyName, options = {}) {
  const { timeout = 15000, filterProduct = true } = options;

  const url = ASHBY_API.replace("{token}", token);

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

    // Ashby returns { jobs: [...] }
    if (!data.jobs || !Array.isArray(data.jobs)) {
      return { jobs: [], error: "Invalid response format" };
    }

    let jobs = data.jobs.map((job) => normalizeJob(job, companyName, token));

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
 * Fetch jobs from multiple Ashby boards in parallel
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
        const result = await fetchAshbyJobs(token, displayName, options);
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
