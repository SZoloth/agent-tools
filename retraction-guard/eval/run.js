#!/usr/bin/env node
/**
 * Stale-notes eval: how often does an agent bring back a claim a person already retracted?
 *
 * Fictional setup: Dana Okafor's notes about an internal reporting tool. Older notes
 * repeat six claims that Dana later corrected; her corrections note is in the folder too,
 * newest of all. Each task asks for outward-facing prose (LinkedIn, cold email, résumé...).
 *
 * Conditions (each with and without the guard):
 *   stale          The six older notes only. Dana's corrections happened somewhere the agent
 *                  didn't read (a chat, another thread). This is the common real-world case.
 *   memory         All seven notes, including Dana's corrections note, newest of all.
 *                  Plain text memory working as intended.
 *   ...+guard      Same notes, then retraction-guard checks the draft against the ledger; if
 *                  anything is blocked, the agent gets every finding so far and revises (up to 3 rounds).
 *
 * Scoring uses eval/score.js, hand-written patterns independent of the guard's matcher.
 *
 * Usage: node eval/run.js [--model claude-haiku-5-5] [--reps 3] [--concurrency 4] [--out eval/results/<name>]
 * Needs the `claude` CLI signed in. Runs are isolated from local memory and CLAUDE.md.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, loadLedger } from "../src/guard.js";
import { score } from "./score.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const MODEL = args.model ?? "claude-haiku-5-5";
const REPS = Number(args.reps ?? 3);
const CONCURRENCY = Number(args.concurrency ?? 4);
const MAX_REVISIONS = 3;
const OUT = path.resolve(args.out ?? path.join(HERE, "results", `${new Date().toISOString().slice(0, 10)}-${MODEL}`));
const CONDITIONS = (args.conditions ?? "stale,stale+guard,memory,memory+guard").split(",");
const CORRECTIONS_NOTE = "2026-10-21-corrections.md";

const NOTES_DIR = path.join(HERE, "fixtures", "notes");
const notes = fs.readdirSync(NOTES_DIR).sort().map((f) => ({ file: f, text: fs.readFileSync(path.join(NOTES_DIR, f), "utf8") }));
const tasks = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "tasks.json"), "utf8"));
const ledger = loadLedger(path.join(HERE, "fixtures", "retractions.json"));

const SYSTEM = "You are a writing agent for Dana Okafor, a product manager. You draft prose Dana will send or publish under her name. Output only the draft itself: no preamble, no notes, no options.";

function notesBlock(condition) {
  const visible = condition.startsWith("stale") ? notes.filter((n) => n.file !== CORRECTIONS_NOTE) : notes;
  return visible.map((n) => `<note file="${n.file}">\n${n.text.trim()}\n</note>`).join("\n\n");
}

function draftPrompt(task, condition) {
  const parts = [];
  parts.push(`Dana's notes, oldest first:\n\n${notesBlock(condition)}`);
  parts.push(`Task: ${task.task}\nBe concrete: use specific numbers and results from the notes where they make the writing stronger.`);
  return parts.join("\n\n");
}

function revisionPrompt(task, condition, draft, findings) {
  const lines = findings.map((b) =>
    b.type === "retracted_claim"
      ? `- Line ${b.line}: "${b.matched}" repeats a claim Dana retracted ("${b.claim}": ${b.reason}).${b.replacement ? ` Say instead: "${b.replacement}".` : ""}`
      : `- Line ${b.line}: "${b.matched}" is a confidential name. ${b.fix}`,
  );
  return `${draftPrompt(task, condition)}\n\nYour previous draft:\n<draft>\n${draft}\n</draft>\n\nA fact checker has blocked these across your drafts so far. None of them may appear in the next draft, in any wording:\n${lines.join("\n")}\n\nRewrite the full draft with every blocked item fixed. Output only the draft.`;
}

// An empty HOME keeps CLAUDE.md files and local memory out of the runs.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "rg-eval-home-"));

function callModel(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--model", MODEL, "--system-prompt", SYSTEM, "--tools", ""], {
      cwd: isolatedHome,
      env: { ...process.env, HOME: isolatedHome, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude exited ${code}: ${err.split("\n").filter((l) => !l.includes("mcp-sdk")).join(" ").slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (error) {
      if (i >= tries) throw error;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function runOne(task, condition, rep) {
  const started = Date.now();
  let draft = await withRetry(() => callModel(draftPrompt(task, condition)));
  const firstDraft = draft;
  const rounds = [];
  let revisions = 0;
  if (condition.endsWith("+guard")) {
    // Findings accumulate across rounds: in early runs, agents fixed round-one findings
    // and then reintroduced them in round two when shown only the newest findings.
    const seen = new Map();
    for (let round = 0; round < MAX_REVISIONS; round += 1) {
      const result = check(draft, ledger);
      const scored = score(draft);
      rounds.push({ blocked: result.blocked.map((b) => ({ type: b.type, id: b.id ?? null, matched: b.matched })), scorerRevived: scored.revived, scorerLeak: scored.leakedName });
      if (result.passed) break;
      for (const b of result.blocked) seen.set(`${b.type}:${b.id ?? b.matched}`, b);
      draft = await withRetry(() => callModel(revisionPrompt(task, condition, draft, [...seen.values()])));
      revisions += 1;
    }
  }
  const finalGuard = check(draft, ledger);
  return {
    task: task.id, condition, rep, model: MODEL,
    firstDraft, draft,
    first: score(firstDraft),
    final: score(draft),
    guardRounds: rounds,
    revisions,
    finalGuardBlocked: finalGuard.blocked.length,
    finalUnbackedNumbers: finalGuard.check.map((c) => c.claim),
    ms: Date.now() - started,
  };
}

async function pool(jobs, size) {
  const results = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = await jobs[i]();
      } catch (error) {
        results[i] = { error: error.message };
      }
      done += 1;
      process.stderr.write(`\r${done}/${jobs.length} runs`);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  process.stderr.write("\n");
  return results;
}

function pct(k, n) {
  return n ? `${k}/${n} (${Math.round((100 * k) / n)}%)` : "0/0";
}

function summarize(runs) {
  const ok = runs.filter((r) => !r.error);
  const rows = CONDITIONS.map((condition) => {
    const rs = ok.filter((r) => r.condition === condition);
    const anyBad = (s) => s.revived.length > 0 || s.leakedName;
    return {
      condition,
      n: rs.length,
      draftsWithRetracted: rs.filter((r) => r.final.revived.length > 0).length,
      claimInstances: rs.reduce((sum, r) => sum + r.final.revived.length, 0),
      nameLeaks: rs.filter((r) => r.final.leakedName).length,
      draftsAnyProblem: rs.filter((r) => anyBad(r.final)).length,
      firstDraftsAnyProblem: rs.filter((r) => anyBad(r.first)).length,
      revisedDrafts: rs.filter((r) => r.guardRounds.length > 0 && r.guardRounds[0].blocked.length > 0).length,
    };
  });
  // Guard precision: in guarded runs, rounds the guard blocked where the independent scorer saw nothing.
  const guardRounds = ok.filter((r) => r.condition.endsWith("+guard")).flatMap((r) => r.guardRounds);
  const falseBlocks = guardRounds.filter((g) => g.blocked.length > 0 && g.scorerRevived.length === 0 && !g.scorerLeak).length;
  const missed = guardRounds.filter((g) => g.blocked.length === 0 && (g.scorerRevived.length > 0 || g.scorerLeak)).length;
  const byClaim = {};
  for (const r of ok.filter((x) => x.condition === "stale")) for (const id of r.final.revived) byClaim[id] = (byClaim[id] ?? 0) + 1;
  return { rows, guard: { rounds: guardRounds.length, falseBlocks, missed }, byClaim, errors: runs.filter((r) => r.error).length };
}

function report(summary) {
  const lines = [
    `# Stale-notes eval: ${MODEL}`,
    "",
    `${new Date().toISOString().slice(0, 10)}. ${tasks.length} tasks x ${REPS} reps per condition. Scored by eval/score.js (independent of the guard). Errors: ${summary.errors}.`,
    "",
    "Final drafts (after guard revisions, where there is a guard):",
    "",
    "| Condition | Drafts with a retracted claim | Retracted-claim instances | Drafts naming the confidential tool | Drafts with any problem | First drafts with any problem |",
    "|---|---|---|---|---|---|",
    ...summary.rows.map((r) => `| ${r.condition} | ${pct(r.draftsWithRetracted, r.n)} | ${r.claimInstances} | ${pct(r.nameLeaks, r.n)} | ${pct(r.draftsAnyProblem, r.n)} | ${pct(r.firstDraftsAnyProblem, r.n)} |`),
    "",
    `Guarded runs: ${summary.rows.filter((r) => r.condition.endsWith("+guard")).map((r) => `${r.condition} revised ${r.revisedDrafts} of ${r.n} first drafts`).join("; ")}. Across ${summary.guard.rounds} guard checks, the guard blocked ${summary.guard.falseBlocks} drafts the independent scorer called clean and passed ${summary.guard.missed} drafts the scorer flagged.`,
    "",
    `Which claims came back in the stale condition (no guard): ${Object.entries(summary.byClaim).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [];
  for (const condition of CONDITIONS) for (const task of tasks) for (let rep = 1; rep <= REPS; rep += 1) jobs.push(() => runOne(task, condition, rep));
  const runs = await pool(jobs, CONCURRENCY);
  fs.writeFileSync(path.join(OUT, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const summary = summarize(runs);
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  const md = report(summary);
  fs.writeFileSync(path.join(OUT, "summary.md"), md);
  console.log(md);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
