#!/bin/bash

# Ralph Loop Initialization
# Creates spec.md and implementation-plan.md through bidirectional prompting

set -euo pipefail

# Check if in project directory
if [[ -f "spec.md" ]] || [[ -f "implementation-plan.md" ]]; then
  echo "❌ Error: spec.md or implementation-plan.md already exists"
  echo ""
  echo "   Remove them first or use a different directory"
  exit 1
fi

# Get initial prompt from user
if [[ -z "${1:-}" ]]; then
  echo "❌ Error: No project description provided"
  echo ""
  echo "   Usage: ralph-init.sh 'Build a REST API for todos'"
  echo ""
  exit 1
fi

PROJECT_DESC="$*"

echo "🚀 Initializing Ralph loop for: $PROJECT_DESC"
echo ""
echo "   This will create:"
echo "   • spec.md - What the system does"
echo "   • implementation-plan.md - Task checklist"
echo "   • prompt.md - Per-iteration instructions"
echo ""
echo "   Starting bidirectional planning with Claude..."
echo ""

# Create planning prompt
cat > .ralph-planning-prompt.tmp <<EOF
I need to create a project with this goal:

$PROJECT_DESC

Please help me plan this using bidirectional prompting:
1. Ask me clarifying questions to understand implicit assumptions
2. Once we're aligned, create TWO files:

   spec.md:
   - Clear, concise specification of what the system does
   - Keep it as brief as possible while being complete
   - This is the source of truth for behavior

   implementation-plan.md:
   - Checklist of tasks with [ ] checkboxes
   - Each task should be completable in < 100k tokens
   - Ordered by priority/dependencies
   - Format: "- [ ] Task description"

CRITICAL: Keep both files as small as possible. The entire context (spec + plan + repo info) must stay under 100k tokens per iteration.

After creating the files, ask me to review and sign off on EVERY line.
EOF

# Run interactive planning session
claude .ralph-planning-prompt.tmp

# Clean up
rm .ralph-planning-prompt.tmp

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Next Steps:"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "1. Review spec.md and implementation-plan.md thoroughly"
echo "2. Sign off on every single line (edit if needed)"
echo "3. Create prompt.md with repo-specific context"
echo "4. Run: ralph-run.sh"
echo ""
echo "Example prompt.md template:"
echo ""
cat <<'TEMPLATE'
Study spec.md thoroughly.
Study implementation-plan.md thoroughly.

Repository structure:
- src/ - Source code
- tests/ - Test files
- package.json - Dependencies

Conventions:
- Use TypeScript strict mode
- Write tests in Jest
- Follow conventional commits

Pick the highest leverage unchecked task from implementation-plan.md.
Complete the task.
Write an unbiased unit test to verify correctness.
Update implementation-plan.md to check off the task: - [x]

If all tasks are complete, output: <complete>ALL_TASKS_DONE</complete>
TEMPLATE
echo ""
echo "════════════════════════════════════════════════════════════"
