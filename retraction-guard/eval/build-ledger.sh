#!/usr/bin/env bash
# Rebuilds fixtures/retractions.json from Dana's Oct 21 corrections, using the CLI itself.
set -euo pipefail
cd "$(dirname "$0")"
LEDGER=fixtures/retractions.json
rm -f "$LEDGER"
cat > "$LEDGER" <<'JSON'
{
  "version": 1,
  "retractions": [],
  "approved": [
    { "id": "wau-45", "claim": "+45% weekly active analysts, April to September", "source": "notes/2026-09-15-dashboard-pull.md" },
    { "id": "hours-900", "claim": "estimated to save about 900 analyst hours a year", "source": "notes/2026-09-15-dashboard-pull.md" },
    { "id": "no-ticket-58", "claim": "58% of recurring reports built without a data-team ticket in September", "source": "notes/2026-09-15-dashboard-pull.md" },
    { "id": "team-4", "claim": "worked with a team of 4 engineers", "source": "notes/2026-10-21-corrections.md" }
  ],
  "superseded": [],
  "confidential": { "names": ["Bluebird"], "fix": "Say \"an internal reporting tool\"." }
}
JSON
RG="node ../bin/retraction-guard.js"
SRC="Dana, corrections note, 2026-10-21"
$RG retract "launched to 1,000+ analysts" --ledger "$LEDGER" --source "$SRC" \
  --reason "1,000 is total headcount; usage was never counted" --replace "launched to analysts across the company"
$RG retract "report build time dropped from 2 days to 20 minutes" --ledger "$LEDGER" --source "$SRC" \
  --reason "one team's anecdote, never measured" --replace "report builds got much faster (not measured)"
$RG retract "weekly actives grew 3x" --ledger "$LEDGER" --source "$SRC" --terms "weekly,active,usage,adoption,user,analyst" \
  --reason "a one-week spike" --replace "+45% weekly active analysts, April to September"
$RG retract "saved \$250K a year" --ledger "$LEDGER" --source "$SRC" --terms "" \
  --reason "assumes an hourly rate nobody can source" --replace "estimated to save about 900 analyst hours a year"
$RG retract "led a team of 12 engineers" --ledger "$LEDGER" --source "$SRC" --terms "engineer,developer,team,people,report" \
  --reason "worked with 4 engineers and managed none" --replace "worked with a team of 4 engineers"
$RG retract "paused the vendor contracts" --ledger "$LEDGER" --source "$SRC" --terms "paus,vendor" \
  --reason "evaluated two vendors, found eval-suite gaps, expanded the eval suite before buying" \
  --replace "evaluated two vendors, found gaps in our eval suite, and expanded it before buying"
