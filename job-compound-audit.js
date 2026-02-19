#!/usr/bin/env node

/**
 * job-compound-audit.js - Audit launchd job compound reliability.
 *
 * Goals:
 * - Verify scheduler wiring and last-exit state.
 * - Detect "silent success" runs where logs show auth/usage failures
 *   but launchd still reports a successful run.
 * - Verify command contract wiring (e.g. /job loop prompt must exist).
 *
 * Usage:
 *   job-compound-audit.js
 *   job-compound-audit.js --json
 *   job-compound-audit.js --launchctl-file /tmp/launchctl.txt --log-file /tmp/log.txt --job-md /tmp/job.md
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const HOME = process.env.HOME || "/Users/samuelz";

const DEFAULTS = {
  label: "com.claude.job-compound",
  launchctlFile: null,
  logFile: path.join(HOME, ".claude/logs/job-compound.log"),
  jobMdPath: path.join(HOME, ".claude/commands/job.md"),
  plistPath: path.join(HOME, "Library/LaunchAgents/com.claude.job-compound.plist"),
  json: false,
  strictWarn: false,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--label" && argv[i + 1]) opts.label = argv[++i];
    else if (arg === "--launchctl-file" && argv[i + 1]) opts.launchctlFile = argv[++i];
    else if (arg === "--log-file" && argv[i + 1]) opts.logFile = argv[++i];
    else if (arg === "--job-md" && argv[i + 1]) opts.jobMdPath = argv[++i];
    else if (arg === "--plist" && argv[i + 1]) opts.plistPath = argv[++i];
    else if (arg === "--json") opts.json = true;
    else if (arg === "--strict-warn") opts.strictWarn = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp() {
  console.log("Usage: job-compound-audit.js [options]");
  console.log("");
  console.log("Options:");
  console.log("  --label <launchd-label>      launchd label (default: com.claude.job-compound)");
  console.log("  --launchctl-file <path>      use saved launchctl print output instead of invoking launchctl");
  console.log("  --log-file <path>            compound log path");
  console.log("  --job-md <path>              /job command markdown path");
  console.log("  --plist <path>               launchd plist path");
  console.log("  --json                       JSON output");
  console.log("  --strict-warn                exit non-zero for warning status");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function runLaunchctlPrint(label) {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) {
    throw new Error("Cannot determine numeric uid for launchctl query");
  }
  return execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function parseLaunchctl(text) {
  if (!text) return null;
  const state = text.match(/^\s*state = (.+)$/m)?.[1]?.trim() || null;
  const runsRaw = text.match(/^\s*runs = (\d+)$/m)?.[1];
  const lastExitRaw = text.match(/^\s*last exit code = (-?\d+)$/m)?.[1];
  const hourRaw = text.match(/"Hour"\s*=>\s*(\d+)/m)?.[1];
  const minuteRaw = text.match(/"Minute"\s*=>\s*(\d+)/m)?.[1];
  const isLoaded = text.includes("gui/") && text.includes("LaunchAgent");
  const prompt = text.match(/if claude -p[^\n]+/)?.[0] || null;
  const model = prompt?.match(/--model\s+([a-z0-9._-]+)/i)?.[1] || null;
  const fallbackModel = prompt?.match(/--fallback-model\s+([a-z0-9._-]+)/i)?.[1] || null;

  return {
    isLoaded,
    state,
    runs: runsRaw == null ? null : Number(runsRaw),
    lastExitCode: lastExitRaw == null ? null : Number(lastExitRaw),
    schedule: {
      hour: hourRaw == null ? null : Number(hourRaw),
      minute: minuteRaw == null ? null : Number(minuteRaw),
    },
    phase3Prompt: prompt,
    model,
    fallbackModel,
  };
}

function hasJobLoopDefinition(jobMdText) {
  if (!jobMdText) return false;
  return /When user runs [`'"]?\/job loop[`'"]?:/i.test(jobMdText) ||
    /Parse the argument after \/job:[\s\S]*\bloop\b/i.test(jobMdText);
}

function parseCompoundLog(logText) {
  if (!logText) return [];
  const lines = logText.split(/\r?\n/);
  const runs = [];
  let current = null;

  const ensureRun = (timestamp, inferred = false) => {
    if (!current) {
      current = {
        startedAt: timestamp || null,
        completedAt: null,
        phases: {
          phase1AtsDiscovery: { started: false, failed: false },
          phase2CmfScoring: { started: false, failed: false },
          phase3CompoundLoop: { started: false, failed: false, degraded: false },
        },
        runtimeAlerts: [],
        boardFetch: null,
        inferred,
      };
    }
  };

  const closeRun = () => {
    if (current) {
      runs.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const ts = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - (.+)$/);
    if (ts) {
      const timestamp = ts[1];
      const msg = ts[2];

      if (msg.includes("Job compound loop starting")) {
        closeRun();
        ensureRun(timestamp);
        continue;
      }

      ensureRun(timestamp, true);

      if (msg.includes("Phase 1: ATS Discovery")) current.phases.phase1AtsDiscovery.started = true;
      if (msg.includes("Phase 2: CMF Scoring")) current.phases.phase2CmfScoring.started = true;
      if (msg.includes("Phase 3: Compound Loop")) current.phases.phase3CompoundLoop.started = true;
      if (msg.includes("WARN: Phase 3 degraded")) current.phases.phase3CompoundLoop.degraded = true;

      const failMatch = msg.match(/ERROR: (Phase [123]: [^(]+) failed \(exit=(\d+)\)/);
      if (failMatch) {
        const phase = failMatch[1];
        const exitCode = Number(failMatch[2]);
        if (phase.includes("Phase 1")) current.phases.phase1AtsDiscovery.failed = true;
        if (phase.includes("Phase 2")) current.phases.phase2CmfScoring.failed = true;
        if (phase.includes("Phase 3")) current.phases.phase3CompoundLoop.failed = true;
        current.runtimeAlerts.push({ type: "phase_failure", phase, exitCode, line });
      }

      if (msg.includes("Job compound loop completed")) {
        current.completedAt = timestamp;
        closeRun();
      }
      continue;
    }

    if (!current) continue;

    const boardFetchMatch = line.match(/Boards fetched:\s*(\d+)\/(\d+)/i);
    if (boardFetchMatch) {
      current.boardFetch = {
        successful: Number(boardFetchMatch[1]),
        total: Number(boardFetchMatch[2]),
      };
    }

    if (/OAuth token has expired|Failed to authenticate/i.test(line)) {
      current.runtimeAlerts.push({ type: "auth_error", line: line.slice(0, 240) });
    }
    if (/out of extra usage/i.test(line)) {
      current.runtimeAlerts.push({ type: "usage_limit", line: line.slice(0, 240) });
    }
  }

  closeRun();
  return runs;
}

function makeIssue(severity, id, message, evidence = null) {
  return { severity, id, message, evidence };
}

function evaluateAudit({ launchctlInfo, runs, jobLoopDefined, promptUsesJobLoop }) {
  const issues = [];
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;

  if (!launchctlInfo) {
    issues.push(makeIssue("critical", "launchctl_unavailable", "launchd status could not be read"));
  } else {
    if (!launchctlInfo.isLoaded) {
      issues.push(makeIssue("critical", "launchd_not_loaded", "launch agent does not appear loaded"));
    }
    if (launchctlInfo.runs === 0) {
      issues.push(makeIssue("warning", "never_ran", "launch agent has not recorded any runs yet"));
    }
    if (launchctlInfo.lastExitCode != null && launchctlInfo.lastExitCode !== 0) {
      issues.push(
        makeIssue(
          "warning",
          "last_exit_nonzero",
          `last run exited non-zero (${launchctlInfo.lastExitCode})`
        )
      );
    }
  }

  if (promptUsesJobLoop && !jobLoopDefined) {
    issues.push(
      makeIssue(
        "critical",
        "loop_command_missing",
        "phase 3 prompt calls /job loop, but /job loop is not defined in the command doc"
      )
    );
  }

  if (!latestRun) {
    issues.push(makeIssue("warning", "no_runs_in_log", "compound log has no parseable runs"));
  } else {
    const authErrorSeen = latestRun.runtimeAlerts.some((alert) => alert.type === "auth_error");
    const usageLimitSeen = latestRun.runtimeAlerts.some((alert) => alert.type === "usage_limit");
    const phase3Failed = latestRun.phases.phase3CompoundLoop.failed;
    const phase3Degraded = latestRun.phases.phase3CompoundLoop.degraded;
    const completed = Boolean(latestRun.completedAt);

    if (authErrorSeen && completed && !phase3Failed) {
      issues.push(
        makeIssue(
          "critical",
          "silent_phase3_auth_error",
          "phase 3 log contains auth failure text but run still completed",
          latestRun.runtimeAlerts.filter((alert) => alert.type === "auth_error")[0]
        )
      );
    }

    if (usageLimitSeen && completed && !phase3Failed && !phase3Degraded) {
      issues.push(
        makeIssue(
          "warning",
          "silent_phase3_usage_limit",
          "phase 3 log contains usage-limit text but no degraded/failure marker was emitted"
        )
      );
    }

    if (latestRun.boardFetch?.total > 0) {
      const ratio = latestRun.boardFetch.successful / latestRun.boardFetch.total;
      if (ratio < 0.35) {
        issues.push(
          makeIssue(
            "warning",
            "ats_success_ratio_low",
            `ATS board success ratio is low (${latestRun.boardFetch.successful}/${latestRun.boardFetch.total})`,
            { ratio }
          )
        );
      }
    }
  }

  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const status = criticalCount > 0 ? "fail" : warningCount > 0 ? "warn" : "ok";
  return { status, issues, latestRun };
}

function renderText(report) {
  console.log("JOB COMPOUND AUDIT");
  console.log(`Status: ${report.status.toUpperCase()}`);
  console.log(`Launchd loaded: ${report.launchd?.isLoaded ? "yes" : "no"}`);
  console.log(`Last exit code: ${report.launchd?.lastExitCode ?? "unknown"}`);
  console.log(`Model routing: ${report.launchd?.model || "?"} -> ${report.launchd?.fallbackModel || "?"}`);
  console.log(`Scheduled: ${report.launchd?.schedule?.hour ?? "?"}:${String(report.launchd?.schedule?.minute ?? "?").padStart(2, "0")}`);
  console.log(`Runs parsed from log: ${report.runsParsed}`);
  console.log(`Job loop definition present: ${report.jobLoopDefined ? "yes" : "no"}`);

  if (report.issues.length === 0) {
    console.log("No issues detected.");
    return;
  }

  console.log("");
  console.log("Issues:");
  for (const issue of report.issues) {
    console.log(`- [${issue.severity}] ${issue.id}: ${issue.message}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const launchctlText = opts.launchctlFile
    ? readText(opts.launchctlFile)
    : (() => {
        try {
          return runLaunchctlPrint(opts.label);
        } catch (err) {
          return `ERROR: ${err.message}`;
        }
      })();
  const launchctlInfo = parseLaunchctl(launchctlText);

  const logText = readText(opts.logFile);
  const jobMdText = readText(opts.jobMdPath);
  const runs = parseCompoundLog(logText);
  const promptUsesJobLoop = Boolean(launchctlInfo?.phase3Prompt?.includes("/job loop"));
  const jobLoopDefined = hasJobLoopDefinition(jobMdText);

  const audit = evaluateAudit({
    launchctlInfo,
    runs,
    jobLoopDefined,
    promptUsesJobLoop,
  });

  const report = {
    timestamp: new Date().toISOString(),
    status: audit.status,
    paths: {
      logFile: opts.logFile,
      jobMdPath: opts.jobMdPath,
      plistPath: opts.plistPath,
      launchctlFile: opts.launchctlFile,
    },
    launchd: launchctlInfo,
    runsParsed: runs.length,
    latestRun: audit.latestRun,
    promptUsesJobLoop,
    jobLoopDefined,
    issues: audit.issues,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderText(report);
  }

  if (report.status === "fail") {
    process.exit(1);
  }
  if (report.status === "warn" && opts.strictWarn) {
    process.exit(2);
  }
}

main();
