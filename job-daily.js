#!/usr/bin/env node

/**
 * job-daily.js - Single-command daily job workflow.
 *
 * Executes:
 *   1) state migration
 *   2) run pipeline (fresh -> scrape -> qualify -> prep)
 *   3) follow-up sync for submitted applications
 *   4) status snapshot + prioritized next actions
 *
 * Usage:
 *   job-daily.js
 *   job-daily.js --prep-top 3 --backfill --days 7 --json
 */

import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const opts = {
    preset: "all",
    hours: 6,
    threshold: 70,
    prepTop: 3,
    writeTop: null,
    writeAll: false,
    noWrite: false,
    backfill: false,
    fetch: false,
    skipBeads: false,
    days: 7,
    waitMs: 5000,
    noFresh: false,
    noScrape: false,
    noQualify: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preset" && argv[i + 1]) opts.preset = argv[++i];
    else if (arg === "--hours" && argv[i + 1]) opts.hours = Number(argv[++i]);
    else if (arg === "--threshold" && argv[i + 1]) opts.threshold = Number(argv[++i]);
    else if (arg === "--prep-top" && argv[i + 1]) opts.prepTop = Math.max(0, Number(argv[++i]));
    else if (arg === "--write-top" && argv[i + 1]) opts.writeTop = Math.max(0, Number(argv[++i]));
    else if (arg === "--write-all") opts.writeAll = true;
    else if (arg === "--no-write") opts.noWrite = true;
    else if (arg === "--days" && argv[i + 1]) opts.days = Math.max(1, Number(argv[++i]));
    else if (arg === "--wait-ms" && argv[i + 1]) opts.waitMs = Math.max(0, Number(argv[++i]));
    else if (arg === "--backfill") opts.backfill = true;
    else if (arg === "--fetch") opts.fetch = true;
    else if (arg === "--skip-beads") opts.skipBeads = true;
    else if (arg === "--no-fresh") opts.noFresh = true;
    else if (arg === "--no-scrape") opts.noScrape = true;
    else if (arg === "--no-qualify") opts.noQualify = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
  }

  return opts;
}

function extractJson(raw) {
  const startObj = raw.indexOf("{");
  const startArr = raw.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) throw new Error(`Expected JSON output, got: ${raw.slice(0, 200)}`);
  return JSON.parse(raw.slice(start));
}

function runScriptJson(scriptName, args = []) {
  const scriptPath = path.join(__dirname, scriptName);
  const output = execFileSync("node", [scriptPath, ...args, "--json"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return extractJson(output);
}

function printHelp() {
  console.log("Usage: job-daily.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --preset <name>      job-fresh preset (default: all)");
  console.log("  --hours <n>          freshness hours (default: 6)");
  console.log("  --threshold <n>      qualification threshold (default: 70)");
  console.log("  --prep-top <n>       auto-prep top N newly qualified (default: 3)");
  console.log("  --write-top <n>      auto-write top N pending items (default: same as --prep-top)");
  console.log("  --write-all          auto-write all pending materials");
  console.log("  --no-write           disable automatic draft writing");
  console.log("  --backfill           prep from old qualified backlog if no new ones");
  console.log("  --days <n>           follow-up window for submitted apps (default: 7)");
  console.log("  --fetch              fetch posting body during prep");
  console.log("  --skip-beads         skip beads integration");
  console.log("  --no-fresh           skip fresh step");
  console.log("  --no-scrape          skip scraper step");
  console.log("  --no-qualify         skip qualify step");
  console.log("  --wait-ms <n>        wait between fresh and scrape (default: 5000)");
  console.log("  --json               output JSON summary");
}

function buildNextActions(status, followup) {
  const actions = [];
  const summary = status?.summary || {};

  if ((summary.materialsReady || 0) > 0) {
    actions.push({
      priority: 1,
      command: "/job next",
      reason: `${summary.materialsReady} material-ready item(s) available for final review and submission`,
    });
  }
  if ((summary.pendingMaterials || 0) > 0) {
    actions.push({
      priority: 2,
      command: "/job generate 1",
      reason: `${summary.pendingMaterials} pending materials item(s) waiting for draft generation + review`,
    });
  }
  if ((summary.qualifiedUnprepped || 0) > 0) {
    actions.push({
      priority: 3,
      command: "/job run --backfill",
      reason: `${summary.qualifiedUnprepped} qualified item(s) remain unprepped`,
    });
  }
  if ((followup?.createdCount || 0) > 0) {
    actions.push({
      priority: 4,
      command: "/job beads",
      reason: `${followup.createdCount} follow-up task(s) were auto-created`,
    });
  }

  if (actions.length === 0) {
    actions.push({
      priority: 1,
      command: "/job run",
      reason: "Pipeline is clear; run next discovery cycle",
    });
  }

  return actions;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const migrate = runScriptJson("job-state-migrate.js", []);

  const writeTop = opts.writeTop == null ? opts.prepTop : opts.writeTop;

  const runArgs = [
    "run",
    "--skip-migrate",
    "--preset", String(opts.preset),
    "--hours", String(opts.hours),
    "--threshold", String(opts.threshold),
    "--prep-top", String(opts.prepTop),
    "--write-top", String(opts.noWrite ? 0 : writeTop),
    "--wait-ms", String(opts.waitMs),
  ];
  if (opts.backfill) runArgs.push("--backfill");
  if (opts.fetch) runArgs.push("--fetch");
  if (opts.skipBeads) runArgs.push("--skip-beads");
  if (opts.noFresh) runArgs.push("--no-fresh");
  if (opts.noScrape) runArgs.push("--no-scrape");
  if (opts.noQualify) runArgs.push("--no-qualify");
  if (opts.writeAll && !opts.noWrite) runArgs.push("--write-all-pending");
  if (opts.noWrite) runArgs.push("--no-write");

  const run = runScriptJson("job-run.js", runArgs);

  const followupArgs = ["--days", String(opts.days)];
  if (opts.skipBeads) followupArgs.push("--skip-beads");
  const followup = runScriptJson("job-followup-sync.js", followupArgs);

  const status = runScriptJson("job-run.js", ["status"]);
  const nextActions = buildNextActions(status, followup);

  const result = {
    action: "job_daily",
    options: {
      prepTop: opts.prepTop,
      writeTop: opts.noWrite ? 0 : writeTop,
      writeAll: opts.writeAll,
      noWrite: opts.noWrite,
    },
    migrate,
    run,
    followup,
    status,
    nextActions,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("JOB DAILY COMPLETE");
  console.log(`Listings total: ${status.summary.totalListings}`);
  console.log(`Qualified unprepped: ${status.summary.qualifiedUnprepped}`);
  console.log(`Pending materials: ${status.summary.pendingMaterials}`);
  console.log(`Materials ready: ${status.summary.materialsReady}`);
  console.log(`Submitted applications: ${status.summary.submittedApplications}`);
  console.log(`Auto-prepped this run: ${run.prep.succeeded}/${run.prep.attempted}`);
  console.log(`Auto-written runs: ${run.write.succeededRuns}/${run.write.attemptedRuns}`);
  console.log(`Follow-ups created: ${followup.createdCount}`);
  console.log("");
  console.log("Next actions:");
  for (const action of nextActions) {
    console.log(`  ${action.priority}. ${action.command}  # ${action.reason}`);
  }
}

main();
