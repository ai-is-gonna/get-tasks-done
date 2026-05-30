# Project Context

This file records the small set of repository-level terms and guardrails that contributors should share.

## Domain Terms

### Get Tasks Done

The project workflow that plans work as phases, exports executable tasks to GitHub issues, and executes each task through task-scoped branches and pull requests.

### Task Issue

A GitHub issue generated from one planned task. It carries the task ID, source scope, acceptance criteria, validation expectations, and task state.

### Task PR

The pull request produced for one task issue. It is the default review unit.

### Reconciliation

The post-task step that turns merged task work back into canonical phase summary artifacts before phase verification.

### SDK Package

The TypeScript package published as `@ai-is-gonna/gtd-sdk`. It exposes programmatic GTD query and execution helpers and backs the `gtd-sdk` binary.

## Contributor Guardrails

- Keep public docs aligned with the current task-issue execution model.
- Keep root `README.md` changes separate when explicitly requested.
- Use `node:test` and `node:assert/strict` in repository tests.
- Avoid committing runtime planning state, credentials, logs, local config, or generated build output.
- Prefer small pull requests with clear test notes.
