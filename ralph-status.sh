#!/bin/bash

# Ralph Loop Status
# Shows current state of Ralph loop

set -euo pipefail

if [[ ! -f ".ralph/state.json" ]]; then
  echo "No Ralph loop in this directory"
  exit 0
fi

echo "Ralph Loop Status"
echo "════════════════════════════════════════════════════════════"
echo ""

# Parse state
ITERATION=$(grep '"iteration"' .ralph/state.json | grep -o '[0-9]*')
STATUS=$(grep '"status"' .ralph/state.json | cut -d'"' -f4)
STARTED=$(grep '"started_at"' .ralph/state.json | cut -d'"' -f4)
MAX_ITER=$(grep '"max_iterations"' .ralph/state.json | grep -o '[0-9]*')

echo "Status: $STATUS"
echo "Iteration: $ITERATION"
echo "Max iterations: $(if [[ $MAX_ITER -gt 0 ]]; then echo $MAX_ITER; else echo 'unlimited'; fi)"
echo "Started: $STARTED"
echo ""

# Show progress from implementation plan
if [[ -f "implementation-plan.md" ]]; then
  TOTAL_TASKS=$(grep -c '^- \[' implementation-plan.md || echo 0)
  DONE_TASKS=$(grep -c '^- \[x\]' implementation-plan.md || echo 0)

  echo "Tasks: $DONE_TASKS / $TOTAL_TASKS completed"
  echo ""

  if [[ $TOTAL_TASKS -gt 0 ]]; then
    echo "Remaining tasks:"
    grep '^- \[ \]' implementation-plan.md || echo "  (all done!)"
  fi
fi

echo ""
echo "════════════════════════════════════════════════════════════"
