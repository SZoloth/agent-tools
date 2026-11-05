#!/usr/bin/env node
/**
 * retraction-guard CLI.
 *
 *   retraction-guard check <file|dir|->... [--source <file>]... [--ledger <file>] [--json]
 *   retraction-guard retract "<claim>" --reason "<what the person said>" --source "<where>"
 *                    [--replace "<what to say instead>"] [--terms a,b] [--pattern <regex>] [--by <name>]
 *   retraction-guard list [--json]
 *
 * Ledger: --ledger, else $RETRACTION_GUARD_LEDGER, else ./retractions.json.
 * Exit codes: 0 clean (unsourced numbers alone don't fail), 1 something blocked, 2 usage error.
 */

import fs from "node:fs";
import path from "node:path";
import { check, expandTargets, loadLedger, retract, saveLedger, summarize } from "../src/guard.js";

const USAGE = `Usage:
  retraction-guard check <file|dir|->... [--source <file>]... [--ledger <file>] [--json]
  retraction-guard retract "<claim>" --reason "<text>" --source "<text>" [--replace "<text>"] [--terms a,b] [--pattern <regex>] [--by <name>]
  retraction-guard list [--json]`;

function parse(argv) {
  const args = { command: argv[0], positional: [], sources: [], json: false };
  const valueFlags = new Set(["--ledger", "--reason", "--replace", "--terms", "--pattern", "--by"]);
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--source") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--source needs a value");
      args.sources.push(value);
    } else if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      args[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown flag: ${arg}`);
    else args.positional.push(arg);
  }
  args.ledgerPath = path.resolve(args.ledger ?? process.env.RETRACTION_GUARD_LEDGER ?? "retractions.json");
  return args;
}

function readTarget(file) {
  return file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
}

function runCheck(args) {
  if (!args.positional.length) throw new Error("check needs at least one file, directory or -");
  const ledger = loadLedger(args.ledgerPath);
  const sources = args.sources.map((f) => fs.readFileSync(path.resolve(f), "utf8"));
  const files = expandTargets(args.positional);
  const results = files.map((file) => ({ file, ...check(readTarget(file), ledger, { sources }) }));
  const passed = results.every((r) => r.passed);
  if (args.json) {
    console.log(JSON.stringify(files.length === 1 ? results[0] : { passed, files: results }, null, 2));
  } else {
    for (const r of results) {
      const label = files.length > 1 ? `${r.file}: ` : "";
      if (!r.blocked.length && !r.check.length) {
        if (files.length === 1) console.log("Clean: nothing retracted or confidential, every number is backed.");
        continue;
      }
      for (const b of r.blocked) {
        if (b.type === "retracted_claim") {
          console.log(`${label}BLOCKED line ${b.line}: retracted claim "${b.claim}" (${b.retractedAt}: ${b.reason})${b.replacement ? ` Say instead: ${b.replacement}` : ""}\n    > ${b.matched}`);
        } else {
          console.log(`${label}BLOCKED line ${b.line}: confidential name "${b.matched}". ${b.fix}`);
        }
      }
      for (const c of r.check) console.log(`${label}CHECK line ${c.line}: "${c.claim}" isn't backed by an approved claim or a source. ${c.context}`);
    }
    if (files.length > 1) console.log(`${results.filter((r) => !r.passed).length} of ${files.length} files blocked.`);
  }
  return passed ? 0 : 1;
}

function runRetract(args) {
  const [claim] = args.positional;
  const ledger = loadLedger(args.ledgerPath);
  const { ledger: next, entry, superseded } = retract(ledger, {
    claim,
    reason: args.reason,
    source: args.sources[0],
    by: args.by,
    replacement: args.replace,
    terms: args.terms !== undefined ? args.terms.split(",").map((t) => t.trim()).filter(Boolean) : null,
    pattern: args.pattern,
  });
  saveLedger(args.ledgerPath, next);
  if (args.json) console.log(JSON.stringify({ retracted: entry, superseded }, null, 2));
  else {
    console.log(`Retracted "${entry.claim}" as ${entry.id}. Matches: numbers [${entry.match.numbers.map((n) => n.value).join(", ")}], terms [${entry.match.terms.join(", ")}].`);
    for (const s of superseded) console.log(`Superseded approved claim "${s.claim}" (${s.id}).`);
  }
  return 0;
}

function runList(args) {
  const summary = summarize(loadLedger(args.ledgerPath));
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Retracted (${summary.retractions.length}):`);
    for (const r of summary.retractions) console.log(`  ${r.retractedAt}  ${r.claim}  (${r.reason}; ${r.source})${r.replacement ? `  -> ${r.replacement}` : ""}`);
    console.log(`Approved (${summary.approved.length}):`);
    for (const a of summary.approved) console.log(`  ${a.claim}  (${a.source})`);
    if (summary.superseded.length) console.log(`Superseded (${summary.superseded.length}): ${summary.superseded.map((s) => s.claim).join("; ")}`);
    console.log(`Confidential names: ${summary.confidentialNames}`);
  }
  return 0;
}

function main() {
  let args;
  try {
    args = parse(process.argv.slice(2));
    if (args.command === "--help" || args.command === "-h" || !args.command) {
      console.log(USAGE);
      return args.command ? 0 : 2;
    }
    if (args.command === "check") return runCheck(args);
    if (args.command === "retract") return runRetract(args);
    if (args.command === "list") return runList(args);
    throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
}

process.exitCode = main();
