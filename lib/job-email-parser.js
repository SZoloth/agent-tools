/**
 * job-email-parser.js - Parse job listings from email alerts
 *
 * Extracts job listings from WTTJ and Wellfound email alerts via AgentMail.
 * Email parsing is preferred over browser scraping because:
 * - Email format changes less often than website DOM
 * - No anti-bot measures to bypass
 * - Lower maintenance burden
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const CONFIG_PATH = path.join(process.env.HOME, ".agentmail", "config.json");
const API_BASE = "https://api.agentmail.to";

// Email source patterns
const EMAIL_SOURCES = {
  wttj: {
    fromPattern: /welcometothejungle/i,
    urlPattern: /welcometothejungle\.com\/[^\/]+\/companies\/([^\/]+)\/jobs\/([^\/\s"]+)/g,
    name: "Welcome to the Jungle",
  },
  wellfound: {
    fromPattern: /wellfound/i,
    // Wellfound URLs: wellfound.com/jobs/3803148-senior-product-manager
    urlPattern: /wellfound\.com\/jobs\/(\d+[^?\s"'<>]*)/g,
    name: "Wellfound",
  },
};

/**
 * Load AgentMail config
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("AgentMail not configured. Create ~/.agentmail/config.json");
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

/**
 * Make authenticated API request to AgentMail
 */
async function apiRequest(endpoint, options = {}) {
  const config = loadConfig();

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AgentMail API error ${res.status}: ${err}`);
  }

  return res.json();
}

/**
 * Fetch recent messages from AgentMail inbox
 * @param {Object} options - { since: hours, limit: number }
 */
async function fetchRecentMessages(options = {}) {
  const { since = 168, limit = 100 } = options; // Default: last 7 days
  const config = loadConfig();
  const inboxId = config.default_inbox;

  // Calculate cutoff time
  const cutoffDate = new Date(Date.now() - since * 60 * 60 * 1000);

  const params = new URLSearchParams({ limit: limit.toString() });
  const data = await apiRequest(`/v0/inboxes/${encodeURIComponent(inboxId)}/messages?${params}`);

  // Filter to messages from job alert sources within time window
  const relevantMessages = (data.messages || []).filter((msg) => {
    const msgDate = new Date(msg.timestamp || msg.created_at);
    if (msgDate < cutoffDate) return false;

    // AgentMail API returns 'from' not 'from_'
    const from = msg.from || msg.from_ || "";
    return (
      EMAIL_SOURCES.wttj.fromPattern.test(from) || EMAIL_SOURCES.wellfound.fromPattern.test(from)
    );
  });

  return relevantMessages;
}

/**
 * Get full message content
 * @param {string} messageId - Message ID
 */
async function getMessageContent(messageId) {
  const config = loadConfig();
  const inboxId = config.default_inbox;

  const data = await apiRequest(
    `/v0/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`
  );

  return data;
}

/**
 * Generate deterministic URL hash for dedup
 * @param {string} url - Job URL
 */
function generateUrlHash(url) {
  return crypto.createHash("md5").update(url).digest("hex").substring(0, 12);
}

/**
 * Extract WTTJ jobs from email HTML
 * @param {string} html - Email HTML body
 * @param {string} emailDate - Email timestamp
 */
function parseWTTJEmail(html, emailDate) {
  const jobs = [];
  const urlPattern = EMAIL_SOURCES.wttj.urlPattern;

  // Reset regex state
  urlPattern.lastIndex = 0;

  // Find all job URLs
  let match;
  const seenUrls = new Set();

  while ((match = urlPattern.exec(html)) !== null) {
    const companySlug = match[1];
    const jobSlug = match[2];
    const url = `https://www.welcometothejungle.com/en/companies/${companySlug}/jobs/${jobSlug}`;

    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Try to extract job title from link text or nearby content
    // This is a best-effort extraction from email HTML
    const titleMatch = html.match(
      new RegExp(`<a[^>]*href="[^"]*${jobSlug}[^"]*"[^>]*>([^<]+)</a>`, "i")
    );
    const title = titleMatch ? titleMatch[1].trim() : jobSlug.replace(/-/g, " ");

    // Try to extract company name
    const companyName = companySlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const urlHash = generateUrlHash(url);
    jobs.push({
      jobId: `wttj_email_${urlHash}`,
      source: "wttj",
      atsToken: companySlug,
      title,
      company: companyName,
      location: "Unknown",
      departments: [],
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      jobUrl: url,
      postedTime: emailDate,
      scrapedAt: new Date().toISOString(),
      score: null,
      status: "new",
      firstSeen: new Date().toISOString(),
    });
  }

  return jobs;
}

/**
 * Extract Wellfound jobs from email HTML
 * @param {string} html - Email HTML body
 * @param {string} emailDate - Email timestamp
 */
function parseWellfoundEmail(html, emailDate) {
  const jobs = [];
  const urlPattern = EMAIL_SOURCES.wellfound.urlPattern;

  urlPattern.lastIndex = 0;

  let match;
  const seenUrls = new Set();

  while ((match = urlPattern.exec(html)) !== null) {
    const jobId = match[1];
    const url = `https://wellfound.com/jobs/${jobId}`;

    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Try to extract job title from link text in HTML
    const titleMatch = html.match(
      new RegExp(`<a[^>]*href="[^"]*jobs/${jobId}[^"]*"[^>]*>([^<]+)</a>`, "i")
    );
    // Fallback: parse title from slug (e.g., "3803148-senior-product-manager" → "Senior Product Manager")
    const slugTitle = jobId.replace(/^\d+-/, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const title = titleMatch ? titleMatch[1].trim() : slugTitle;

    // Try to find company name nearby in the HTML structure
    const companyMatch = html.match(
      new RegExp(`jobs/${jobId}[^"]*"[^>]*>[^<]*</a>[^<]*<[^>]*>([^<]+)`, "i")
    );
    const company = companyMatch ? companyMatch[1].trim() : "Unknown";

    const urlHash = generateUrlHash(url);
    jobs.push({
      jobId: `wellfound_email_${urlHash}`,
      source: "wellfound",
      atsToken: null,
      title,
      company,
      location: "Unknown",
      departments: [],
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      jobUrl: url,
      postedTime: emailDate,
      scrapedAt: new Date().toISOString(),
      score: null,
      status: "new",
      firstSeen: new Date().toISOString(),
    });
  }

  return jobs;
}

/**
 * Parse all job alert emails and extract listings
 * @param {Object} options - { since: hours, verbose: boolean }
 */
export async function parseJobAlertEmails(options = {}) {
  const { since = 168, verbose = false } = options;

  const stats = {
    emailsChecked: 0,
    wttjEmails: 0,
    wellfoundEmails: 0,
    jobsFound: 0,
  };

  const allJobs = [];
  const seenJobIds = new Set();

  try {
    const messages = await fetchRecentMessages({ since });
    stats.emailsChecked = messages.length;

    if (verbose) {
      console.log(`Found ${messages.length} job alert emails from last ${since} hours`);
    }

    for (const msg of messages) {
      const from = msg.from || msg.from_ || "";
      const emailDate = msg.timestamp || msg.created_at;
      const msgId = msg.message_id || msg.id;

      // Get full message content
      let fullMsg;
      try {
        fullMsg = await getMessageContent(msgId);
      } catch (err) {
        if (verbose) console.log(`  Skipped ${msgId}: ${err.message}`);
        continue;
      }

      // AgentMail returns multiple content fields - combine them for URL extraction
      // extracted_text often has cleaner URLs without tracking redirects
      const html = fullMsg.html || fullMsg.html_body || "";
      const text = fullMsg.text || fullMsg.text_body || "";
      const extractedText = fullMsg.extracted_text || "";
      const combinedContent = [html, text, extractedText].filter(Boolean).join("\n");

      let jobs = [];

      if (EMAIL_SOURCES.wttj.fromPattern.test(from)) {
        stats.wttjEmails++;
        jobs = parseWTTJEmail(combinedContent, emailDate);
        if (verbose) console.log(`  WTTJ email: ${jobs.length} jobs`);
      } else if (EMAIL_SOURCES.wellfound.fromPattern.test(from)) {
        stats.wellfoundEmails++;
        jobs = parseWellfoundEmail(combinedContent, emailDate);
        if (verbose) console.log(`  Wellfound email: ${jobs.length} jobs`);
      }

      // Dedupe within this parse session
      for (const job of jobs) {
        if (!seenJobIds.has(job.jobId)) {
          seenJobIds.add(job.jobId);
          allJobs.push(job);
        }
      }
    }

    stats.jobsFound = allJobs.length;
  } catch (err) {
    if (verbose) console.error(`Email parsing error: ${err.message}`);
    return { jobs: [], stats, error: err.message };
  }

  return { jobs: allJobs, stats, error: null };
}

/**
 * Filter for product-related roles
 * Less strict than ATS filters since email data is sparser
 */
function isProductRole(job) {
  const title = job.title.toLowerCase();
  return (
    title.includes("product") ||
    title.includes("strategy") ||
    title.includes("chief of staff") ||
    title.includes("cos") ||
    title.includes("pm ")
  );
}

export { parseWTTJEmail, parseWellfoundEmail, isProductRole, EMAIL_SOURCES };
