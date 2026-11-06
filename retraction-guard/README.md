# retraction-guard

Retraction memory for agents. Once a person corrects a claim, no later agent can bring it back.

Agents keep what they know in text: notes, wikis, skill files. Notes go stale. A person says "that number is wrong" on Tuesday, in a chat one agent saw, and on Friday a different agent reads an older note and puts the number back in a résumé. Telling agents to "check your sources" doesn't help, because the stale note IS the source.

retraction-guard makes the correction a rule instead of a note:

- **Retract.** A person's correction becomes a block rule with their reason, where it came from, the date, and what to say instead. If an earlier approval vouched for the claim, the approval is marked superseded.
- **Check.** Before prose leaves an agent's hands, the guard blocks any retracted claim however it's reworded ("1,000+", "1k", "over a thousand" all match), blocks confidential names, and lists numbers nothing backs. Retractions beat sources: a stale note repeating the claim doesn't rescue it.
- **Scan.** Point it at a notes folder to find every file still carrying a retracted claim.

It runs as a CLI, an MCP server and an Agent Skill. No dependencies; Node 20+.

## Use it

```bash
# A person corrects a fact
retraction-guard retract "launched to 1,000+ analysts" \
  --reason "1,000 is total headcount; usage was never counted" \
  --source "Dana, chat, 2026-10-21" \
  --replace "launched to analysts across the company"

# Before anything ships
retraction-guard check draft.md --source job-post.md     # exit 1 if blocked

# Find stale notes
retraction-guard check notes/

retraction-guard list
```

Ledger: `--ledger`, else `$RETRACTION_GUARD_LEDGER`, else `./retractions.json`. See `eval/fixtures/retractions.json` for the format.

### MCP

```bash
claude mcp add retraction-guard -e RETRACTION_GUARD_LEDGER=/abs/path/retractions.json -- node /abs/path/retraction-guard/bin/mcp-server.js
```

Tools: `check_draft`, `retract_claim`, `list_sources`. `eval/results/2026-11-05-mcp-smoke.md` shows a real agent loop using them.

### Agent Skill

Copy `skill/` into your skills folder (for Claude Code, `~/.claude/skills/retraction-guard/`) and put `bin/` on your PATH.

## How matching works

A retraction stores a match spec next to the claim:

- **With numbers:** every number, by value, plus at least one key term, in the same sentence. "launched to 1,000+ analysts" matches "over a thousand analysts relied on it" but not "1k customers".
- **Without numbers:** every key term in one sentence. "paused the vendor contracts" matches "we paused both vendor contracts".
- `--terms` overrides the key terms; `--terms ""` matches on the number alone (good for a distinctive figure like $250K); `--pattern` takes a regex.

Retract the shortest wrong phrase, one fact per retraction. Retracting a whole sentence makes the match require every number in it.

Known limits: it can't tell "we did NOT pause the vendor contracts" from the claim itself, so a correct negation gets blocked; matching is per sentence, so a claim split across two sentences passes; bare 1900–2100 reads as a year and isn't checked.

## Eval

`eval/` measures how often an agent brings a retracted claim back, with and without the guard. Fictional setup: Dana Okafor's notes about an internal reporting tool. Six older notes repeat six claims Dana later corrected, plus a confidential project name. Six tasks ask for outward-facing prose (LinkedIn About, cold email, résumé bullets, speaker bio, X post, cover letter paragraph), each told to use concrete numbers.

Two memory conditions, each with and without the guard:

- **stale:** the agent sees the six older notes only. The correction happened somewhere it didn't read, which is how it usually goes.
- **memory:** the agent also sees Dana's corrections note, the newest file. Text memory working as intended.
- **+guard:** the draft is checked against the ledger; the agent revises on any block, up to three rounds, seeing every finding so far.

Scoring uses `eval/score.js`, hand-written patterns kept separate from the guard's matcher, so the guard doesn't grade itself.

```bash
node eval/run.js --model claude-haiku-5-5 --reps 3
```

### Results (2026-11-05)

18 drafts per cell (6 tasks x 3 reps). Share of final drafts that contain a retracted claim or the confidential name:

| Condition | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| stale | 18/18 (100%) | 17/18 (94%) |
| stale + guard | 0/18 (0%) | 1/18 (6%) |
| memory | 0/18 (0%) | 0/18 (0%) |
| memory + guard | 0/18 (0%) | 0/18 (0%) |

What this says:

- **Text memory works when the correction is in the context window.** With Dana's corrections note present, neither model repeated a retracted claim. The guard added nothing there and, after the fixes below, blocked nothing.
- **When the correction lives somewhere the agent didn't read, nearly every draft is wrong.** Haiku averaged 2.6 retracted claims per draft, Sonnet 1.8. "1,000+ analysts" and "2 days to 20 minutes" came back most.
- **The guard closes most of that gap.** No guarded draft needed more than two revision rounds (average 1.2 on Haiku, 0.9 on Sonnet). Sonnet's one miss was "weekly active analysts tripled": the matcher didn't read "tripled" as 3x. That's fixed now, with that sentence as a regression test, but the row above reports the run as it happened.

Run 1 on Haiku (`results/2026-11-05-claude-haiku-5-5-v1/`) found two bugs, both fixed before the runs above:

1. **False block.** "Would you have 20 minutes for a call in the next two weeks?" matched the retracted "2 days to 20 minutes", because "minutes" counted as a key term. Unit words no longer identify a claim.
2. **Revisions undid earlier fixes.** Shown only the newest findings, the agent fixed round one's problems and brought them back in round two, so 3 of 18 drafts still failed after two rounds. Findings now accumulate across rounds, with up to three rounds. In other words, corrections have to persist even inside one revision loop.

Limits of this eval: one fictional person, six retractions, six tasks, two models, and I wrote both the fixtures and the scorer. The scorer's patterns are separate from the guard's matcher, but the same person wrote both, so read it as a working demonstration, not a benchmark. One more observation: agents paste the "say instead" text word for word ("report builds got much faster (not measured)"), so write replacements as publishable prose.

## Tests

```bash
node --test test/*.test.js
```

## Credit

The unsourced-number check is adapted from Dossier's fact guard (github.com/AienTech/dossier, `src/lib/ai/fact-guard.ts`). The retraction ledger, supersession and reworded-claim matching are new here.

## License

Not chosen yet. Pick one before publishing.
