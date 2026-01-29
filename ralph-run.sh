#!/bin/bash

# Ralph Loop Runner
# Executes fresh Claude instances per iteration using spec + plan

set -euo pipefail

# Validate required files exist
if [[ ! -f "spec.md" ]]; then
  echo "❌ Error: spec.md not found"
  echo "   Run ralph-init.sh first"
  exit 1
fi

if [[ ! -f "implementation-plan.md" ]]; then
  echo "❌ Error: implementation-plan.md not found"
  echo "   Run ralph-init.sh first"
  exit 1
fi

if [[ ! -f "prompt.md" ]]; then
  echo "❌ Error: prompt.md not found"
  echo ""
  echo "   Create prompt.md with:"
  echo "   - Instructions to study spec.md and implementation-plan.md"
  echo "   - Repository-specific context (structure, conventions)"
  echo "   - Task completion instructions"
  echo ""
  exit 1
fi

# Parse arguments
MAX_ITERATIONS=0
WATCH_MODE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --max-iterations)
      MAX_ITERATIONS="${2:-}"
      shift 2
      ;;
    --watch)
      WATCH_MODE=true
      shift
      ;;
    -h|--help)
      cat << 'HELP'
Ralph Loop Runner - Autonomous coding with fresh contexts

USAGE:
  ralph-run.sh [OPTIONS]

OPTIONS:
  --max-iterations N    Stop after N iterations (default: unlimited)
  --watch              Watch intently, pause between iterations
  -h, --help           Show this help

REQUIRED FILES:
  spec.md                 - System specification (source of truth)
  implementation-plan.md  - Task checklist with [ ] boxes
  prompt.md              - Per-iteration instructions + repo context

STOPPING:
  • Create .ralph-stop file: touch .ralph-stop
  • Ctrl+C (manual interrupt)
  • Max iterations reached
  • Claude outputs <complete>...</complete>

MONITORING:
  tail -f .ralph-loop.log    # Watch progress
  ralph-status.sh            # Check current state

EXAMPLES:
  ralph-run.sh                              # Run until complete
  ralph-run.sh --max-iterations 10          # Run max 10 iterations
  ralph-run.sh --watch                      # Pause between iterations
HELP
      exit 0
      ;;
    *)
      echo "❌ Unknown option: $1"
      echo "   Use -h for help"
      exit 1
      ;;
  esac
done

# Initialize state
mkdir -p .ralph
ITERATION=1
START_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LOG_FILE=".ralph-loop.log"

# Clean up old state
rm -f .ralph-stop
rm -f "$LOG_FILE"

# Create state file
cat > .ralph/state.json <<EOF
{
  "iteration": $ITERATION,
  "max_iterations": $MAX_ITERATIONS,
  "started_at": "$START_TIME",
  "status": "running"
}
EOF

echo "🔄 Starting Ralph loop"
echo ""
echo "   Max iterations: $(if [[ $MAX_ITERATIONS -gt 0 ]]; then echo $MAX_ITERATIONS; else echo 'unlimited'; fi)"
echo "   Watch mode: $WATCH_MODE"
echo "   Log: $LOG_FILE"
echo ""
echo "   To stop: touch .ralph-stop"
echo ""
echo "════════════════════════════════════════════════════════════"

# Main loop
while true; do
  # Check stop conditions
  if [[ -f .ralph-stop ]]; then
    echo ""
    echo "🛑 Stop file detected - halting loop"
    break
  fi

  if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -gt $MAX_ITERATIONS ]]; then
    echo ""
    echo "🛑 Max iterations ($MAX_ITERATIONS) reached"
    break
  fi

  echo "" | tee -a "$LOG_FILE"
  echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
  echo "Iteration $ITERATION - $(date '+%Y-%m-%d %H:%M:%S')" | tee -a "$LOG_FILE"
  echo "═══════════════════════════════════════════════════════════" | tee -a "$LOG_FILE"
  echo "" | tee -a "$LOG_FILE"

  # Update state
  cat > .ralph/state.json <<EOF
{
  "iteration": $ITERATION,
  "max_iterations": $MAX_ITERATIONS,
  "started_at": "$START_TIME",
  "status": "running",
  "last_iteration_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

  # Run Claude in headless mode with fresh context
  OUTPUT=$(claude -p "$(cat prompt.md)" 2>&1 || true)

  # Log output
  echo "$OUTPUT" | tee -a "$LOG_FILE"

  # Check for completion signal
  if echo "$OUTPUT" | grep -q '<complete>'; then
    echo "" | tee -a "$LOG_FILE"
    echo "✅ Ralph detected completion signal" | tee -a "$LOG_FILE"
    echo "" | tee -a "$LOG_FILE"

    # Extract completion message
    COMPLETION_MSG=$(echo "$OUTPUT" | grep -o '<complete>.*</complete>' | sed 's/<complete>//; s/<\/complete>//')
    echo "   Completion: $COMPLETION_MSG" | tee -a "$LOG_FILE"
    break
  fi

  # Watch mode - pause between iterations
  if [[ "$WATCH_MODE" == "true" ]]; then
    echo ""
    echo "⏸️  Press Enter to continue, or Ctrl+C to stop..."
    read -r
  fi

  ITERATION=$((ITERATION + 1))
done

# Final state
cat > .ralph/state.json <<EOF
{
  "iteration": $ITERATION,
  "max_iterations": $MAX_ITERATIONS,
  "started_at": "$START_TIME",
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "complete"
}
EOF

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Ralph loop completed after $ITERATION iteration(s)"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  • Run all tests: npm test / pytest / etc"
echo "  • Review changes: git diff"
echo "  • Check logs: cat $LOG_FILE"
echo ""
