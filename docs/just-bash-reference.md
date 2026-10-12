# just-bash — Virtual Bash for AI Agents

GitHub: [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)

## What it is

TypeScript virtual bash environment with in-memory filesystem. Sandboxed execution — no real disk/network access unless opted in. Built for AI agents.

## Why it matters for agent-tools

- **Sandboxed bash as a tool** — give any agent bash without real filesystem access
- **bash-tool** — drop-in AI SDK tool, one import
- **Deterministic testing** — seed filesystem with fixtures, assert on stdout/stderr/exitCode
- **Custom commands** — extend with TypeScript via `defineCommand`, works with pipes and redirections
- **AST transforms** — instrument scripts before execution (capture per-command output, collect metadata)

## AI SDK integration

```bash
pnpm add bash-tool
```

```typescript
import { createBashTool } from "bash-tool";
import { generateText } from "ai";

const bashTool = createBashTool({
  files: { "/data/users.json": '[{"name": "Alice"}]' },
});

const result = await generateText({
  model: "anthropic/claude-sonnet-4",
  tools: { bash: bashTool },
  prompt: "Count the users in /data/users.json",
});
```

## Custom commands

```typescript
import { Bash, defineCommand } from "just-bash";

const search = defineCommand("search-kb", async (args, ctx) => {
  const query = args.join(" ");
  const results = await searchKnowledgeBase(query);
  return { stdout: JSON.stringify(results), stderr: "", exitCode: 0 };
});

const bash = new Bash({ customCommands: [search] });
await bash.exec('search-kb "retrieval patterns" | jq .results');
```

## Filesystem options

| Type | Use case |
|------|----------|
| `InMemoryFs` | Pure sandbox, no disk (default) |
| `OverlayFs` | COW over real directory — reads from disk, writes in memory |
| `ReadWriteFs` | Real disk access (use with caution) |
| `MountableFs` | Multi-mount: combine read-only + writable at different paths |
