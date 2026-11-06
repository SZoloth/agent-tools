/**
 * Retraction guard: once a person corrects a claim, no later agent can bring it back.
 *
 * The ledger (retractions.json) holds three lists:
 *   retractions   Claims a person said are wrong. Always blocked, even when a
 *                 note or source file still repeats them. Retractions beat sources.
 *   approved      Claims a person confirmed, with where the proof lives.
 *   confidential  Names that must never appear in outgoing prose.
 *
 * check() returns two kinds of finding:
 *   blocked  a retracted claim or a confidential name. Cut it before the text ships.
 *   check    a number not backed by an approved claim or a --source file. Trace it or cut it.
 */

import fs from "node:fs";
import path from "node:path";
import { claimNumbers, findNumbers, sameNumber } from "./numbers.js";

export const LEDGER_VERSION = 1;

const STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have he her his i in into is it its of on or our " +
    "she so than that the their them they this to up us was we were what when which who will with you your " +
    "more over about around nearly almost roughly approximately across per each every all some most than " +
    "used use using built made make than just only also like").split(" "),
);
// Units travel with numbers ("20 minutes", "two weeks"), so they say nothing about which claim a sentence makes.
const UNIT_WORDS = new Set(
  "second seconds minute minutes min mins hour hours hr hrs day days week weeks month months quarter quarters year years percent times".split(" "),
);

export function emptyLedger() {
  return { version: LEDGER_VERSION, retractions: [], approved: [], superseded: [], confidential: { names: [], fix: "" } };
}

export function loadLedger(file) {
  if (!fs.existsSync(file)) return emptyLedger();
  const ledger = { ...emptyLedger(), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  ledger.confidential = { names: [], fix: "", ...ledger.confidential };
  return ledger;
}

export function saveLedger(file, ledger) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Crude stem: lowercase, drop common endings. Good enough to match analyst/analysts, migrate/migrated. */
export function stem(word) {
  const w = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (const ending of ["ations", "ation", "ings", "ing", "ies", "ed", "es", "s"]) {
    if (w.length - ending.length >= 4 && w.endsWith(ending)) return w.slice(0, -ending.length);
  }
  return w;
}

/** Content words of a claim, minus stopwords, number words and the numbers themselves. */
export function keyTerms(claim) {
  const withoutNumbers = claim.replace(/[$£€]?\d[\d,.]*[kmb]?\+?%?/giu, " ");
  const numberWords = new Set(findNumbers(claim).filter((n) => n.word).flatMap((n) => n.raw.toLowerCase().split(/[\s-]+/u)));
  const terms = [];
  for (const word of withoutNumbers.split(/[^\p{L}\p{N}'-]+/u)) {
    const lower = word.toLowerCase();
    if (lower.length < 3 || STOPWORDS.has(lower) || UNIT_WORDS.has(lower) || numberWords.has(lower)) continue;
    const s = stem(lower);
    if (!terms.includes(s)) terms.push(s);
  }
  return terms;
}

/**
 * How a retraction recognizes its claim in new text, however it's reworded.
 * With numbers: every number (by value) plus at least one key term, in one sentence.
 * Pass terms: [] to match on the numbers alone (useful for distinctive money figures).
 * Without numbers: every key term in one sentence.
 */
export function matchSpecFor(claim, terms) {
  const numbers = findNumbers(claim).map(({ value, kind }) => ({ value, kind }));
  return { numbers, terms: Array.isArray(terms) ? terms.map(stem).filter(Boolean) : keyTerms(claim) };
}

/** Split into sentences, keeping each one's start offset so findings can report a line. */
export function sentences(text) {
  // A sentence ends at a newline, or at . ! ? followed by whitespace or the end,
  // so "1.5x" and "$1.2M" stay whole.
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const ch = text[i];
    const end = i === text.length || ch === "\n" || (/[.!?]/u.test(ch) && (i + 1 === text.length || /\s/u.test(text[i + 1])));
    if (end) {
      const body = text.slice(start, i + 1);
      if (body.trim()) out.push({ text: body, index: start + (body.length - body.trimStart().length) });
      start = i + 1;
    }
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function sentenceMatches(sentenceText, spec) {
  const words = sentenceText.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem);
  const hasTerm = (term) => words.some((w) => w === term || (term.length >= 4 && w.startsWith(term)));
  if (spec.numbers.length) {
    const present = findNumbers(sentenceText);
    const allNumbers = spec.numbers.every((n) => present.some((p) => sameNumber(n, p)));
    return allNumbers && (spec.terms.length === 0 || spec.terms.some(hasTerm));
  }
  return spec.terms.length > 0 && spec.terms.every(hasTerm);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Values found in source files or approved claims count as backed, in any spelling. */
function backedNumbers(ledger, sourceTexts) {
  const backed = [];
  for (const entry of ledger.approved ?? []) backed.push(...findNumbers(entry.claim));
  for (const text of sourceTexts) backed.push(...findNumbers(text));
  return backed;
}

/**
 * Check `text` against the ledger. `sources` are texts (posting, research, thread)
 * whose numbers count as backed. Retracted claims are blocked even if a source repeats them.
 */
export function check(text, ledger, { sources = [] } = {}) {
  const blocked = [];
  const sentenceList = sentences(text);
  for (const retraction of ledger.retractions ?? []) {
    const spec = retraction.match ?? matchSpecFor(retraction.claim);
    const custom = retraction.pattern ? new RegExp(retraction.pattern, "iu") : null;
    for (const s of sentenceList) {
      if (custom ? custom.test(s.text) : sentenceMatches(s.text, spec)) {
        blocked.push({
          type: "retracted_claim",
          id: retraction.id,
          line: lineOf(text, s.index),
          matched: s.text.trim(),
          claim: retraction.claim,
          reason: retraction.reason,
          replacement: retraction.replacement ?? null,
          retractedAt: retraction.retractedAt,
        });
      }
    }
  }
  const confidential = ledger.confidential ?? { names: [] };
  for (const name of confidential.names ?? []) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "gu");
    for (const match of text.matchAll(re)) {
      blocked.push({ type: "confidential_name", line: lineOf(text, match.index), matched: match[0], fix: confidential.fix || "Remove or genericize it." });
    }
  }
  blocked.sort((a, b) => a.line - b.line);

  const blockedLines = new Set(blocked.filter((b) => b.type === "retracted_claim").map((b) => b.line));
  const backed = backedNumbers(ledger, sources);
  const checkList = [];
  for (const n of claimNumbers(text)) {
    const line = lineOf(text, n.index);
    if (blockedLines.has(line)) continue;
    if (backed.some((b) => sameNumber(n, b))) continue;
    const lineText = text.split("\n")[line - 1] ?? "";
    checkList.push({ type: "unsourced_number", claim: n.raw, line, context: lineText.trim().slice(0, 160) });
  }
  return { passed: blocked.length === 0, blocked, check: checkList };
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "claim";
}

/**
 * Record a person's correction. The claim becomes a block rule, and any approved
 * claim it contradicts moves to `superseded` with a pointer to the retraction,
 * so the old confirmation can't keep vouching for it.
 */
export function retract(ledger, { claim, reason, source, by = "human", replacement = null, terms = null, pattern = null, now = new Date() }) {
  if (!claim?.trim()) throw new Error("retract needs the claim being corrected");
  if (!reason?.trim()) throw new Error("retract needs a reason (what the person said)");
  if (!source?.trim()) throw new Error("retract needs a source (where the correction came from)");
  if (pattern) new RegExp(pattern, "iu");
  let id = slug(claim);
  const taken = new Set((ledger.retractions ?? []).map((r) => r.id));
  for (let n = 2; taken.has(id); n += 1) id = `${slug(claim)}-${n}`;
  const entry = {
    id,
    claim: claim.trim(),
    match: matchSpecFor(claim, terms),
    ...(pattern ? { pattern } : {}),
    reason: reason.trim(),
    source: source.trim(),
    retractedBy: by,
    retractedAt: now.toISOString().slice(0, 10),
    ...(replacement ? { replacement: replacement.trim() } : {}),
  };
  const next = { ...emptyLedger(), ...ledger, retractions: [...(ledger.retractions ?? []), entry] };
  const keep = [];
  const superseded = [...(ledger.superseded ?? [])];
  for (const approved of ledger.approved ?? []) {
    const hit = pattern ? new RegExp(pattern, "iu").test(approved.claim) : sentenceMatches(approved.claim, entry.match);
    if (hit) superseded.push({ ...approved, supersededBy: id, supersededAt: entry.retractedAt });
    else keep.push(approved);
  }
  next.approved = keep;
  next.superseded = superseded;
  return { ledger: next, entry, superseded: superseded.filter((s) => s.supersededBy === id) };
}

/** Files to scan: plain files as given, directories walked for text-like files. */
export function expandTargets(targets) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(md|markdown|txt|json|ya?ml|html?)$/iu.test(name)) out.push(full);
    }
  };
  for (const target of targets) {
    if (target === "-") out.push("-");
    else if (fs.statSync(target).isDirectory()) walk(target);
    else out.push(target);
  }
  return out;
}

export function summarize(ledger) {
  return {
    retractions: (ledger.retractions ?? []).map(({ id, claim, reason, source, retractedAt, replacement }) => ({ id, claim, reason, source, retractedAt, replacement: replacement ?? null })),
    approved: (ledger.approved ?? []).map(({ id, claim, source }) => ({ id, claim, source })),
    superseded: (ledger.superseded ?? []).map(({ id, claim, supersededBy }) => ({ id, claim, supersededBy })),
    confidentialNames: (ledger.confidential?.names ?? []).length,
  };
}
