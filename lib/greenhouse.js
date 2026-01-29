/**
 * greenhouse.js - Greenhouse ATS API adapter
 *
 * Fetches jobs from Greenhouse public API and normalizes to cache format.
 * Handles salary extraction, rate limiting, and error recovery.
 */

const GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true";

// Salary extraction patterns
const SALARY_PATTERNS = [
  // $150,000 - $200,000 or $150,000-$200,000
  /\$\s*([\d,]+)\s*[-–—to]+\s*\$?\s*([\d,]+)/gi,
  // $150K - $200K or $150k-$200k
  /\$\s*(\d+)\s*[kK]\s*[-–—to]+\s*\$?\s*(\d+)\s*[kK]/gi,
  // Salary: $150,000 or Base: $150,000
  /(?:salary|base|compensation|pay|annual)[:\s]+\$\s*([\d,]+)/gi,
  // $150,000 USD or $150,000/year
  /\$\s*([\d,]+)\s*(?:usd|\/\s*(?:year|yr|annually))/gi,
];

/**
 * Parse salary from job content
 * @param {string} content - Job description content
 * @returns {Object} { salaryMin, salaryMax, salaryCurrency }
 */
function extractSalary(content) {
  if (!content) return { salaryMin: null, salaryMax: null, salaryCurrency: null };

  const text = content.replace(/<[^>]*>/g, " "); // Strip HTML

  for (const pattern of SALARY_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex state
    const match = pattern.exec(text);
    if (match) {
      let min, max;

      if (match[2]) {
        // Range found
        min = parseFloat(match[1].replace(/,/g, ""));
        max = parseFloat(match[2].replace(/,/g, ""));

        // Handle K notation
        if (min < 1000) min *= 1000;
        if (max < 1000) max *= 1000;
      } else {
        // Single value
        min = parseFloat(match[1].replace(/,/g, ""));
        max = min;
        if (min < 1000) {
          min *= 1000;
          max *= 1000;
        }
      }

      return {
        salaryMin: Math.round(min),
        salaryMax: Math.round(max),
        salaryCurrency: "USD",
      };
    }
  }

  return { salaryMin: null, salaryMax: null, salaryCurrency: null };
}

/**
 * Parse location from Greenhouse location object
 * @param {Object} location - Greenhouse location object
 * @returns {string} Normalized location string
 */
function parseLocation(location) {
  if (!location) return "Unknown";
  if (typeof location === "string") return location;
  return location.name || "Unknown";
}

/**
 * Normalize Greenhouse job to cache format
 * @param {Object} job - Greenhouse job object
 * @param {string} companyName - Company display name
 * @param {string} token - ATS token
 * @returns {Object} Normalized job object
 */
function normalizeJob(job, companyName, token) {
  const salary = extractSalary(job.content);
  const location = parseLocation(job.location);

  // Generate unique ID
  const jobId = `gh_${token}_${job.id}`;

  // Extract departments
  const departments = job.departments?.map((d) => d.name) || [];

  // Parse posted time
  let postedTime = null;
  if (job.updated_at) {
    postedTime = new Date(job.updated_at).toISOString();
  } else if (job.first_published_at) {
    postedTime = new Date(job.first_published_at).toISOString();
  }

  return {
    jobId,
    source: "greenhouse",
    atsToken: token,
    title: job.title,
    company: companyName,
    location,
    departments,
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    salaryCurrency: salary.salaryCurrency,
    jobUrl: job.absolute_url,
    postedTime,
    scrapedAt: new Date().toISOString(),
    score: null,
    status: "new",
    firstSeen: new Date().toISOString(),
    greenhouseId: job.id,
    content: job.content ? job.content.substring(0, 5000) : null, // Truncate for storage
  };
}

/**
 * Fetch jobs from a Greenhouse board
 * @param {string} token - Greenhouse board token
 * @param {string} companyName - Company display name
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} { jobs: [], error: null } or { jobs: [], error: string }
 */
export async function fetchGreenhouseJobs(token, companyName, options = {}) {
  const { timeout = 10000, filterProduct = true } = options;

  const url = GREENHOUSE_API.replace("{token}", token);

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

    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 404) {
        return { jobs: [], error: `Board not found: ${token}` };
      }
      return { jobs: [], error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();

    if (!data.jobs || !Array.isArray(data.jobs)) {
      return { jobs: [], error: "Invalid response format" };
    }

    let jobs = data.jobs.map((job) => normalizeJob(job, companyName, token));

    // Optional: Filter for product roles only
    if (filterProduct) {
      jobs = jobs.filter((job) => {
        const title = job.title.toLowerCase();
        const depts = job.departments.map((d) => d.toLowerCase()).join(" ");
        return (
          title.includes("product") ||
          title.includes("strategy") ||
          title.includes("chief of staff") ||
          title.includes("cos") ||
          depts.includes("product")
        );
      });
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
 * Fetch jobs from multiple Greenhouse boards in parallel
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

  // Process in batches for rate limiting
  for (let i = 0; i < companies.length; i += concurrency) {
    const batch = companies.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async ({ token, displayName }) => {
        const result = await fetchGreenhouseJobs(token, displayName, options);
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

    // Small delay between batches to avoid rate limiting
    if (i + concurrency < companies.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return { jobs: results, errors, stats };
}

export { extractSalary, normalizeJob };
