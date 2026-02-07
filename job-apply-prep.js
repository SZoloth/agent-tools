#!/usr/bin/env node

/**
 * job-apply-prep.js - Application folder generator
 *
 * Creates application folder with scaffolded materials for qualified job listings.
 * Designed to work with the job pipeline (job-fresh → job-scraper → job-qualify → job-apply-prep).
 *
 * Usage:
 *   job-apply-prep.js <job-id>           # Prep specific job by ID
 *   job-apply-prep.js --company stripe   # Prep by company name
 *   job-apply-prep.js --all              # Prep all qualified listings
 *   job-apply-prep.js --list             # List qualified jobs awaiting prep
 *   job-apply-prep.js --fetch            # Also fetch job posting content
 *   job-apply-prep.js --skip-beads       # Skip beads issue creation
 *   job-apply-prep.js --json             # JSON summary output
 *
 * Creates folder structure at:
 *   ~/Documents/LLM CONTEXT/1 - personal/job_search/Applications/{NN}-{company}/
 *     - Application_Research_Notes.md
 *     - Job_Posting_YYYY-MM-DD.md
 */

import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import {
  ensureJobPipeline,
  queueIdForEntry,
  samePipelineEntry,
  withQueueId,
  dedupePipelineEntries,
} from "./job-pipeline-lib.js";

const RESEARCH_CMD = path.join(process.env.HOME, "agent-tools/job-research.js");

const CACHE_PATH = path.join(
  process.env.HOME,
  ".claude/state/job-listings-cache.json"
);

const COS_STATE_PATH = path.join(
  process.env.HOME,
  ".claude/state/cos-state.json"
);

const APPLICATIONS_DIR = path.join(
  process.env.HOME,
  "Documents/LLM CONTEXT/1 - personal/job_search/Applications"
);

const BEADS_CWD = path.join(
  process.env.HOME,
  "Documents/LLM CONTEXT/1 - personal"
);

// ============================================================================
// TEMPLATES
// ============================================================================

function generateResearchNotesTemplate(listing) {
  const date = new Date().toISOString().split("T")[0];
  const companyClean = listing.company.replace(/[^a-zA-Z0-9\s]/g, "").trim();

  return `# ${companyClean} - ${listing.title}

**Application Status:** QUALIFIED - Pending Materials
**Source:** LinkedIn Job Search (${date})
**Role URL:** ${listing.jobUrl || "TBD"}
**CMF Score:** ${listing.score || "N/A"}

---

## Role Overview

| Field | Value |
|-------|-------|
| **Company** | ${listing.company} |
| **Role** | ${listing.title} |
| **Location** | ${listing.location || "TBD"} |
| **Posted** | ${listing.postedTime || "Unknown"} |
| **Compensation** | TBD - Research needed |
| **Company Stage** | TBD - Research needed |

### Role Description

*[Copy from job posting or summarize key points]*

### Key Responsibilities

1. TBD - Extract from posting
2. TBD
3. TBD

### Requirements

**Minimum:**
- TBD - Extract from posting

**Preferred:**
- TBD - Extract from posting

---

## Strategic Fit Analysis

### Priority Scoring (1-10)

| Criterion | Score | Rationale |
|-----------|-------|-----------|
| **Role Appeal** | ? | *[How excited am I about this role?]* |
| **Company Fit** | ? | *[How well does company align with values/goals?]* |
| **Growth Potential** | ? | *[Learning/advancement opportunities?]* |
| **Likelihood** | ? | *[How competitive am I?]* |
| **TOTAL** | **?** | *[Proceed if >= 28 or any category 9+]* |

### CMF Sweet Spot Match

- **Sweet Spot:** ${listing.scoreBreakdown?.sweetSpot?.category || "TBD"}
- **Company Tier:** ${listing.scoreBreakdown?.companyTier?.tier || "TBD"}
- **Role Level:** ${listing.scoreBreakdown?.roleLevel?.level || "TBD"}

### Freedom-Leverage-Meaning Test

- **Freedom**: *[Autonomy, flexibility, work style?]*
- **Leverage**: *[Impact multiplier, brand, resources?]*
- **Meaning**: *[Mission alignment, purpose?]*

---

## Company Intelligence

### Company Profile

| Attribute | Value |
|-----------|-------|
| **Founded** | TBD |
| **Valuation/Revenue** | TBD |
| **Employees** | TBD |
| **HQ** | TBD |
| **Business Model** | TBD |

### Strategic Context

*[Research: current priorities, recent news, competitive landscape]*

---

## Networking Strategy

### Target Contacts

| Priority | Name | Role | Connection Path |
|----------|------|------|-----------------|
| 1 | TBD | Hiring Manager | LinkedIn search |
| 2 | TBD | Team member | 2nd degree |
| 3 | TBD | Recruiter | Apply + flag |

### LinkedIn Search Actions

- [ ] Search 1st/2nd degree connections at ${companyClean}
- [ ] Check Stellar Elements alumni at ${companyClean}
- [ ] Look for industry connections

---

## Application Strategy

### Positioning

**Primary Value Prop:**
*[Strategy leader who combines consulting rigor with operator perspective]*

**Key Differentiators:**
1. *[What makes you uniquely qualified?]*
2. *[Relevant experience angle]*
3. *[Technical/domain differentiator]*

### Stories to Prepare

| Story | Relevance |
|-------|-----------|
| DWA AI Integration | *[If relevant to role]* |
| Wasabi Growth | *[If growth focus]* |
| Comcast ROI Framework | *[If quantitative focus]* |

---

## Action Plan

### Immediate (Next 24-48 Hours)

- [x] Create application folder and research notes
- [ ] Deep research on company and role
- [ ] Search LinkedIn for connections
- [ ] Draft outreach strategy

### Materials Needed

- [ ] Customized resume
- [ ] Cover letter (anti-slop validated)
- [ ] Cold outreach email draft

---

## Notes & Updates

**${date}:** Application folder created via job pipeline. CMF score: ${listing.score || "N/A"}. Awaiting material generation.

---

*Next Review: After research complete*
`;
}

function generateJobPostingTemplate(listing) {
  const date = new Date().toISOString().split("T")[0];

  return `# Job Posting Archive

**Capture Date:** ${date}
**Source URL:** ${listing.jobUrl || "Unknown"}
**Status:** Captured via job pipeline

---

## Original Posting

**Title:** ${listing.title}
**Company:** ${listing.company}
**Location:** ${listing.location || "Unknown"}
**Posted:** ${listing.postedTime || "Unknown"}

---

### Job Description

*[Paste full job description here when fetched]*

---

### Notes

- Scraped via job-scraper.js on ${date}
- CMF Score: ${listing.score || "N/A"}
- Sweet Spot: ${listing.scoreBreakdown?.sweetSpot?.category || "Unknown"}

`;
}

// ============================================================================
// FOLDER MANAGEMENT
// ============================================================================

function getNextFolderNumber() {
  if (!fs.existsSync(APPLICATIONS_DIR)) {
    fs.mkdirSync(APPLICATIONS_DIR, { recursive: true });
    return 1;
  }

  const existing = fs.readdirSync(APPLICATIONS_DIR)
    .filter(f => /^\d+-/.test(f))
    .map(f => parseInt(f.split("-")[0]))
    .filter(n => !isNaN(n));

  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 30);
}

function createApplicationFolder(listing) {
  const folderNum = getNextFolderNumber();
  const companySlug = slugify(listing.company);
  const folderName = `${String(folderNum).padStart(2, "0")}-${companySlug}`;
  const folderPath = path.join(APPLICATIONS_DIR, folderName);

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const date = new Date().toISOString().split("T")[0];

  // Create Application_Research_Notes.md
  ensureApplicationScaffold(folderPath, listing, date);

  return { folderName, folderPath, folderNum };
}

function ensureApplicationScaffold(folderPath, listing, date = new Date().toISOString().split("T")[0]) {
  const researchNotesPath = path.join(folderPath, "Application_Research_Notes.md");
  if (!fs.existsSync(researchNotesPath)) {
    fs.writeFileSync(researchNotesPath, generateResearchNotesTemplate(listing));
  }

  const jobPostingPath = path.join(folderPath, `Job_Posting_${date}.md`);
  if (!fs.existsSync(jobPostingPath)) {
    fs.writeFileSync(jobPostingPath, generateJobPostingTemplate(listing));
  }
}

// ============================================================================
// RESEARCH INTEGRATION
// ============================================================================

function runResearchCLI(company, roleTitle) {
  try {
    const args = [company];
    if (roleTitle) {
      args.push("--hm", roleTitle);
    }
    args.push("--json");

    const output = execFileSync(RESEARCH_CMD, args, {
      encoding: "utf8",
      timeout: 120000, // 2 minutes for all searches
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"], // Show stderr progress
    });

    // Parse JSON from output (skip any non-JSON lines)
    const jsonStart = output.indexOf("{");
    if (jsonStart === -1) return null;

    return JSON.parse(output.substring(jsonStart));
  } catch (err) {
    console.error(`  Research failed: ${err.message}`);
    return null;
  }
}

function formatResearchForTemplate(research) {
  if (!research) return null;

  const company = research.company || {};
  const funding = company.funding || {};
  const leadership = research.leadership || { ceo: {} };
  const ceo = leadership.ceo || {};
  const hiringManager = research.hiringManager || { candidates: [] };
  const companyContent = research.companyContent || {};
  const news = Array.isArray(research.news) ? research.news : [];

  // Build the populated Company Intelligence section
  let companyIntel = `## Company Intelligence

### Company Profile

| Attribute | Value |
|-----------|-------|
| **Founded** | ${company.founded || "TBD"} |
| **Valuation/Revenue** | ${funding.stage ? `${funding.stage} ` : ""}${funding.amount || "TBD"}${funding.date ? ` (${funding.date})` : ""} |
| **Employees** | ${company.size || "TBD"} |
| **HQ** | ${company.hq || "TBD"} |
| **Business Model** | ${company.description ? company.description.substring(0, 150) : "TBD"} |

### Strategic Context

`;

  // Add recent news as strategic context
  if (news && news.length > 0) {
    companyIntel += `**Recent News:**\n`;
    for (const item of news.slice(0, 3)) {
      companyIntel += `- [${item.headline}](${item.url})${item.source ? ` - ${item.source}` : ""}${item.date ? ` (${item.date})` : ""}\n`;
    }
    companyIntel += "\n";
  }

  // Add leadership info
  if (ceo.name) {
    companyIntel += `**CEO/Founder:** ${ceo.name}`;
    if (ceo.linkedin) companyIntel += ` ([LinkedIn](${ceo.linkedin}))`;
    if (ceo.twitter) companyIntel += ` ([Twitter](${ceo.twitter}))`;
    companyIntel += "\n\n";

    if (Array.isArray(ceo.recentPosts) && ceo.recentPosts.length > 0) {
      companyIntel += `**Recent CEO Statements:**\n`;
      for (const post of ceo.recentPosts.slice(0, 2)) {
        const content = String(post.content || "").substring(0, 120).replace(/\n/g, " ");
        companyIntel += `- "${content}..." ([source](${post.url}))\n`;
      }
      companyIntel += "\n";
    }
  }

  // Add company content
  if (companyContent) {
    const hasBlog = companyContent.blogPosts && companyContent.blogPosts.length > 0;
    const hasPodcast = companyContent.podcasts && companyContent.podcasts.length > 0;

    if (hasBlog || hasPodcast) {
      companyIntel += `**Recent Content:**\n`;
      if (hasBlog) {
        for (const post of companyContent.blogPosts.slice(0, 2)) {
          companyIntel += `- [Blog] [${post.title}](${post.url})${post.date ? ` - ${post.date}` : ""}\n`;
        }
      }
      if (hasPodcast) {
        for (const pod of companyContent.podcasts.slice(0, 2)) {
          companyIntel += `- [Podcast] [${pod.title}](${pod.url})${pod.date ? ` - ${pod.date}` : ""}\n`;
        }
      }
    }
  }

  // Build the populated Networking Strategy section
  let networking = `## Networking Strategy

### Target Contacts

`;

  if (hiringManager.candidates && hiringManager.candidates.length > 0) {
    networking += `| Priority | Name | Role | Connection Path |\n`;
    networking += `|----------|------|------|------------------|\n`;
    for (let i = 0; i < Math.min(hiringManager.candidates.length, 3); i++) {
      const c = hiringManager.candidates[i];
      networking += `| ${i + 1} | [${c.name}](${c.linkedin}) | ${c.title} | ${c.confidence} |\n`;
    }
    networking += "\n";
  } else {
    networking += `| Priority | Name | Role | Connection Path |
|----------|------|------|-----------------|
| 1 | TBD | Hiring Manager | LinkedIn search |
| 2 | TBD | Team member | 2nd degree |
| 3 | TBD | Recruiter | Apply + flag |

`;
  }

  if (hiringManager.searchQuery) {
    networking += `**LinkedIn HM Search:** [Find candidates](${hiringManager.searchQuery})\n\n`;
  }

  return { companyIntel, networking, research };
}

function populateResearchNotes(folderPath, research) {
  const notesPath = path.join(folderPath, "Application_Research_Notes.md");
  if (!fs.existsSync(notesPath)) return false;

  let content = fs.readFileSync(notesPath, "utf8");
  const formatted = formatResearchForTemplate(research);

  if (!formatted) return false;

  // Replace the Company Intelligence section
  const companyIntelRegex = /## Company Intelligence[\s\S]*?(?=\n---\n|## Networking Strategy)/;
  if (companyIntelRegex.test(content)) {
    content = content.replace(companyIntelRegex, formatted.companyIntel);
  }

  // Replace the Networking Strategy section
  const networkingRegex = /## Networking Strategy[\s\S]*?(?=\n---\n|## Application Strategy)/;
  if (networkingRegex.test(content)) {
    content = content.replace(networkingRegex, formatted.networking);
  }

  // Add research timestamp at the bottom
  const timestamp = `\n**Research auto-populated:** ${new Date().toISOString().split("T")[0]}\n`;
  content = content.replace(
    /\*Next Review:.*?\*/,
    `*Research auto-populated on ${new Date().toISOString().split("T")[0]}*`
  );

  fs.writeFileSync(notesPath, content);

  // Also save raw research JSON for reference
  const jsonPath = path.join(folderPath, "research.json");
  fs.writeFileSync(jsonPath, JSON.stringify(research, null, 2));

  return true;
}

// ============================================================================
// JOB POSTING FETCH (Optional)
// ============================================================================

async function fetchJobPosting(url) {
  try {
    const browser = await puppeteer.connect({
      browserURL: "http://localhost:9222",
      defaultViewport: null,
    });

    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes(url)) || pages[pages.length - 1];

    // Navigate to job if not already there
    if (!page.url().includes("/jobs/view/")) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));
    }

    // Extract job description
    const content = await page.evaluate(() => {
      const selectors = [
        ".jobs-description__content",
        ".jobs-description",
        '[class*="job-description"]',
        ".description__text",
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el.innerText;
      }

      return null;
    });

    await browser.disconnect();
    return content;
  } catch (err) {
    console.error("Error fetching job posting:", err.message);
    return null;
  }
}

// ============================================================================
// CACHE & STATE MANAGEMENT
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

function loadCosState() {
  try {
    if (fs.existsSync(COS_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(COS_STATE_PATH, "utf8"));
    }
  } catch (err) {
    console.error("Error loading cos-state:", err.message);
  }
  return { version: "1.0" };
}

function saveCosState(state) {
  state.last_updated = new Date().toISOString();
  fs.writeFileSync(COS_STATE_PATH, JSON.stringify(state, null, 2));
}

function ensureJobPipelineState(state) {
  ensureJobPipeline(state);
}

function updateCosStateWithPrep(folderName, listing, beadsIssueId = null) {
  const state = loadCosState();
  ensureJobPipelineState(state);

  const queueId = listing.queueId || queueIdForEntry({
    jobId: listing.jobId,
    folderName,
    company: listing.company,
    title: listing.title,
  });

  const removeSameEntry = (entry) => {
    return samePipelineEntry(entry, { queueId, jobId: listing.jobId, folderName });
  };

  state.job_pipeline.pending_materials = state.job_pipeline.pending_materials.filter((entry) => !removeSameEntry(entry));
  state.job_pipeline.materials_ready = state.job_pipeline.materials_ready.filter((entry) => !removeSameEntry(entry));
  state.job_pipeline.submitted_applications = state.job_pipeline.submitted_applications.filter((entry) => !removeSameEntry(entry));

  state.job_pipeline.pending_materials.push(withQueueId({
    queueId,
    folderName,
    company: listing.company,
    title: listing.title,
    jobId: listing.jobId,
    score: listing.score,
    beadsIssueId,
    createdAt: new Date().toISOString(),
  }));

  state.job_pipeline.pending_materials = dedupePipelineEntries(state.job_pipeline.pending_materials);
  state.job_pipeline.materials_ready = dedupePipelineEntries(state.job_pipeline.materials_ready);
  state.job_pipeline.submitted_applications = dedupePipelineEntries(state.job_pipeline.submitted_applications);

  saveCosState(state);
}

function oneLine(text, maxLength = 80) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function upsertTrackingSection(notesPath, issueId) {
  if (!issueId || !fs.existsSync(notesPath)) return false;

  let content = fs.readFileSync(notesPath, "utf8");
  const date = new Date().toISOString().split("T")[0];
  const block = [
    "## Tracking",
    "",
    `**Beads Issue:** \`${issueId}\``,
    "**Status:** Open - awaiting materials",
    `**Created:** ${date}`,
    "",
  ].join("\n");

  const trackingRegex = /## Tracking[\s\S]*?(?=\n---\n|\n## |\n\*Next Review|\s*$)/;
  if (trackingRegex.test(content)) {
    content = content.replace(trackingRegex, block.trimEnd());
  } else if (content.includes("## Notes & Updates")) {
    content = content.replace("## Notes & Updates", `${block}\n## Notes & Updates`);
  } else {
    content = `${content.trimEnd()}\n\n${block}`;
  }

  fs.writeFileSync(notesPath, content);
  return true;
}

function createOrReadBeadsIssue(folderName, folderPath, listing) {
  const issueFile = path.join(folderPath, ".beads-issue");
  if (fs.existsSync(issueFile)) {
    const existing = fs.readFileSync(issueFile, "utf8").trim();
    if (existing) return { issueId: existing, created: false };
  }

  const shortRole = oneLine(listing.title, 64);
  const company = oneLine(listing.company, 40);
  const date = new Date().toISOString().split("T")[0];
  const title = `Apply to ${company} - ${shortRole}`;
  const description = `${shortRole}. CMF score: ${listing.score ?? "N/A"}. Apply URL: ${listing.jobUrl || "N/A"}`;
  const notes = `Folder: ${folderName}. Created ${date}.`;

  try {
    const output = execFileSync(
      "bd",
      [
        "create",
        title,
        "-l",
        "job search task",
        "-p",
        "P1",
        "-d",
        description,
        "--notes",
        notes,
        "--silent",
      ],
      {
        cwd: BEADS_CWD,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const issueId = output.trim().split("\n").pop();
    if (!issueId) return { issueId: null, created: false, error: "empty issue id from bd create" };
    fs.writeFileSync(issueFile, `${issueId}\n`);
    return { issueId, created: true };
  } catch (err) {
    return { issueId: null, created: false, error: err.message };
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  let jobId = null;
  let companyFilter = null;
  let prepAll = false;
  let listOnly = false;
  let shouldFetch = false;
  let skipBeads = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--company" || arg === "-c") companyFilter = args[++i];
    else if (arg === "--all" || arg === "-a") prepAll = true;
    else if (arg === "--list" || arg === "-l") listOnly = true;
    else if (arg === "--fetch" || arg === "-f") shouldFetch = true;
    else if (arg === "--skip-beads") skipBeads = true;
    else if (arg === "--json") jsonOutput = true;
    else if (!arg.startsWith("-")) jobId = arg;
  }

  const log = (...parts) => {
    if (!jsonOutput) console.log(...parts);
  };

  const cache = loadCache();
  const listings = Object.entries(cache.listings);

  // Filter to qualified listings
  const qualified = listings.filter(([_, l]) =>
    l.status === "qualified" && !l.applicationFolder
  );

  if (listOnly) {
    if (jsonOutput) {
      const listingData = qualified.map(([id, listing]) => ({
        jobId: id,
        company: listing.company || null,
        title: listing.title || null,
        score: listing.score ?? null,
      }));
      console.log(JSON.stringify({
        action: "list_qualified_for_prep",
        total: listingData.length,
        listings: listingData,
      }, null, 2));
      return;
    }
    console.log(`\nQualified listings awaiting prep:\n`);
    console.log("─".repeat(60));

    if (qualified.length === 0) {
      console.log("No qualified listings awaiting prep.");
      console.log("Run job-scraper.js and job-qualify.js first.");
    } else {
      for (const [id, listing] of qualified) {
        console.log(`[${listing.score}] ${listing.title}`);
        console.log(`     ${listing.company} | ID: ${id}`);
        console.log("");
      }
      console.log("─".repeat(60));
      console.log(`Total: ${qualified.length}`);
      console.log(`\nUse: job-apply-prep.js <job-id> to prep a specific job`);
    }
    return;
  }

  // Find listings to prep
  let toPrep = [];

  if (jobId) {
    const listing = cache.listings[jobId];
    if (listing) {
      toPrep.push([jobId, listing]);
    } else {
      console.error(`Job ID not found: ${jobId}`);
      process.exit(1);
    }
  } else if (companyFilter) {
    toPrep = qualified.filter(([_, l]) =>
      l.company.toLowerCase().includes(companyFilter.toLowerCase())
    );
    if (toPrep.length === 0) {
      console.error(`No qualified listings found for company: ${companyFilter}`);
      process.exit(1);
    }
  } else if (prepAll) {
    toPrep = qualified;
  } else {
    console.log("Usage:");
    console.log("  job-apply-prep.js <job-id>         # Prep specific job");
    console.log("  job-apply-prep.js --company X      # Prep by company");
    console.log("  job-apply-prep.js --all            # Prep all qualified");
    console.log("  job-apply-prep.js --list           # List awaiting prep");
    console.log("  job-apply-prep.js --fetch          # Fetch posting content");
    console.log("  job-apply-prep.js --skip-beads     # Skip beads issue creation");
    console.log("  job-apply-prep.js --json           # JSON summary output");
    return;
  }

  if (toPrep.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        action: "apply_prep",
        preparedCount: 0,
        message: "No listings to prep",
      }, null, 2));
      return;
    }
    console.log("No listings to prep.");
    return;
  }

  const prepared = [];
  log(`\nPreparing ${toPrep.length} application folder(s)...\n`);

  for (const [id, listing] of toPrep) {
    log(`Processing: ${listing.company} - ${listing.title}`);

    // Create folder (idempotent reuse if already exists)
    let folderName;
    let folderPath;
    let reusedFolder = false;
    if (cache.listings[id].applicationFolder) {
      folderName = cache.listings[id].applicationFolder;
      folderPath = path.join(APPLICATIONS_DIR, folderName);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
      ensureApplicationScaffold(folderPath, listing);
      reusedFolder = true;
    } else {
      const created = createApplicationFolder(listing);
      folderName = created.folderName;
      folderPath = created.folderPath;
    }
    log(`  ${reusedFolder ? "Reused" : "Created"}: ${folderName}/`);

    // Run automated research
    log("  Researching company...");
    const research = runResearchCLI(listing.company, listing.title);
    let researchPopulated = false;
    if (research) {
      const populated = populateResearchNotes(folderPath, research);
      if (populated) {
        log("  ✓ Research populated");
        researchPopulated = true;

        // Store research summary in cache
        cache.listings[id].research = {
          researchedAt: research.researchedAt,
          ceoName: research.leadership?.ceo?.name || null,
          hmCandidates: research.hiringManager?.candidates?.length || 0,
          newsCount: research.news?.length || 0,
        };
      }
    } else {
      log("  ⚠ Research skipped (search failed)");
    }

    // Create or reuse tracking issue in beads
    let beadsIssueId = null;
    if (skipBeads) {
      log("  ⚠ Beads skipped (--skip-beads)");
    } else {
      const beadsResult = createOrReadBeadsIssue(folderName, folderPath, listing);
      if (beadsResult.issueId) {
        beadsIssueId = beadsResult.issueId;
        const notesPath = path.join(folderPath, "Application_Research_Notes.md");
        upsertTrackingSection(notesPath, beadsIssueId);
        if (beadsResult.created) {
          log(`  ✓ Beads issue created: ${beadsIssueId}`);
        } else {
          log(`  ✓ Beads issue linked: ${beadsIssueId}`);
        }
      } else {
        log(`  ⚠ Beads issue unavailable: ${beadsResult.error || "unknown error"}`);
      }
    }

    // Update cache with folder reference
    const queueId = cache.listings[id].queueId || queueIdForEntry({
      jobId: id,
      folderName,
      company: listing.company,
      title: listing.title,
    });
    cache.listings[id].queueId = queueId;
    cache.listings[id].applicationFolder = folderName;
    cache.listings[id].status = "prepped";
    cache.listings[id].preppedAt = new Date().toISOString();
    if (beadsIssueId) {
      cache.listings[id].beadsIssueId = beadsIssueId;
    }

    // Update cos-state
    updateCosStateWithPrep(folderName, listing, beadsIssueId);

    // Optionally fetch job posting content
    if (shouldFetch && listing.jobUrl) {
      log("  Fetching job posting content...");
      const content = await fetchJobPosting(listing.jobUrl);
      if (content) {
        const date = new Date().toISOString().split("T")[0];
        const postingPath = path.join(folderPath, `Job_Posting_${date}.md`);
        let existing = fs.readFileSync(postingPath, "utf8");
        existing = existing.replace(
          "*[Paste full job description here when fetched]*",
          content
        );
        fs.writeFileSync(postingPath, existing);
        log("  Job description captured!");
      } else {
        log("  Could not fetch job description.");
      }
    }

    prepared.push({
      queueId: cache.listings[id].queueId || null,
      jobId: id,
      company: listing.company || null,
      title: listing.title || null,
      folderName,
      reusedFolder,
      beadsIssueId: beadsIssueId || null,
      researchPopulated,
      fetchedPosting: Boolean(shouldFetch && listing.jobUrl),
    });

    log("");
  }

  saveCache(cache);

  if (jsonOutput) {
    console.log(JSON.stringify({
      action: "apply_prep",
      preparedCount: prepared.length,
      applicationsDir: APPLICATIONS_DIR,
      prepared,
    }, null, 2));
    return;
  }

  console.log("─".repeat(60));
  console.log(`Folders created: ${toPrep.length}`);
  console.log(`Location: ${APPLICATIONS_DIR}`);
  console.log("");
  console.log("Next steps:");
  console.log("1. Review and complete Application_Research_Notes.md");
  console.log("2. Use Claude to generate cover letter and resume");
  console.log("3. Run /morning to see pending materials in briefing");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
