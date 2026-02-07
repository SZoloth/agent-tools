#!/usr/bin/env node

/**
 * job-trigger.js - Intake trigger for company/listings -> review-ready pipeline.
 *
 * Usage:
 *   job-trigger.js stripe
 *   job-trigger.js --company stripe --company figma
 *   job-trigger.js --url https://www.linkedin.com/jobs/view/12345
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const CACHE_PATH = path.join(HOME, ".claude/state/job-listings-cache.json");

function parseArgs(argv) {
  const opts = {
    companies: [],
    urls: [],
    prepTop: 3,
    threshold: 70,
    channel: "trigger-auto",
    skipBeads: false,
    noWrite: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--company" && argv[i + 1]) opts.companies.push(argv[++i]);
    else if (arg === "--url" && argv[i + 1]) opts.urls.push(argv[++i]);
    else if (arg === "--prep-top" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed)) opts.prepTop = Math.max(0, parsed);
    }
    else if (arg === "--threshold" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed)) opts.threshold = Math.max(1, parsed);
    }
    else if (arg === "--channel" && argv[i + 1]) opts.channel = argv[++i];
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--no-write") opts.noWrite = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (!arg.startsWith("-")) {
      const pieces = String(arg).split(/\n|,/).map((p) => p.trim()).filter(Boolean);
      for (const piece of pieces) {
        if (/^https?:\/\//i.test(piece)) opts.urls.push(piece);
        else opts.companies.push(piece);
      }
    }
  }

  const expand = (values, isUrl = false) => {
    const expanded = [];
    for (const raw of values) {
      const parts = String(raw).split(/\n|,/).map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        if (isUrl && /^https?:\/\//i.test(part)) expanded.push(part);
        if (!isUrl && !/^https?:\/\//i.test(part)) expanded.push(part);
      }
    }
    return [...new Set(expanded)];
  };

  opts.companies = expand(opts.companies, false);
  opts.urls = expand(opts.urls, true);
  return opts;
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Failed to load ${filePath}: ${err.message}`);
  }
  return fallback;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function extractJson(raw) {
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) throw new Error(`Expected JSON output but got: ${raw.slice(0, 180)}`);
  return JSON.parse(raw.slice(start));
}

function runToolJson(cmd, args = []) {
  const scriptPath = path.join(__dirname, cmd);
  const out = execFileSync("node", [scriptPath, ...args, "--json"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120000,
  });
  return extractJson(out);
}

function runToolJsonSafe(cmd, args = []) {
  try {
    return { ok: true, data: runToolJson(cmd, args) };
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : "";
    const stderr = err?.stderr ? String(err.stderr) : "";
    return {
      ok: false,
      error: err?.message || "unknown error",
      stdout: stdout.slice(0, 4000),
      stderr: stderr.slice(0, 4000),
    };
  }
}

function inferJobIdFromUrl(url) {
  const li = String(url).match(/linkedin\.com\/jobs\/view\/(\d+)/i);
  if (li) return `li_${li[1]}`;
  let hash = 0;
  for (const ch of String(url)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `manual_${hash.toString(16)}`;
}

function inferCompanyFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("linkedin.com")) return "Unknown";
    return host.split(".")[0].replace(/[-_]/g, " ");
  } catch {
    return "Unknown";
  }
}

function ingestUrls(urls) {
  if (urls.length === 0) return { added: 0, updated: 0, jobIds: [] };

  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  cache.listings = cache.listings || {};
  let added = 0;
  let updated = 0;
  const jobIds = [];
  const nowIso = new Date().toISOString();

  for (const url of urls) {
    const jobId = inferJobIdFromUrl(url);
    jobIds.push(jobId);
    const existing = cache.listings[jobId];
    const base = {
      jobId,
      title: existing?.title || "Manual Listing",
      company: existing?.company || inferCompanyFromUrl(url),
      location: existing?.location || "",
      jobUrl: url,
      postedTime: existing?.postedTime || null,
      source: "manual_trigger",
      discoveredAt: existing?.discoveredAt || nowIso,
      score: existing?.score ?? null,
      status: existing?.status || "new",
      firstSeen: existing?.firstSeen || nowIso,
    };

    if (existing) {
      cache.listings[jobId] = { ...existing, ...base, updatedAt: nowIso };
      updated++;
    } else {
      cache.listings[jobId] = { ...base, createdAt: nowIso };
      added++;
    }
  }

  cache.lastUpdated = nowIso;
  saveJson(CACHE_PATH, cache);
  return { added, updated, jobIds };
}

function listCandidates(companies, urls, prepTop, explicitJobIds = []) {
  const cache = loadJson(CACHE_PATH, { version: "1.0", listings: {} });
  const entries = Object.entries(cache.listings || {}).map(([jobId, listing]) => ({ jobId, ...listing }));

  const companyNeedles = companies.map((c) => c.toLowerCase());
  const urlSet = new Set(urls);
  const explicitIds = new Set(explicitJobIds.map((id) => String(id)));

  const forced = entries.filter((item) => {
    if (item.applicationFolder) return false;
    return explicitIds.has(String(item.jobId));
  });

  const filteredQualified = entries.filter((item) => {
    if (item.status !== "qualified") return false;
    if (item.applicationFolder) return false;
    if (explicitIds.has(String(item.jobId))) return false;
    if (companyNeedles.length === 0 && urlSet.size === 0) return true;

    const companyMatch = companyNeedles.length > 0 &&
      companyNeedles.some((needle) => String(item.company || "").toLowerCase().includes(needle));
    const urlMatch = urlSet.size > 0 && urlSet.has(item.jobUrl);
    return companyMatch || urlMatch;
  });

  const sortByScoreThenTime = (a, b) => {
    const scoreA = Number(a.score ?? 0);
    const scoreB = Number(b.score ?? 0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const tA = Date.parse(a.scoredAt || a.discoveredAt || a.firstSeen || 0) || 0;
    const tB = Date.parse(b.scoredAt || b.discoveredAt || b.firstSeen || 0) || 0;
    return tB - tA;
  };

  forced.sort(sortByScoreThenTime);
  filteredQualified.sort(sortByScoreThenTime);

  const qualifiedSlice = prepTop > 0 ? filteredQualified.slice(0, prepTop) : [];
  return [...forced, ...qualifiedSlice];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: job-trigger.js [company|url ...] [--company X] [--url X] [--prep-top N] [--no-write] [--json]");
    return;
  }

  if (opts.companies.length === 0 && opts.urls.length === 0) {
    console.error("Provide at least one company or listing URL.");
    process.exit(1);
  }

  const migration = runToolJsonSafe("job-state-migrate.js", ["--threshold", String(opts.threshold)]);
  const urlIngest = ingestUrls(opts.urls);

  let discovery = null;
  if (opts.companies.length > 0) {
    discovery = runToolJsonSafe("job-discover.js", ["--ats", ...opts.companies]);
  }

  const qualify = runToolJsonSafe("job-qualify.js", ["--threshold", String(opts.threshold)]);
  const candidates = listCandidates(opts.companies, opts.urls, opts.prepTop, urlIngest.jobIds);

  const prepRuns = [];
  const prepSuccessIds = new Set();
  for (const candidate of candidates) {
    const args = [candidate.jobId];
    if (opts.skipBeads) args.push("--skip-beads");
    const prepRun = runToolJsonSafe("job-apply-prep.js", args);
    prepRuns.push({ jobId: candidate.jobId, ...prepRun });
    if (prepRun.ok) prepSuccessIds.add(String(candidate.jobId));
  }

  const writeRuns = [];
  if (!opts.noWrite) {
    for (const candidate of candidates) {
      if (!prepSuccessIds.has(String(candidate.jobId))) continue;
      const args = ["--job-id", candidate.jobId, "--channel", opts.channel];
      if (opts.skipBeads) args.push("--skip-beads");
      writeRuns.push({ jobId: candidate.jobId, ...runToolJsonSafe("job-write-drafts.js", args) });
    }
  }

  const backlog = runToolJsonSafe("job-backlog.js", []);

  const result = {
    action: "trigger_pipeline",
    input: {
      companies: opts.companies,
      urls: opts.urls,
      prepTop: opts.prepTop,
      threshold: opts.threshold,
      noWrite: opts.noWrite,
    },
    migration: migration.ok ? migration.data : migration,
    urlIngest,
    discovery: discovery?.ok ? discovery.data : discovery,
    qualify: qualify.ok ? qualify.data : qualify,
    candidates: candidates.map((c) => ({
      jobId: c.jobId,
      company: c.company || null,
      title: c.title || null,
      score: c.score ?? null,
      jobUrl: c.jobUrl || null,
    })),
    prepRuns,
    writeRuns,
    backlog: backlog.ok ? backlog.data : backlog,
    errors: {
      migration: migration.ok ? null : migration.error,
      discovery: discovery && !discovery.ok ? discovery.error : null,
      qualify: qualify.ok ? null : qualify.error,
      backlog: backlog.ok ? null : backlog.error,
      prepFailures: prepRuns.filter((r) => !r.ok).map((r) => ({ jobId: r.jobId, error: r.error })),
      writeFailures: writeRuns.filter((r) => !r.ok).map((r) => ({ jobId: r.jobId, error: r.error })),
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("JOB TRIGGER COMPLETE");
  console.log(`Candidates selected: ${result.candidates.length}`);
  const backlogSummary = result.backlog?.summary || {};
  console.log(`Ready for human review: ${backlogSummary.readyForHumanReview ?? 0}`);
  console.log(`Awaiting writing: ${backlogSummary.awaitingWriting ?? 0}`);
  console.log("");
  console.log("Next:");
  console.log("  /job backlog");
  if ((backlogSummary.readyForHumanReview ?? 0) > 0) {
    console.log("  /job next");
  } else if ((backlogSummary.awaitingWriting ?? 0) > 0) {
    console.log("  /job generate 1");
  }
}

main();
