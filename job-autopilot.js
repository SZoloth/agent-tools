#!/usr/bin/env node

/**
 * job-autopilot.js - Single-command intake -> review queue orchestrator.
 *
 * Usage:
 *   job-autopilot.js stripe
 *   job-autopilot.js --company stripe --url https://www.linkedin.com/jobs/view/12345
 *   job-autopilot.js --backlog-only
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOME = process.env.HOME;
const LOCK_PATH = path.join(HOME, ".claude/state/job-autopilot.lock");

function parseArgs(argv) {
  const opts = {
    companies: [],
    urls: [],
    prepTop: 3,
    threshold: 70,
    channel: "autopilot",
    skipBeads: false,
    noWrite: false,
    backlogOnly: false,
    retries: 1,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--company" && argv[i + 1]) opts.companies.push(argv[++i]);
    else if (arg === "--url" && argv[i + 1]) opts.urls.push(argv[++i]);
    else if (arg === "--prep-top" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) opts.prepTop = Math.max(0, n);
    }
    else if (arg === "--threshold" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) opts.threshold = Math.max(1, n);
    }
    else if (arg === "--channel" && argv[i + 1]) opts.channel = argv[++i];
    else if (arg === "--retries" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) opts.retries = Math.max(0, n);
    }
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--no-write") opts.noWrite = true;
    else if (arg === "--backlog-only") opts.backlogOnly = true;
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

  const dedupe = (values) => [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  opts.companies = dedupe(opts.companies);
  opts.urls = dedupe(opts.urls);
  return opts;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath, timeoutMs = 60000) {
  const start = Date.now();
  const staleMs = 10 * 60 * 1000;
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock disappeared
      }
      await sleep(300);
    }
  }
  return false;
}

function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // best effort
  }
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

function runToolJson(scriptName, args = []) {
  const scriptPath = path.join(__dirname, scriptName);
  const out = execFileSync("node", [scriptPath, ...args, "--json"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return extractJson(out);
}

async function runWithRetry(scriptName, args = [], retries = 1) {
  const attempts = [];
  const total = retries + 1;
  for (let i = 0; i < total; i++) {
    try {
      const data = runToolJson(scriptName, args);
      attempts.push({ attempt: i + 1, ok: true });
      return { ok: true, data, attempts };
    } catch (err) {
      attempts.push({
        attempt: i + 1,
        ok: false,
        error: err.message,
        stdout: err?.stdout ? String(err.stdout).slice(0, 2000) : "",
        stderr: err?.stderr ? String(err.stderr).slice(0, 2000) : "",
      });
      if (i < retries) {
        await sleep(800 * (i + 1));
      }
    }
  }
  return { ok: false, attempts };
}

function buildNextActions(backlogSummary) {
  const actions = [];
  const ready = Number(backlogSummary?.readyForHumanReview || 0);
  const pending = Number(backlogSummary?.awaitingWriting || 0);
  const unprepped = Number(backlogSummary?.qualifiedUnprepped || 0);
  if (ready > 0) {
    actions.push({
      priority: 1,
      command: "/job next",
      reason: `${ready} applications are review-ready`,
    });
  }
  if (pending > 0) {
    actions.push({
      priority: 2,
      command: "/job generate 1",
      reason: `${pending} applications still need writing`,
    });
  }
  if (unprepped > 0) {
    actions.push({
      priority: 3,
      command: "/job run --backfill --write-top 3",
      reason: `${unprepped} qualified listings still need prep`,
    });
  }
  if (actions.length === 0) {
    actions.push({
      priority: 1,
      command: "/job autopilot \"target company or listing URL\"",
      reason: "pipeline is currently clear",
    });
  }
  return actions;
}

function printHelp() {
  console.log("Usage: job-autopilot.js [company|url ...] [options]");
  console.log("");
  console.log("Options:");
  console.log("  --company <name>      target company (repeatable)");
  console.log("  --url <listing-url>   explicit listing URL (repeatable)");
  console.log("  --prep-top <n>        number of qualified jobs to prep (default: 3)");
  console.log("  --threshold <n>       qualification threshold (default: 70)");
  console.log("  --channel <name>      audit channel name (default: autopilot)");
  console.log("  --retries <n>         retries for trigger step (default: 1)");
  console.log("  --skip-beads          skip beads side effects");
  console.log("  --no-write            stop before draft generation");
  console.log("  --backlog-only        skip intake/trigger, only return backlog summary");
  console.log("  --json                JSON output");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.backlogOnly && opts.companies.length === 0 && opts.urls.length === 0) {
    console.error("Provide at least one company or URL, or use --backlog-only.");
    process.exit(1);
  }

  const lockAcquired = await acquireLock(LOCK_PATH, 60000);
  if (!lockAcquired) {
    console.error(`Could not acquire lock at ${LOCK_PATH}`);
    process.exit(1);
  }

  try {
    let trigger = null;
    if (!opts.backlogOnly) {
      const triggerArgs = [
        ...opts.companies,
        ...opts.urls,
        "--prep-top", String(opts.prepTop),
        "--threshold", String(opts.threshold),
        "--channel", String(opts.channel),
      ];
      if (opts.skipBeads) triggerArgs.push("--skip-beads");
      if (opts.noWrite) triggerArgs.push("--no-write");
      trigger = await runWithRetry("job-trigger.js", triggerArgs, opts.retries);
    }

    const backlogRun = await runWithRetry("job-backlog.js", [], 0);
    if (!backlogRun.ok) {
      const fail = {
        action: "job_autopilot",
        ok: false,
        error: "backlog failed",
        trigger,
        backlog: backlogRun,
      };
      if (opts.json) console.log(JSON.stringify(fail, null, 2));
      else console.error("JOB AUTOPILOT FAILED: backlog step failed");
      process.exit(1);
    }

    const backlog = backlogRun.data;
    const summary = backlog.summary || {};
    const result = {
      action: "job_autopilot",
      ok: true,
      input: {
        companies: opts.companies,
        urls: opts.urls,
        prepTop: opts.prepTop,
        threshold: opts.threshold,
        noWrite: opts.noWrite,
        backlogOnly: opts.backlogOnly,
      },
      trigger,
      backlog,
      nextActions: buildNextActions(summary),
      health: {
        triggerHadFailures: Boolean(
          trigger?.ok &&
          trigger?.data?.errors &&
          ((trigger.data.errors.migration || trigger.data.errors.qualify || trigger.data.errors.backlog) ||
            (trigger.data.errors.prepFailures || []).length > 0 ||
            (trigger.data.errors.writeFailures || []).length > 0)
        ),
      },
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("JOB AUTOPILOT COMPLETE");
    console.log(`Ready for human review: ${summary.readyForHumanReview || 0}`);
    console.log(`Awaiting writing: ${summary.awaitingWriting || 0}`);
    console.log(`Qualified unprepped: ${summary.qualifiedUnprepped || 0}`);
    console.log("");
    console.log("Next actions:");
    for (const action of result.nextActions) {
      console.log(`  ${action.priority}. ${action.command}  # ${action.reason}`);
    }

    if (result.health.triggerHadFailures) {
      console.log("");
      console.log("Warnings:");
      console.log("  Some trigger sub-steps reported recoverable failures. Review JSON mode for details.");
    }
  } finally {
    releaseLock(LOCK_PATH);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
