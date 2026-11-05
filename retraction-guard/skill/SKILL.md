---
name: retraction-guard
description: Check any prose before a person sees it for claims a person already retracted, confidential names and unbacked numbers, and record every correction a person makes so no later agent repeats it.
---

# Retraction guard

Notes go stale. A person corrects a number on Tuesday, and on Friday an agent reads an older note and puts the number back. This skill stops that.

The ledger is `retractions.json` (or `$RETRACTION_GUARD_LEDGER`). It holds retracted claims, approved claims with where their proof lives, and confidential names. A retraction beats every note and source, because the correction is newer than the note.

## When a person corrects a fact

Record it before doing anything else, in the person's words:

```bash
retraction-guard retract "used by 1,000+ analysts" \
  --reason "That was company headcount, not users" \
  --source "Dana, chat, 2026-11-04" \
  --replace "used by analysts across the company"
```

Retract the shortest phrase that is wrong ("shipped in four months"), not the whole sentence it sat in, and one retraction per wrong fact. Only record corrections a person made. Never retract a claim on your own judgment, and never remove a retraction.

## Before any prose leaves your hands

Emails, posts, bios, résumés, reports, summaries: check them.

```bash
retraction-guard check draft.md --source job-post.md
```

- `BLOCKED` is a retracted claim or a confidential name. Cut it, or use the "Say instead" wording. Then check again.
- `CHECK` is a number with no approved claim or source behind it. Trace it to a source, ask the person, or cut it. Don't hand over a draft with an untraced number without saying so.
- Exit code 1 means something is blocked. Don't ship until it's 0.

## Cleaning up stale notes

Point the checker at a notes folder to find every file that still repeats a retracted claim:

```bash
retraction-guard check notes/
```

Fix those notes, or mark them superseded, so the next agent doesn't read them as current.

## MCP

The same three operations are available as MCP tools (`check_draft`, `retract_claim`, `list_sources`) from `bin/mcp-server.js`. Call `list_sources` before drafting anything with numbers in it.
