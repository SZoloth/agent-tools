import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { check, emptyLedger, keyTerms, retract } from "../src/guard.js";
import { claimNumbers, findNumbers } from "../src/numbers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "bin", "retraction-guard.js");

function ledgerWith(...corrections) {
  let ledger = emptyLedger();
  for (const c of corrections) ledger = retract(ledger, { source: "test", reason: "test", ...c }).ledger;
  return ledger;
}

test("every spelling of a number normalizes to one value", () => {
  for (const text of ["1,000+ users", "1000 users", "1k users", "a thousand users", "one thousand users"]) {
    assert.equal(findNumbers(text)[0].value, 1000, text);
  }
  assert.equal(findNumbers("$30K saved")[0].value, 30000);
  assert.equal(findNumbers("$1.2M ARR")[0].value, 1200000);
  assert.equal(findNumbers("a 3x lift")[0].kind, "multiplier");
  assert.equal(findNumbers("grew 63%")[0].kind, "percent");
});

test("a retracted claim is blocked however the agent rewords it", () => {
  const ledger = ledgerWith({ claim: "used by 1,000+ analysts", replacement: "used by analysts across the company" });
  for (const draft of [
    "The tool was used by 1,000+ analysts.",
    "Over a thousand analysts relied on it.",
    "It reached 1k analysts in a year.",
    "Analyst adoption hit 1000 seats.",
  ]) {
    const result = check(draft, ledger);
    assert.equal(result.passed, false, draft);
    assert.equal(result.blocked[0].replacement, "used by analysts across the company");
  }
  assert.equal(check("It reached 1k customers.", ledger).blocked.length, 0, "same number, different subject passes");
});

test("unit words don't identify a claim, so a meeting request isn't a retracted time saving", () => {
  const ledger = ledgerWith({ claim: "report build time dropped from 2 days to 20 minutes" });
  assert.equal(check("Would you have 20 minutes for a call in the next two weeks?", ledger).passed, true);
  assert.equal(check("Report builds went from two days to 20 minutes.", ledger).passed, false);
});

test("multipliers written as words match a retracted 3x (a miss found in the Sonnet eval run)", () => {
  const ledger = ledgerWith({ claim: "weekly actives grew 3x", terms: ["weekly", "active", "analyst"] });
  const missed = "Weekly active analysts tripled in the first month and are up 45% from April to September.";
  assert.equal(check(missed, ledger).passed, false);
  assert.equal(check("Weekly actives grew threefold.", ledger).passed, false);
  assert.equal(check("Weekly actives doubled.", ledger).passed, true, "2x isn't the retracted 3x");
});

test("a claim without numbers is blocked when all its key terms share a sentence", () => {
  const ledger = ledgerWith({ claim: "we paused the vendor contracts" });
  assert.deepEqual(keyTerms("we paused the vendor contracts"), ["paus", "vendor", "contract"]);
  assert.equal(check("In March we paused both vendor contracts.", ledger).passed, false);
  assert.equal(check("We renewed the vendor contracts.", ledger).passed, true);
});

test("retractions beat sources: a stale note repeating the claim doesn't back it", () => {
  const ledger = ledgerWith({ claim: "cut onboarding from 3 weeks to 2 days" });
  const staleNote = "Q2 notes: we cut onboarding from 3 weeks to 2 days.";
  const result = check("I cut onboarding from 3 weeks to 2 days.", ledger, { sources: [staleNote] });
  assert.equal(result.passed, false);
  assert.equal(result.check.length, 0, "a blocked line isn't listed again as unsourced");
});

test("retracting supersedes an earlier approval of the same claim", () => {
  const ledger = { ...emptyLedger(), approved: [{ id: "reach", claim: "reached 1,000+ analysts", source: "Oct review" }] };
  const { ledger: next, superseded } = retract(ledger, { claim: "1,000+ analysts", reason: "That was headcount, not users", source: "Nov 4 call" });
  assert.equal(next.approved.length, 0);
  assert.equal(superseded[0].supersededBy, next.retractions[0].id);
  assert.equal(check("We reached 1,000 analysts.", next).passed, false);
});

test("unsourced numbers are listed to check; sources and approvals back them in any spelling", () => {
  const draft = "Your team serves 40,000 customers and grew 63% last year.";
  const bare = check(draft, emptyLedger());
  assert.equal(bare.passed, true, "unsourced numbers alone don't fail");
  assert.deepEqual(bare.check.map((c) => c.claim), ["40,000", "63%"]);
  assert.deepEqual(check(draft, emptyLedger(), { sources: ["We now serve 40k customers, up 63%."] }).check, []);
});

test("years, dates, times and small counts aren't flagged as claims", () => {
  assert.deepEqual(claimNumbers("On Nov 4, 2026 at 3pm we met 2 people about Q3 and the 5th draft."), []);
});

test("confidential names are blocked as whole, case-sensitive words", () => {
  const ledger = { ...emptyLedger(), confidential: { names: ["Bluebird"], fix: "Say 'an internal search tool'." } };
  assert.equal(check("I led Bluebird.", ledger).blocked[0].type, "confidential_name");
  assert.equal(check("A bluebird sang. Bluebirdish is fine.", ledger).passed, true);
});

test("the CLI retracts, lists, checks stdin and exits 1 only on a block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rg-"));
  const ledgerPath = path.join(dir, "retractions.json");
  const run = (args, input) => execFileSync(process.execPath, [cli, ...args, "--ledger", ledgerPath], { input, encoding: "utf8" });
  run(["retract", "saved 500 hours", "--reason", "No source", "--source", "Nov 4 review", "--replace", "estimated savings, unsized"]);
  assert.match(run(["list"]), /saved 500 hours/);
  assert.equal(JSON.parse(run(["check", "-", "--json"], "Happy to find a time.")).passed, true);
  assert.throws(
    () => run(["check", "-"], "We saved 500 hours a quarter."),
    (error) => error.status === 1 && /BLOCKED line 1: retracted claim/.test(error.stdout) && /Say instead/.test(error.stdout),
  );
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(path.join(dir, "notes", "old.md"), "Old win: saved 500 hours.\n");
  fs.writeFileSync(path.join(dir, "notes", "new.md"), "Savings are estimated, not sized.\n");
  assert.throws(() => run(["check", path.join(dir, "notes")]), (error) => error.status === 1 && /old\.md: BLOCKED/.test(error.stdout) && /1 of 2 files blocked/.test(error.stdout));
});
