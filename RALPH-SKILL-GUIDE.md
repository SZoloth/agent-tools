# Ralph Loop Skill - Quick Guide

The ralph-loop skill is now installed and will activate automatically when you mention Ralph loops or autonomous coding.

## Skill Location

```
~/.claude/skills/ralph-loop/
├── SKILL.md (13k - main skill instructions)
└── references/
    ├── README-ralph.md
    ├── ralph-prompt-template.md
    ├── example-spec-good.md
    ├── example-spec-bad.md
    ├── example-implementation-plan-good.md
    └── example-implementation-plan-bad.md
```

## Trigger Phrases

The skill activates when you say:
- "use ralph" or "ralph loop"
- "autonomous coding"
- "implement this overnight"
- "build X with ralph"
- "help me create a spec for ralph"
- "review this spec before I run ralph"

## What the Skill Does

The skill guides you through three workflows:

### 1. Full Implementation
- Helps with bidirectional planning
- Creates spec.md and implementation-plan.md
- Guides through the full autonomous execution process
- Reviews and validates specs before running

### 2. Spec Creation & Review
- Asks clarifying questions to surface assumptions
- Creates bulletproof specs with explicit decisions
- Reviews existing specs for common pitfalls
- Ensures proper task sizing and dependency ordering

### 3. Exploration Mode
- Quick setup for low-stakes prototyping
- Perfect for using expiring tokens
- Rough prototypes for learning

## Example Usage

**Simple trigger:**
```
You: "Use ralph to build a REST API for task management"
```

Claude will:
1. Activate the ralph-loop skill
2. Ask clarifying questions (entities, endpoints, tech stack)
3. Run ralph-init.sh to create spec and plan
4. Guide you through review and execution
5. Help with monitoring and verification

**Spec review:**
```
You: "Review this spec before I run ralph"
[paste spec.md content]
```

Claude will check for:
- Ambiguity and vague terms
- Missing technical decisions
- Improper task sizing
- Dependency ordering issues

## Skill vs CLI Tools

**CLI Tools** (`~/agent-tools/ralph-*.sh`):
- The actual implementation
- Runs the loops
- Used by you or Claude via Bash

**Skill** (`~/.claude/skills/ralph-loop/`):
- Guides the workflow
- Helps with planning
- Teaches best practices
- References the CLI tools

The skill is the "orchestrator" that knows when and how to use the CLI tools.

## Behind the Scenes

When you trigger the skill, Claude loads:
1. SKILL.md - Core workflow instructions
2. Relevant references (as needed):
   - Example specs (good/bad)
   - Example plans (good/bad)
   - README with full CLI documentation
   - Prompt template

This gives Claude the expertise to guide you through Ralph loops properly.

## Packaged Version

A packaged version is available at:
```
~/Downloads/ralph-loop.zip
```

You can share this with others or import it into different Claude Code installations.

## Next Steps

Try it out with:
```
"Hey, I want to use ralph to build a simple todo API overnight. Can you help me set it up?"
```

Claude will activate the skill and guide you through the entire process.
