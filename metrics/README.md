# Personal Metrics & Instrumentation

Track impact, outcomes, and productivity across all dimensions.

## Quick Start

```bash
# See your overall health score
impact-dashboard.js

# Quick view (just the numbers)
impact-dashboard.js --quick

# Export snapshot for tracking over time
impact-dashboard.js --export
```

## Individual Tools

### Claude Code Analyzer
Understand how you use Claude quantitatively and qualitatively.

```bash
claude-analyzer.js                  # Last 30 days
claude-analyzer.js --days 7         # Last week
claude-analyzer.js --verbose        # Include high-value session details
claude-analyzer.js --export         # Save to metrics store
```

**Metrics tracked:**
- Sessions per day
- Task type breakdown (coding, writing, research, planning, etc.)
- Projects worked on
- Quality score (depth of sessions)
- Files modified

### Weekly Outcomes
Measure shipped work vs busywork from Things 3.

```bash
weekly-outcomes.js                  # This week
weekly-outcomes.js --weeks 4        # Last month
weekly-outcomes.js --export         # Save to metrics store
```

**Key insight:** Uses Things tags to categorize:
- `Shipped` - Deliverables, completed work
- `Needle-mover` - High-impact activities
- `Admin` - Maintenance tasks

**Target:** 60%+ outcome work, <40% maintenance

### Outreach Tracker
Track job search outreach and pipeline.

```bash
# Log an outreach
outreach-tracker.js log "Stripe" "Matt Ziegler" "linkedin"

# Check status
outreach-tracker.js status

# Log a response
outreach-tracker.js response "Stripe" "replied"

# See history
outreach-tracker.js history
```

**Syncs to:** `~/clawd/outreach/pipeline.md`

**Weekly target:** 10 outreaches

### Work Deliverables
Track shipped work for portfolio evidence.

```bash
# Log a deliverable
work-deliverables.js log "Cart UX Research" "DWA-Lasso" "Charles" "research"

# List all
work-deliverables.js list

# Filter by project
work-deliverables.js list --project "DWA"

# Export to markdown
work-deliverables.js export
```

**Types:** research, strategy, design, prototype, presentation, spec, process, workshop

## Data Storage

```
~/agent-tools/metrics/data/
├── metrics-store.json      # Aggregated metrics
├── outreach-log.json       # Outreach tracking
├── deliverables.json       # Work deliverables
```

## Tags to Use in Things 3

When completing tasks, add these tags for better categorization:

| Tag | Use When |
|-----|----------|
| `Shipped` | Completed a deliverable, shipped something |
| `Needle-mover` | High-impact work (job search, key decisions) |
| `Admin` | Maintenance, chores, logistics |
| `P1` | Highest priority items |

## Recommended Workflow

### Daily
1. Morning: `impact-dashboard.js --quick` to see where you are
2. Tag tasks appropriately when completing

### Weekly
1. `weekly-outcomes.js --weeks 1` to review the week
2. `outreach-tracker.js history` to check outreach progress
3. `impact-dashboard.js --export` to save a snapshot

### Monthly
1. `claude-analyzer.js --days 30 --verbose` for usage patterns
2. `work-deliverables.js export` to update portfolio evidence
3. Review snapshots in `~/Documents/LLM CONTEXT/1 - personal/metrics-snapshots/`

## Health Score Breakdown

The dashboard calculates a health score (0-100) based on:

| Component | Points | Criteria |
|-----------|--------|----------|
| Outreach | 30 | 3 points per outreach (target: 10/week) |
| Tasks | 20 | 1 point per task completed |
| Claude sessions | 10 | Active usage indicator |
| Deliverables | 20 | 5 points per deliverable this month |
| Pipeline | 20 | 10 points per interview, 2 per pending |

**Target:** 70%+ indicates healthy balance of shipping and searching.
