# Napkin

## Corrections
| Date | Source | What Went Wrong | What To Do Instead |
|------|--------|----------------|-------------------|
| 2026-02-07 | user | Defaults did not match desired CMF pass threshold | Use score threshold **70** as baseline unless user overrides |
| 2026-02-07 | self | Pipeline state transitions were inconsistent across scripts/docs | Standardize lifecycle: `pending_materials -> materials_ready -> submitted_applications` |
| 2026-02-07 | self | Early dry-run implementation still mutated notes/beads in helper scripts | Keep dry-run fully side-effect free: no file writes, no beads commands |
| 2026-02-07 | user | Too many commands required for daily job workflow | Provide one-command orchestrators that chain fresh -> scrape -> qualify -> prep |
| 2026-02-07 | self | Mixed stdout logs broke JSON automation parsing | Every orchestration-facing script must provide deterministic `--json` output |

## User Preferences
- Maximize automation across the /job system.
- Keep manual checkpoints only for explicit human review steps.
- Prefer complete end-to-end fixes over partial guidance.

## Patterns That Work
- Implement lifecycle transitions in scripts first, then align command docs to the same flow.
- Use isolated temporary HOME-based integration tests for job pipeline scripts.
- Keep beads IDs persisted in both cache metadata and pipeline entries for reliable follow-up automation.
- Default auto-prep should target newly qualified jobs only; require explicit backfill for old queue.
- Run state normalization before orchestration to keep legacy statuses from breaking queue logic.

## Patterns That Don't Work
- Manual beads handoffs in command docs when scripts can own issue creation/comment/close.
- Relative paths or quoted-tilde pathing in commands under spaces-containing directories.

## Domain Notes
- /job command behavior is orchestrated by docs in `~/.claude/commands/job.md` and execution scripts in `~/agent-tools`.
- Application artifacts live under `~/Documents/LLM CONTEXT/1 - personal/job_search/Applications`.
