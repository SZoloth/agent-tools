#!/bin/bash

# Ralph Loop Stop
# Gracefully stops a running Ralph loop

set -euo pipefail

if [[ ! -f ".ralph/state.json" ]]; then
  echo "❌ No Ralph loop running in this directory"
  exit 1
fi

echo "🛑 Stopping Ralph loop..."
touch .ralph-stop

echo ""
echo "   Stop signal sent. Ralph will finish current iteration and exit."
echo "   Monitor: tail -f .ralph-loop.log"
echo ""
