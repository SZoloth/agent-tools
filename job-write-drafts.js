#!/usr/bin/env node

/**
 * job-write-drafts.js - Generate draft materials for pending applications.
 *
 * Creates:
 *  - Cover_Letter_YYYY-MM-DD.md
 *  - Resume_<company>_<role>_YYYY-MM-DD.md
 *
 * Then moves item to materials_ready via job-materials-ready.js.
 *
 * Usage:
 *   job-write-drafts.js 1
 *   job-write-drafts.js --job-id 4338838020
 *   job-write-drafts.js --company "Stripe" --top 3
 *   job-write-drafts.js --all
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const STATE_PATH = path.join(HOME, ".claude/state/cos-state.json");
const CACHE_PATH = path.join(HOME, ".claude/state/job-listings-cache.json");
const APPLICATIONS_DIR = path.join(
  HOME,
  "Documents/LLM CONTEXT/1 - personal/job_search/Applications"
);
const RESUME_DIR = path.join(
  HOME,
  "Documents/LLM CONTEXT/1 - personal/job_search/resumes"
);

function parseArgs(argv) {
  const opts = {
    target: null,
    folder: null,
    jobId: null,
    company: null,
    top: 1,
    all: false,
    force: false,
    channel: "auto-draft",
    skipBeads: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--folder" && argv[i + 1]) opts.folder = argv[++i];
    else if (arg === "--job-id" && argv[i + 1]) opts.jobId = argv[++i];
    else if (arg === "--company" && argv[i + 1]) opts.company = argv[++i];
    else if (arg === "--top" && argv[i + 1]) opts.top = Math.max(1, Number(argv[++i]));
    else if (arg === "--all") opts.all = true;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--channel" && argv[i + 1]) opts.channel = argv[++i];
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-") && !opts.target) opts.target = arg;
  }

  return opts;
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err.message}`);
  }
  return fallback;
}

function ensurePipeline(state) {
  if (!state.job_pipeline) state.job_pipeline = {};
  if (!Array.isArray(state.job_pipeline.pending_materials)) {
    state.job_pipeline.pending_materials = [];
  }
}

function slugify(value, max = 28) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max) || "unknown";
}

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

function findBySelectors(entries, opts) {
  if (opts.folder) return entries.filter((e) => e.folderName === opts.folder);
  if (opts.jobId) return entries.filter((e) => String(e.jobId) === String(opts.jobId));
  if (opts.company) {
    const needle = normalize(opts.company);
    return entries.filter((e) => normalize(e.company).includes(needle));
  }
  if (opts.target && /^\d+$/.test(opts.target)) {
    const idx = Number(opts.target) - 1;
    return idx >= 0 && idx < entries.length ? [entries[idx]] : [];
  }
  if (opts.target) {
    const needle = normalize(opts.target);
    return entries.filter((e) =>
      e.folderName === opts.target ||
      String(e.jobId || "") === opts.target ||
      normalize(e.company).includes(needle)
    );
  }
  return entries.slice(0, opts.top);
}

function resolveListing(cacheListings, entry) {
  if (entry.jobId && cacheListings[String(entry.jobId)]) {
    return { jobId: String(entry.jobId), listing: cacheListings[String(entry.jobId)] };
  }
  if (entry.folderName) {
    const jobId = Object.keys(cacheListings).find(
      (id) => cacheListings[id]?.applicationFolder === entry.folderName
    );
    if (jobId) return { jobId, listing: cacheListings[jobId] };
  }
  return { jobId: entry.jobId || null, listing: null };
}

function findCanonicalResume() {
  try {
    if (!fs.existsSync(RESUME_DIR)) return null;
    const files = fs
      .readdirSync(RESUME_DIR)
      .filter((name) => /^primary-general-resume-.*\.md$/i.test(name))
      .map((name) => {
        const full = path.join(RESUME_DIR, name);
        return { name, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].full : null;
  } catch {
    return null;
  }
}

function extractEvidenceBullets(resumeContent, max = 3) {
  if (!resumeContent) return [];
  const lines = String(resumeContent)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates = [];
  for (const line of lines) {
    const clean = line.replace(/^[-*•]\s*/, "").trim();
    if (clean.length < 35 || clean.length > 220) continue;
    if (!/\d/.test(clean)) continue;
    if (!/\b(improved|increased|reduced|grew|launched|built|scaled|drove|led|owned|delivered|cut)\b/i.test(clean)) continue;
    candidates.push(clean);
  }
  return candidates.slice(0, max);
}

function buildCoverLetter(entry, listing, date, resumeEvidence = []) {
  const company = entry.company || listing?.company || "Company";
  const title = entry.title || listing?.title || "Role";
  const location = listing?.location || "N/A";
  const url = listing?.jobUrl || "N/A";
  const opening = `Dear Hiring Team at ${company},`;
  const evidenceSection = resumeEvidence.length > 0
    ? resumeEvidence.map((b) => `- ${b}`).join("\n")
    : "- I deliver strategy + execution by aligning teams on measurable outcomes.\n- I translate ambiguous problem spaces into focused roadmaps and shipped results.";

  return `# Cover Letter Draft - ${company} - ${title}

${date}

${opening}

I am applying for the ${title} role. The scope and operating context at ${company} align with how I work best: clarify the highest-leverage product bets, align cross-functional execution, and ship against measurable outcomes.

From my experience leading product strategy and operations work, I would bring this orientation to ${company} immediately:
${evidenceSection}

I would value the chance to discuss how this approach can support your team for ${title} in ${location}. I reviewed the role posting here: ${url}.

Thank you for your consideration.

Sam Zoloth
smzoloth@gmail.com | 617-943-0717 | samzoloth.com
`;
}

function buildResumeDraft(entry, listing, canonicalResumeContent, date) {
  const company = entry.company || listing?.company || "Company";
  const title = entry.title || listing?.title || "Role";

  const header = `# Resume Draft - ${company} - ${title}

Generated: ${date}

## Tailoring Priorities

- Reorder bullets to emphasize strategic product impact.
- Keep X-Y-Z quantification in top bullets.
- Mirror job language for domain/functional keywords.
- Keep tone factual and specific (no generic AI phrasing).

---

`;

  if (canonicalResumeContent) {
    return `${header}${canonicalResumeContent.trim()}\n`;
  }

  return `${header}## Experience\n\n- Add tailored experience bullets.\n\n## Skills\n\n- Add role-relevant skills.\n`;
}

function evaluateDraftQuality(text, { company, title }) {
  const issues = [];
  const normalized = String(text || "");
  const words = normalized.trim().split(/\s+/).filter(Boolean).length;
  const placeholderPatterns = [
    /\bTBD\b/i,
    /\bAdd one\b/i,
    /\bawaiting\b/i,
    /\btemplate\b/i,
    /\blorem ipsum\b/i,
  ];

  if (!normalized.includes(String(company || ""))) issues.push("missing-company-name");
  if (!normalized.includes(String(title || ""))) issues.push("missing-role-title");
  if (words < 120) issues.push("too-short");
  for (const pattern of placeholderPatterns) {
    if (pattern.test(normalized)) {
      issues.push("contains-placeholder-text");
      break;
    }
  }

  return { pass: issues.length === 0, issues, wordCount: words };
}

function runMaterialsReady(entry, opts) {
  const args = [];
  if (entry.jobId) args.push("--job-id", String(entry.jobId));
  else args.push("--folder", entry.folderName);
  args.push("--channel", opts.channel);
  if (opts.skipBeads) args.push("--skip-beads");
  if (opts.dryRun) args.push("--dry-run");
  args.push("--json");

  const output = execFileSync("node", [path.join(__dirname, "job-materials-ready.js"), ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 60000,
  });
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : { raw: output };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-write-drafts.js <index|target> [options]");
    console.log("Options: --job-id --folder --company --all --top N --force --channel X --skip-beads --dry-run --json");
    return;
  }

  const state = loadJson(STATE_PATH, { version: "1.0", job_pipeline: {} });
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  ensurePipeline(state);

  const pending = state.job_pipeline.pending_materials || [];
  let selected = pending;
  if (!opts.all) {
    selected = findBySelectors(pending, opts);
  }
  if (!opts.all && !opts.folder && !opts.jobId && !opts.company && !opts.target) {
    selected = selected.slice(0, opts.top);
  }

  if (selected.length === 0) {
    const emptySummary = {
      action: "write_drafts",
      dryRun: opts.dryRun,
      selected: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      message: "No matching pending_materials entries.",
    };
    if (opts.json) {
      console.log(JSON.stringify(emptySummary, null, 2));
      return;
    }
    console.log("WRITE DRAFTS COMPLETE");
    console.log("Selected: 0");
    console.log("Succeeded: 0");
    console.log("Failed: 0");
    console.log("No matching pending_materials entries.");
    return;
  }

  const date = new Date().toISOString().split("T")[0];
  const canonicalResumePath = findCanonicalResume();
  const canonicalResumeContent = canonicalResumePath ? fs.readFileSync(canonicalResumePath, "utf8") : null;
  const resumeEvidence = extractEvidenceBullets(canonicalResumeContent, 3);
  const results = [];

  for (const entry of selected) {
    const folderName = entry.folderName;
    const folderPath = folderName ? path.join(APPLICATIONS_DIR, folderName) : null;
    if (!folderPath || !fs.existsSync(folderPath)) {
      results.push({
        jobId: entry.jobId || null,
        folderName: folderName || null,
        ok: false,
        reason: "missing-folder",
      });
      continue;
    }

    const { jobId, listing } = resolveListing(cache.listings || {}, entry);
    const company = entry.company || listing?.company || "company";
    const title = entry.title || listing?.title || "role";
    const coverName = `Cover_Letter_${date}.md`;
    const resumeName = `Resume_${slugify(company, 24)}_${slugify(title, 24)}_${date}.md`;
    const coverPath = path.join(folderPath, coverName);
    const resumePath = path.join(folderPath, resumeName);

    const coverExists = fs.existsSync(coverPath);
    const resumeExists = fs.existsSync(resumePath);

    if (!opts.dryRun) {
      if (!coverExists || opts.force) {
        fs.writeFileSync(coverPath, buildCoverLetter(entry, listing, date, resumeEvidence));
      }
      if (!resumeExists || opts.force) {
        fs.writeFileSync(resumePath, buildResumeDraft(entry, listing, canonicalResumeContent, date));
      }
    }

    const coverContent = fs.existsSync(coverPath) ? fs.readFileSync(coverPath, "utf8") : "";
    const quality = evaluateDraftQuality(coverContent, { company, title });
    if (!quality.pass && !opts.force) {
      results.push({
        jobId: jobId || null,
        folderName,
        ok: false,
        reason: "quality-gate-failed",
        quality,
        coverPath,
        resumePath,
      });
      continue;
    }

    let materialsMove = null;
    try {
      materialsMove = runMaterialsReady({ ...entry, jobId }, opts);
    } catch (err) {
      results.push({
        jobId: jobId || null,
        folderName,
        ok: false,
        reason: `materials-ready-failed: ${err.message}`,
        coverPath,
        resumePath,
      });
      continue;
    }

    results.push({
      jobId: jobId || null,
      folderName,
      ok: true,
      coverPath,
      resumePath,
      canonicalResumePath,
      quality,
      materialsMove,
    });
  }

  const summary = {
    action: "write_drafts",
    dryRun: opts.dryRun,
    selected: selected.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("WRITE DRAFTS COMPLETE");
  console.log(`Selected: ${summary.selected}`);
  console.log(`Succeeded: ${summary.succeeded}`);
  console.log(`Failed: ${summary.failed}`);
}

main();
