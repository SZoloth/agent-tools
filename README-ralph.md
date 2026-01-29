# Ralph Wiggum Loop - CLI Implementation

Proper Ralph loop implementation using fresh Claude instances per iteration (no context rot).

## Installation

The scripts are installed in `~/agent-tools/` and added to your PATH.

**For new terminal sessions:** Commands work directly (`ralph-init.sh`)

**For current session:** Use full paths (`~/agent-tools/ralph-init.sh`) or run:
```bash
source ~/.zshrc
```

## Quick Start

```bash
# 1. Initialize a new project
cd my-project/
~/agent-tools/ralph-init.sh "Build a REST API for todos"

# 2. Review and edit the generated files
vim spec.md                    # Sign off on every line
vim implementation-plan.md     # Sign off on every line

# 3. Create prompt.md from template
cp ~/agent-tools/ralph-prompt-template.md prompt.md
vim prompt.md                  # Add repo-specific context

# 4. Run the loop
~/agent-tools/ralph-run.sh                   # Run until complete
~/agent-tools/ralph-run.sh --watch           # Pause between iterations
~/agent-tools/ralph-run.sh --max-iterations 10  # Limit iterations
```

## How It Works

Each iteration:
1. Fresh `claude -p` instance (no context from previous iterations)
2. Reads spec.md + implementation-plan.md (source of truth)
3. Reads prompt.md (repo context + instructions)
4. Picks highest leverage task
5. Implements + tests
6. Updates implementation-plan.md with `[x]`
7. Exits

**Key advantage:** Stays below 100k token "dumb zone" by treating spec/plan as source of truth instead of accumulated context.

## Commands

```bash
ralph-init.sh "description"    # Initialize project with planning
ralph-run.sh [options]         # Run the loop
ralph-stop.sh                  # Stop running loop (graceful)
ralph-status.sh                # Check progress
```

## Required Files

**spec.md**
- What the system does
- Keep as brief as possible
- Source of truth for behavior

**implementation-plan.md**
- Task checklist with `[ ]` boxes
- Each task < 100k tokens to implement
- Format: `- [ ] Task description`

**prompt.md**
- Instructions to study spec + plan
- Repo structure and conventions
- Task completion process
- Completion signal

## Use Cases

### 1. Full Implementation
When you have a bulletproof spec:
```bash
ralph-init.sh "Build authentication system"
# Review files thoroughly
ralph-run.sh
```

### 2. Exploration Mode
Brain dump before sleep, wake up to progress:
```bash
ralph-init.sh "Spike: Redis caching layer"
# Quick review, don't sweat perfection
ralph-run.sh --max-iterations 5
```

### 3. Brute Force Testing
Test every attack vector overnight:
```bash
ralph-init.sh "Test all security vulnerabilities"
# Edit plan to list attack vectors
ralph-run.sh
```

## Monitoring

```bash
# Watch live
tail -f .ralph-loop.log

# Check status
ralph-status.sh

# Stop gracefully
ralph-stop.sh

# Force stop
touch .ralph-stop
```

## vs. Anthropic Plugin

| Anthropic Plugin | This Implementation |
|-----------------|---------------------|
| Same session | Fresh claude -p per iteration |
| Context accumulates | Context resets each time |
| Hits dumb zone | Stays under 100k tokens |
| Context rot | No compaction needed |
| Quality degrades | Consistent quality |

## Critical Success Factors

1. **Bulletproof planning** - Invest heavily in spec/plan creation
2. **Watch initially** - Verify Ralph stays on track before going autonomous
3. **Keep specs small** - Entire context must be < 100k tokens
4. **Sign off on everything** - Read every line of spec + plan
5. **Test thoroughly** - Run all tests when Ralph finishes

## Example Workflow

```bash
# 1. Init
cd ~/my-new-api
ralph-init.sh "Build REST API for task management with auth"

# Claude will ask clarifying questions...
# Review generated spec.md and implementation-plan.md

# 2. Customize prompt
cp ~/agent-tools/ralph-prompt-template.md prompt.md
vim prompt.md  # Add: Node.js, Express, PostgreSQL, etc.

# 3. Watch first few iterations
ralph-run.sh --watch

# After 2-3 iterations look good, Ctrl+C and restart without watch
ralph-run.sh

# 4. Verify
npm test
git diff
cat .ralph-loop.log

# 5. Iterate
vim spec.md  # Add new requirements
ralph-run.sh  # Continue
```

## Tips

- **Start small** - Test Ralph on a small feature first
- **Use exploration mode liberally** - Great for back burner projects
- **Max iterations before bed** - `--max-iterations 10` overnight
- **Check logs** - `.ralph-loop.log` shows what happened
- **Git commit before Ralph** - Easy to see what changed
- **Sandbox for testing** - Create test projects to learn Ralph behavior

## Troubleshooting

**Ralph goes off track:**
- Stop → edit spec.md → restart
- Add more detail to prompt.md about conventions
- Break tasks smaller in implementation-plan.md

**Tests keep failing:**
- Review task granularity - too big?
- Check spec clarity - ambiguous?
- Add testing examples to prompt.md

**Context overflow:**
- Spec + plan too big, trim them
- Remove unnecessary repo context from prompt.md
- Break into multiple Ralph runs

**Ralph loops infinitely:**
- Check implementation-plan.md has checkboxes
- Ensure prompt.md has completion signal
- Use --max-iterations as safety net
