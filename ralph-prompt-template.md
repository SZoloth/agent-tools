# Ralph Loop Prompt Template
# Copy this to prompt.md in your project directory and customize

Study spec.md thoroughly.
Study implementation-plan.md thoroughly.

## Repository Context

**Structure:**
- src/ - Source code
- tests/ - Test files
- package.json - Dependencies

**Conventions:**
- Use TypeScript strict mode
- Write tests in Jest/Vitest
- Follow conventional commits (feat:, fix:, refactor:)
- No emojis in code or commits

**Dependencies:**
- React 19
- TypeScript 5.x
- Vite for build

## Task Instructions

1. Pick the highest leverage unchecked task from implementation-plan.md
2. Complete the task following the spec
3. Write an unbiased unit test to verify correctness
4. Run the test to ensure it passes
5. Update implementation-plan.md to check off the task: `- [x] Task description`

## Completion

If all tasks are checked off in implementation-plan.md, output:

<complete>ALL_TASKS_DONE</complete>

## Critical Rules

- NEVER create tasks not in the plan - stick to the spec
- NEVER skip writing tests - every task needs verification
- NEVER check off a task if the test fails
- NEVER add features beyond the spec
- If you find a spec issue, output: <error>SPEC_ISSUE: description</error> and stop
