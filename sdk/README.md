# @ai-is-gonna/gtd-sdk

TypeScript SDK for **Get Tasks Done**: deterministic query/mutation handlers, plan execution, and event-stream telemetry so agents focus on judgment, not shell plumbing.

## Install

```bash
npm install @ai-is-gonna/gtd-sdk
```

## Quickstart — programmatic

```typescript
import { GTD, createRegistry } from '@ai-is-gonna/gtd-sdk';

const gtd = new GTD({ projectDir: process.cwd(), sessionId: 'my-run' });
const tools = gtd.createTools();

const registry = createRegistry(gtd.eventStream, 'my-run');
const { data } = await registry.dispatch('state.json', [], process.cwd());
```

## Quickstart — CLI

From a project that depends on this package, **invoke the CLI with Node** (recommended in CI and local dev):

```bash
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query state.json
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query roadmap.analyze
```

If no native handler is registered for a command, the CLI can transparently shell out to `get-tasks-done/bin/gtd-tools.cjs` (see stderr warning), unless `GTD_QUERY_FALLBACK=off`.

## Task Workflow Commands

The SDK exposes the GitHub-backed task workflow as query commands so CI jobs and dashboards can inspect or advance the same workflow used by the slash commands:

```bash
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query export-phase-issues 1 --dry-run
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query export-phase-issues 1
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query work-task-issue --read-only --phase 1
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query work-task-issue --phase 1
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query orchestrate-tasks 123 124 --dry-run
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query work-task-issue --complete-phase 1 --execute
```

Useful gates around that workflow:

```bash
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query check.completion phase 1
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query check.verification-status 1
node ./node_modules/@ai-is-gonna/gtd-sdk/dist/cli.js query progress.json
```

## What ships

| Area | Entry |
|------|--------|
| Query registry | `createRegistry()` in `src/query/index.ts` — same handlers as `gtd-sdk query` |
| Tools bridge | `GTDTools` — native dispatch with optional CJS subprocess fallback |
| Orchestrators | `PhaseRunner`, `InitRunner`, `GTD` |
| CLI | `gtd-sdk` — `query`, `run`, `init`, `auto` |

## Guides

- **Handler registry & contracts:** [`src/query/QUERY-HANDLERS.md`](src/query/QUERY-HANDLERS.md)
- **Repository docs** (when present): `docs/ARCHITECTURE.md`, `docs/CLI-TOOLS.md` at repo root

## Environment

| Variable | Purpose |
|----------|---------|
| `GTD_QUERY_FALLBACK` | `off` / `never` disables CLI fallback to `gtd-tools.cjs` for unknown commands |
| `GTD_AGENTS_DIR` | Override directory scanned for installed GTD agents (`~/.claude/agents` by default) |
